import type { BinarySession } from "../application/binary/BinarySession.js";
import type { AppConfig } from "../config/types.js";
import type { Logger } from "pino";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { RuntimeDependencies } from "./types.js";

export const openInitialTarget = async (
  session: BinarySession,
  config: AppConfig,
  serverLogger: Logger,
  dependencies: Pick<RuntimeDependencies, "registerShutdown" | "writeStderr">,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly exitCode: 1 }
> => {
  if (config.hopperTargetPath === undefined) return { ok: true };
  // Without a handler, a signal during a slow open kills the process before
  // the provider process and runtime root are cleaned up.
  const cancelOpen = new AbortController();
  const unregisterShutdown = dependencies.registerShutdown(() =>
    cancelOpen.abort(),
  );
  const opened = await session.open(config.hopperTargetPath, {
    targetKind: config.hopperTargetKind,
    signal: cancelOpen.signal,
  });
  unregisterShutdown();
  if (opened.ok) return { ok: true };
  const closed = await session.close();
  serverLogger.error(
    {
      error: projectAnalysisError(opened.error),
      ...(closed.ok
        ? {}
        : { cleanup_error: projectAnalysisError(closed.error) }),
    },
    "Initial target failed to open",
  );
  dependencies.writeStderr(`${projectAnalysisError(opened.error).message}\n`);
  if (!closed.ok)
    dependencies.writeStderr(`${projectAnalysisError(closed.error).message}\n`);
  return { ok: false, exitCode: 1 };
};
