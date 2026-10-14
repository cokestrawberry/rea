import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../../tests/support/workspace/workspaceFixture.js";
import { inspectPwndbgCore } from "../../../src/native/pwndbg/PwndbgCoreContext.js";
import type { OwnedProviderProcessSpawnOptions } from "../../../src/process/ProviderProcess.js";

const diagnostics = { stdout: "", stderr: "", truncated: false };

it.each(["pre-aborted", "aborted-during-probe"] as const)(
  "cancellation wins over debugger path failures: %s",
  async (scenario) => {
    const workspace = await createTestWorkspace("rea-pwndbg-cancel-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const controller = new AbortController();
    const gdb = join(workspace.root, "missing-gdb");
    let probes = 0;
    const probePath = async () => {
      probes++;
      if (scenario === "aborted-during-probe") {
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            controller.abort();
            resolve();
          });
        });
        throw new Error("path became unavailable");
      }
      throw new Error("path is unavailable");
    };
    if (scenario === "pre-aborted") controller.abort();
    await expect(
      inspectPwndbgCore({
        environment: {
          REA_PWNDBG_GDB: gdb,
          REA_PWNDBG_GDBINIT: join(workspace.root, "missing-init"),
          REA_PWNDBG_VENV_PATH: join(workspace.root, "missing-venv"),
        },
        rootPath: workspace.root,
        resources: new ArtifactResourceScope(),
        diagnostics,
        options: { signal: controller.signal },
        probePath,
        runCommand: () => {
          throw new Error("No process should exist before cancellation");
        },
      }),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(probes).toBe(scenario === "pre-aborted" ? 0 : 1);
    await expect(
      access(join(workspace.root, "debugger")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

// launch.py execs into GDB, so a Python command identity would make cleanup
// refuse to signal the owned process group.
it("spawns the debugger launcher without a command identity", async () => {
  const workspace = await createTestWorkspace("rea-pwndbg-launch-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const python = join(workspace.root, "python");
  const spawns: OwnedProviderProcessSpawnOptions[] = [];
  await expect(
    inspectPwndbgCore({
      environment: {
        REA_PWNDBG_GDB: join(workspace.root, "gdb"),
        REA_PWNDBG_GDBINIT: join(workspace.root, "gdbinit"),
        REA_PWNDBG_VENV_PATH: join(workspace.root, "venv"),
        REA_PWNTOOLS_PYTHON: python,
      },
      rootPath: workspace.root,
      resources: new ArtifactResourceScope(),
      diagnostics,
      options: undefined,
      probePath: async () => {},
      runCommand: async (spawn) => {
        spawns.push(spawn);
        throw new Error("launcher stopped");
      },
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(spawns).toHaveLength(1);
  expect(spawns[0]).toMatchObject({
    command: python,
    expectedCommand: null,
  });
});
