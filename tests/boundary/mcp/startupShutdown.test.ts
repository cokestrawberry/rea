import pino from "pino";
import { expect, it } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../src/domain/result.js";
import { openInitialTarget } from "../../../src/main/startup.js";
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
  const health = createDeferred<ReturnType<typeof observed>>();
  const started = createDeferred<void>();
  const output: string[] = [];
  const requests: Array<() => void> = [];
  const unregistrations: string[] = [];
  let providerCloses = 0;
  const session = createTestBinarySession(() => ({
    execute: () => {
      started.resolve();
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
      registerShutdown: (request) => {
        requests.push(request);
        return () => unregistrations.push("shutdown");
      },
      writeStderr: (text) => output.push(text),
    },
  );
  await started.promise;
  return {
    health,
    opening,
    output,
    requests,
    unregistrations,
    providerCloses: () => providerCloses,
  };
};

it("cancels the initial target open and closes its provider on a shutdown request", async () => {
  const startup = await openWithPendingHealth();

  expect(startup.requests).toHaveLength(1);
  startup.requests[0]?.();
  startup.health.resolve(observed(null));

  expect(await startup.opening).toEqual({ ok: false, exitCode: 1 });
  expect(startup.providerCloses()).toBe(1);
  expect(startup.output).toEqual([
    `${projectAnalysisError(new AnalysisCancelledError("open_binary")).message}\n`,
  ]);
  expect(startup.unregistrations).toEqual(["shutdown"]);
});

it("unregisters the startup shutdown handler once the initial target opens", async () => {
  const startup = await openWithPendingHealth();

  startup.health.resolve(observed(null));

  expect(await startup.opening).toEqual({ ok: true });
  expect(startup.unregistrations).toEqual(["shutdown"]);
  expect(startup.providerCloses()).toBe(0);
});
