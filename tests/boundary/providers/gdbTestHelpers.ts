import { expect } from "vitest";

import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

type GdbSessionStart = Awaited<ReturnType<GdbSessionManager["start"]>>;
type StartedGdbSession = Extract<GdbSessionStart, { readonly ok: true }>;

export const expectGdbSessionStarted = async (
  manager: GdbSessionManager,
  signal?: AbortSignal,
  options: Parameters<GdbSessionManager["start"]>[1] = {
    inferiorTty: "/dev/pts/42",
  },
): Promise<StartedGdbSession> => {
  const started = await manager.start(signal, options);
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return started;
};
