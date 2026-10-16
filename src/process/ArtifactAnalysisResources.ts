import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
  type AnalysisPartialObservation,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import {
  readLinuxResourceLimits,
  type LinuxResourceLimits,
} from "./LinuxResourceLimits.js";
import type { PrivateRuntimeRoot } from "./PrivateRuntimeRoot.js";
import type { ProviderProcessSupervisor } from "./ProviderProcess.js";
import { OwnedCommandFailure, ownedCommandResources } from "./OwnedCommand.js";

export type ArtifactAnalysisRuntime = Pick<
  PrivateRuntimeRoot,
  "path" | "close"
>;

/** Own admission, artifact descriptors, producer cleanup and private workspaces together. */
export class ArtifactAnalysisResources {
  readonly #artifacts: {
    readonly scope: ArtifactResourceScope;
    operation: string;
  };
  readonly #cleanupFailures = new Map<
    AnalysisError,
    {
      readonly roots: Set<ArtifactAnalysisRuntime>;
      readonly primaryFailure: AnalysisError | undefined;
      readonly scopeOwner: boolean;
    }
  >();
  #tail: Promise<void> = Promise.resolve();
  #busy = false;
  #closed = false;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly readArtifact: typeof readStableArtifact,
    readonly readKernelLimits: typeof readLinuxResourceLimits,
    readonly capacity: {
      readonly message: string;
      readonly details: Readonly<Record<string, JsonValue>>;
    },
  ) {
    this.#artifacts = { scope: new ArtifactResourceScope(), operation };
  }

  run<T>(
    work: () => Promise<Result<T, AnalysisError>>,
    signal?: AbortSignal,
    operation = this.operation,
  ): Promise<Result<T, AnalysisError>> {
    if (this.#closed || signal?.aborted)
      return Promise.resolve(err(new AnalysisCancelledError(operation)));
    if (this.#busy)
      return Promise.resolve(
        err(
          new AnalysisResourceConstraintError(
            operation,
            "capacity",
            this.capacity.message,
            this.capacity.details,
          ),
        ),
      );
    this.#busy = true;
    const running = this.#tail
      .then(() =>
        this.#artifacts.scope.run(() => {
          // Failed descriptor cleanup still belongs to the preceding request until
          // this scope has drained it and admits acquisition for the new request.
          this.#artifacts.operation = operation;
          this.#resolveCleanupFailures();
          return work();
        }),
      )
      .catch((cause: unknown) => err(this.#artifactFailure(cause)))
      .finally(() => {
        this.#busy = false;
      });
    this.#tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }

  read(path: string, maximumBytes: number, signal?: AbortSignal) {
    return this.readArtifact(
      path,
      maximumBytes,
      signal,
      undefined,
      this.#artifacts.scope,
    );
  }

  readLimits(limits: LinuxResourceLimits): Promise<LinuxResourceLimits> {
    return this.readKernelLimits(limits, this.#artifacts.scope);
  }

  retain(
    root: ArtifactAnalysisRuntime,
    owner?: ProviderProcessSupervisor,
  ): void {
    const retained = this.#pendingRoots.find(
      (resource) => resource.root === root,
    );
    if (retained !== undefined) retained.process = owner;
    else
      this.#artifacts.scope.retain({
        kind: "owned-process-root",
        resource: root.path,
        root,
        process: owner,
        providerId: this.providerId,
        operation: this.#artifacts.operation,
        resources:
          owner?.launch.ownership === undefined
            ? [root.path]
            : ownedCommandResources(owner.launch.ownership, root.path),
      });
  }

  get #pendingRoots(): readonly Extract<
    ArtifactResourceOwner,
    { kind: "owned-process-root" }
  >[] {
    return this.#artifacts.scope.pendingOwners.filter(
      (
        owner,
      ): owner is Extract<
        ArtifactResourceOwner,
        { kind: "owned-process-root" }
      > => owner.kind === "owned-process-root",
    );
  }

  get pendingPaths(): readonly string[] {
    return this.#pendingRoots.map(({ root }) => root.path);
  }

  get #pendingResources(): readonly string[] {
    return this.#pendingRoots.flatMap((owner) =>
      owner.process === undefined ? [owner.root.path] : owner.resources,
    );
  }

  async release(): Promise<void> {
    for (const owner of this.#pendingRoots) {
      if (
        this.#artifacts.scope.pendingOwners.some(
          ({ kind }) => kind !== "owned-process-root",
        )
      )
        throw new ProviderCleanupError(
          this.providerId,
          owner.process === undefined ? [owner.root.path] : owner.resources,
          {
            reason:
              "Artifact descriptors remain open; the private runtime root is retained until descriptor cleanup succeeds.",
          },
          { operation: owner.operation },
        );
      const released = await this.#artifacts.scope.release(owner);
      if (released.kind === "failed") {
        if (released.cause instanceof ProviderCleanupError)
          throw released.cause;
        throw new ProviderCleanupError(
          this.providerId,
          owner.process === undefined ? [owner.root.path] : owner.resources,
          { reason: String(released.cause) },
          { operation: owner.operation, cause: released.cause },
        );
      }
      this.#resolveCleanupFailures();
    }
  }

  cleanupFailure(
    observation: NonNullable<ArtifactReaderFailure["cleanup"]>,
    cause: unknown,
    capturedOutput?: AnalysisCapturedOutput,
    operation = this.operation,
  ): ProviderCleanupError {
    const failure = new ProviderCleanupError(
      this.providerId,
      observation.resources,
      {
        reason: observation.reason,
        ...(capturedOutput === undefined
          ? {}
          : { captured_output: { ...capturedOutput } }),
      },
      { operation, cause },
    );
    this.#trackCleanupFailure(failure, [], failure, true);
    return failure;
  }

  commandFailure(
    cause: OwnedCommandFailure,
    limits: {
      readonly command_timeout_ms: number;
      readonly output_bytes: number;
    },
    effectiveLimits: LinuxResourceLimits | undefined,
    operation = this.operation,
  ): AnalysisError {
    const capturedOutput =
      cause.snapshot === null
        ? undefined
        : {
            stdout: cause.snapshot.stdout.text,
            stderr: cause.snapshot.stderr.text,
            truncated: cause.snapshot.diagnosticTruncated ?? false,
            exit_code: cause.snapshot.exitCode ?? null,
            signal: cause.snapshot.signal ?? null,
          };
    const detail = {
      cause,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
    };
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, detail);
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(
        operation,
        limits.command_timeout_ms,
        detail,
      );
    if (cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        cause.message,
        { output_bytes: limits.output_bytes },
        detail,
      );
    if (
      cause.reason === "process" &&
      (cause.snapshot?.signal === "SIGXFSZ" ||
        cause.snapshot?.signal === "SIGXCPU")
    )
      return new AnalysisResourceConstraintError(
        operation,
        cause.snapshot.signal === "SIGXFSZ" ? "file-size" : "cpu",
        `Producer terminated with ${cause.snapshot.signal}; the signal's exact cause is not independently established.`,
        effectiveLimits === undefined ? null : { ...effectiveLimits },
        detail,
      );
    return new AnalysisOutputError(operation, cause.message, detail);
  }

  async finish<T>(
    result: Result<T, AnalysisError>,
    observation: (value: T) => AnalysisPartialObservation,
    operation = this.operation,
  ): Promise<Result<T, AnalysisError>> {
    try {
      await this.release();
      return result;
    } catch (cause: unknown) {
      const partialObservation = result.ok
        ? observation(result.value)
        : result.error.partialObservation;
      const cleanupDiagnostics =
        cause instanceof ProviderCleanupError ? cause.diagnostics : undefined;
      const cleanupFailure = new ProviderCleanupError(
        this.providerId,
        [
          ...new Set([
            ...(!result.ok && result.error.cleanupIncomplete
              ? result.error.cleanupResources
              : []),
            ...this.#pendingResources,
          ]),
        ],
        {
          ...cleanupDiagnostics,
          reason:
            cause instanceof ProviderCleanupError
              ? String(cleanupDiagnostics?.reason ?? cause.message)
              : String(cause),
          previous_error: result.ok ? null : projectAnalysisError(result.error),
        },
        {
          operation,
          cause: result.ok
            ? cause
            : new AggregateError(
                [result.error, cause],
                "Analysis failed and artifact cleanup remains incomplete.",
                { cause: result.error },
              ),
          ...(partialObservation === undefined ? {} : { partialObservation }),
        },
      );
      const primaryFailure = result.ok ? undefined : result.error;
      this.#trackCleanupFailure(
        cleanupFailure,
        this.#pendingRoots.map(({ root }) => root),
        primaryFailure?.cleanupIncomplete === true ? primaryFailure : undefined,
        false,
      );
      return err(cleanupFailure);
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    const work = this.#tail.then(() => this.#closeResources());
    this.#tail = work.catch(() => undefined);
    return work;
  }

  async #closeResources(): Promise<void> {
    let descriptorFailure: AnalysisError | undefined;
    try {
      await this.#artifacts.scope.close();
      this.#resolveCleanupFailures();
    } catch (cause: unknown) {
      descriptorFailure = this.#artifactFailure(cause);
    }
    try {
      await this.release();
    } catch (cause: unknown) {
      if (descriptorFailure !== undefined && cause instanceof AnalysisError)
        throw analysisErrorWithCleanupFailure(
          descriptorFailure,
          cause,
          this.#artifacts.operation,
        );
      throw cause;
    }
    if (descriptorFailure !== undefined) throw descriptorFailure;
  }

  #resolveCleanupFailures(): void {
    const pendingRoots = this.#pendingRoots.map(({ root }) => root);
    for (const [failure, binding] of this.#cleanupFailures) {
      if (pendingRoots.some((root) => binding.roots.has(root))) continue;
      if (binding.scopeOwner && this.#artifacts.scope.hasPending) continue;
      if (binding.scopeOwner) binding.primaryFailure?.resolveCleanup();
      if (binding.primaryFailure?.cleanupIncomplete === true) continue;
      failure.resolveCleanup();
      this.#cleanupFailures.delete(failure);
    }
  }

  #trackCleanupFailure(
    failure: AnalysisError,
    roots: readonly ArtifactAnalysisRuntime[],
    primaryFailure: AnalysisError | undefined,
    scopeOwner: boolean,
  ): void {
    this.#cleanupFailures.set(failure, {
      roots: new Set(roots),
      primaryFailure,
      scopeOwner,
    });
    this.#resolveCleanupFailures();
  }

  #artifactFailure(
    cause: unknown,
    operation = this.#artifacts.operation,
  ): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
      return this.cleanupFailure(cause.cleanup, cause, undefined, operation);
    return new ProviderAdapterError(this.providerId, operation, {
      cause,
      diagnostics: { stage: "artifact-resources", reason: String(cause) },
    });
  }
}
