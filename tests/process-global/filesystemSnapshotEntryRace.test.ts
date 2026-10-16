import type { Dirent } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({
  linkPath: "",
  directoryPath: "",
  directoryReads: 0,
  iterationPath: "",
}));

// Real filesystem IO, except for failures that only occur when an entry changes
// between the snapshot's own metadata read and its follow-up call.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      const directory = await original.opendir(...args);
      if (args[0] === injected.iterationPath) {
        const iterator = directory[Symbol.asyncIterator]();
        directory[Symbol.asyncIterator] = async function* (): AsyncGenerator<
          Dirent,
          undefined
        > {
          for await (const entry of iterator) {
            yield entry;
            throw Object.assign(
              new Error("directory disappeared during iteration"),
              { code: "ENOENT" },
            );
          }
        };
      }
      return directory;
    },
    readlink: async (...args: Parameters<typeof original.readlink>) => {
      if (args[0] === injected.linkPath)
        throw Object.assign(new Error("not a symbolic link"), {
          code: "EINVAL",
        });
      return original.readlink(...args);
    },
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      // A root directory is inspected for presence, as an entry, then again
      // after its names are read; the third inspection finds it removed.
      if (args[0] === injected.directoryPath && ++injected.directoryReads === 3)
        throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      return original.lstat(...args);
    },
  };
});

import { parseProcessScenario } from "../../src/domain/process/processScenario.js";
import { snapshotRoots } from "../../src/process/capture/FilesystemSnapshot.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

afterEach(() => {
  injected.linkPath = "";
  injected.directoryPath = "";
  injected.directoryReads = 0;
  injected.iterationPath = "";
});

const observe = (root: string) =>
  parseProcessScenario({
    executable: process.execPath,
    working_directory: root,
    filesystem_observation_paths: [root],
  });

it("records an iteration failure and releases pending-name capacity for the next root", async () => {
  const failed = await createTestTempDirectory("rea-fs-iteration-race-");
  const next = await createTestTempDirectory("rea-fs-iteration-next-");
  await writeFile(join(failed, "lost.txt"), "lost");
  await writeFile(join(next, "known.txt"), "known");
  injected.iterationPath = failed;
  const snapshot = await snapshotRoots(
    parseProcessScenario({
      executable: process.execPath,
      working_directory: next,
      filesystem_observation_paths: [failed, next],
      limits: { files: 3 },
    }),
  );
  expect(snapshot.completeRoots).toEqual(["root_1"]);
  expect(snapshot.files.map(({ path }) => path)).toEqual([
    "root_0:.",
    "root_1:.",
    "root_1:known.txt",
  ]);
  expect(snapshot.coverage.enumeration_reasons).toEqual([
    "directory_unavailable",
  ]);
  expect(snapshot.coverage.enumeration_omissions).toEqual([
    {
      path: "root_0:.",
      reason: "directory_unavailable",
      system_code: "ENOENT",
    },
  ]);
});

it.skipIf(process.platform === "win32")(
  "marks the containing directory unknown when a symlink stops being readable",
  async () => {
    const root = await createTestTempDirectory("rea-fs-symlink-race-");
    const link = join(root, "link");
    await symlink("target", link);
    const scenario = observe(root);
    injected.linkPath = link;

    const snapshot = await snapshotRoots(scenario);

    expect(snapshot.files.map(({ path }) => path)).toEqual(["root_0:."]);
    expect(snapshot.completeRoots).toEqual([]);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.coverage.enumeration_reasons).toEqual([
      "directory_unavailable",
    ]);
    expect(snapshot.coverage.enumeration_omissions).toEqual([
      {
        path: "root_0:.",
        reason: "directory_unavailable",
        system_code: "EINVAL",
      },
    ]);
  },
);

it("marks a directory unknown when it disappears while its names are read", async () => {
  const root = await createTestTempDirectory("rea-fs-directory-race-");
  const scenario = observe(root);
  injected.directoryPath = root;

  const snapshot = await snapshotRoots(scenario);

  expect(snapshot.files.map(({ path }) => path)).toEqual(["root_0:."]);
  expect(snapshot.completeRoots).toEqual([]);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.coverage.enumeration_reasons).toEqual([
    "directory_unavailable",
  ]);
  expect(snapshot.coverage.enumeration_omissions).toEqual([
    {
      path: "root_0:.",
      reason: "directory_unavailable",
      system_code: "ENOENT",
    },
  ]);
});
