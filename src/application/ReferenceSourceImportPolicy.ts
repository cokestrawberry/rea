import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import ignore from "ignore";
import {
  readRegularFileText,
  RegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";

import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";
import { rootFilesystemFailure } from "../reference/ReferenceSourceReaderErrors.js";

/** Validated inputs ready for filesystem traversal. */
export interface PreparedReferenceSourceImport {
  readonly root: string;
  readonly ignored: ReturnType<typeof ignore>;
  readonly secrets: ReturnType<typeof ignore>;
  readonly limitations: readonly string[];
}

const IGNORE_POLICY_NOT_REGULAR_LIMITATION =
  "The root .gitignore is a symbolic link or not a regular file, so project ignore rules were not applied.";

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const addMarkedPatterns = (
  matcher: ReturnType<typeof ignore>,
  patterns: readonly string[],
  mark: "project-ignored" | "default-ignored" | "caller-excluded",
): void => {
  for (const pattern of patterns)
    for (const line of pattern.split(/\r?\n/u))
      matcher.add({ pattern: line, mark });
};

const resolveRoot = async (
  requestedRoot: string,
  signal?: AbortSignal,
): Promise<Result<string, ReferenceSourceImportError>> => {
  if (isAborted(signal))
    return err(failure("cancelled", "Reference source import cancelled"));
  try {
    const metadata = await stat(requestedRoot);
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    if (!metadata.isDirectory())
      return err(
        failure(
          "invalid-root",
          `Reference source root is not a directory: ${requestedRoot}`,
        ),
      );
    const canonicalRoot = await realpath(resolve(requestedRoot));
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    return ok(canonicalRoot);
  } catch (cause: unknown) {
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    const rootFailure = rootFilesystemFailure(
      cause,
      "Reference source root could not be resolved",
    );
    if (rootFailure === undefined) throw cause;
    return err({ ...failure(rootFailure.code, rootFailure.message), cause });
  }
};

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? cause.code
    : undefined;

// O_NOFOLLOW reports a symbolic link as ELOOP; other non-regular files fail admission.
const isNotRegularPolicy = (cause: unknown): boolean =>
  cause instanceof NonRegularFileReadError || errorCode(cause) === "ELOOP";

const readIgnorePolicy = async (
  policyPath: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<string, ReferenceSourceImportError>> => {
  try {
    return ok(
      await readRegularFileText(policyPath, { signal, symlinks: "reject" }),
    );
  } catch (cause: unknown) {
    if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
    const retry = await retryRegularFileCleanup(cause, resources);
    if (retry.cleanup !== undefined) {
      const primary =
        cause.outcome.kind === "failed"
          ? cause.outcome.cause
          : cause.cleanupCause;
      return err({
        ...failure(
          signal?.aborted === true ? "cancelled" : "io",
          `Reference source ignore policy could not be read at ${policyPath}: ${errorMessage(primary)}`,
        ),
        cleanup: retry.cleanup,
        cause: primary,
      });
    }
    if (retry.outcome.kind === "failed") throw retry.outcome.cause;
    return ok(retry.outcome.value);
  }
};

const buildIgnored = async (
  root: string,
  excludePaths: readonly string[],
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<
  Result<
    Pick<PreparedReferenceSourceImport, "ignored" | "limitations">,
    ReferenceSourceImportError
  >
> => {
  const ignored = ignore();
  const limitations: string[] = [];
  const policyPath = join(root, ".gitignore");
  try {
    const policy = await readIgnorePolicy(policyPath, resources, signal);
    if (!policy.ok) return policy;
    addMarkedPatterns(ignored, [policy.value], "project-ignored");
  } catch (cause: unknown) {
    if (isNotRegularPolicy(cause))
      limitations.push(IGNORE_POLICY_NOT_REGULAR_LIMITATION);
    else if (errorCode(cause) !== "ENOENT") throw cause;
  }
  addMarkedPatterns(
    ignored,
    DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
    "default-ignored",
  );
  for (const path of excludePaths) {
    addMarkedPatterns(ignored, [path, `${path}/`], "caller-excluded");
  }
  return ok({ ignored, limitations });
};

/** Resolve the caller-selected directory and build path filters. */
export const prepareReferenceSourceImport = async (
  options: ReferenceSourceImportOptions,
  resources: ArtifactResourceScope,
): Promise<
  Result<PreparedReferenceSourceImport, ReferenceSourceImportError>
> => {
  try {
    return await resources.run(async () => {
      const root = await resolveRoot(options.root, options.signal);
      if (!root.ok) return root;
      try {
        const ignored = await buildIgnored(
          root.value,
          options.excludePaths ?? [],
          resources,
          options.signal,
        );
        if (!ignored.ok) return ignored;
        return ok({
          root: root.value,
          ...ignored.value,
          secrets: ignore().add([...options.policy.secretPatterns]),
        });
      } catch (cause: unknown) {
        return err({
          ...failure(
            options.signal?.aborted === true ? "cancelled" : "io",
            `Reference source ignore policy could not be read at ${join(root.value, ".gitignore")}: ${errorMessage(cause)}`,
          ),
          cause,
        });
      }
    });
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    return err({
      ...failure(
        cause.reason === "cancelled" ? "cancelled" : "io",
        cause.message,
      ),
      ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
      cause,
    });
  }
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
