import pino from "pino";
import { expect, it } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { err, ok } from "../../../src/domain/result.js";
import { openInitialTarget } from "../../../src/main/startup.js";
import { run } from "../../../src/main.js";
import type { OptionalProviderLoadResult } from "../../../src/application/OptionalObservationProviders.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

const openWithPendingHealth = async () => {
  const [target] = await createBinarySessionTargets();
  const config = parseConfig({
    HOPPER_TARGET_PATH: target,
    HOPPER_TARGET_KIND: "database",
  });
  if (!config.ok) throw config.error;
  const health = createDeferred<
    ReturnType<typeof observed> | ReturnType<typeof err<AnalysisCancelledError>>
  >();
  const started = createDeferred<void>();
  const output: string[] = [];
  const controller = new AbortController();
  let providerCloses = 0;
  const session = createTestBinarySession(() => ({
    execute: (_operation, _parameters, options) => {
      started.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => health.resolve(err(new AnalysisCancelledError("open_binary"))),
        { once: true },
      );
      return health.promise;
    },
    close: async () => {
      providerCloses += 1;
      return ok(null);
    },
  }));
  const opening = openInitialTarget(
    session,
    config.value,
    pino({ enabled: false }),
    {
      writeStderr: (text) => output.push(text),
    },
    controller.signal,
  );
  await started.promise;
  return {
    health,
    opening,
    output,
    controller,
    providerCloses: () => providerCloses,
  };
};

it("cancels the initial target open and closes its provider on a shutdown request", async () => {
  const startup = await openWithPendingHealth();

  startup.controller.abort();

  expect(await startup.opening).toEqual({ ok: false, exitCode: 1 });
  expect(startup.providerCloses()).toBe(1);
  expect(startup.output).toEqual([
    `${projectAnalysisError(new AnalysisCancelledError("open_binary")).message}\n`,
  ]);
});

it("keeps the provider open after the initial target opens", async () => {
  const startup = await openWithPendingHealth();

  startup.health.resolve(observed(null));

  expect(await startup.opening).toEqual({ ok: true });
  expect(startup.controller.signal.aborted).toBe(false);
  expect(startup.providerCloses()).toBe(0);
});

it("hands a shutdown request during optional-provider loading to the runtime owner", async () => {
  const loading = createDeferred<void>();
  const loaded = createDeferred<OptionalProviderLoadResult>();
  const closed = createDeferred<void>();
  const requests = new Set<() => void>();
  let closes = 0;
  const starting = run({
    env: {},
    serve: () => ({
      close: async () => {
        closes += 1;
        closed.resolve();
      },
    }),
    loadOptionalProviders: () => {
      loading.resolve();
      return loaded.promise;
    },
    registerShutdown: (request) => {
      requests.add(request);
      return () => {
        requests.delete(request);
      };
    },
    writeStderr: () => {},
    setExitCode: () => {},
  });
  await loading.promise;
  expect(requests.size).toBe(1);
  requests.forEach((request) => request());
  loaded.resolve({});
  expect(await starting).toBe(0);
  await closed.promise;
  expect(closes).toBe(1);
  await expect.poll(() => requests.size).toBe(0);
});
