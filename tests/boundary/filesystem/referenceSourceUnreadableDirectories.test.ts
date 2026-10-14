import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  importReferenceSource,
  readReferenceSource,
} from "../../support/referenceSourceResourceScope.js";

const importTree = (root: string) =>
  importReferenceSource({
    root,
    caller: "native-unreadable-directory-test",
    policy: { secretPatterns: [] },
  });

const permissionChecksUnavailable =
  process.platform === "win32" || process.getuid?.() === 0;

describe("reference source native unreadable directories", () => {
  it.skipIf(permissionChecksUnavailable).each(["blocked", "src/blocked"])(
    "preserves a partial graph when %s cannot be enumerated",
    async (blocked) => {
      const root = await createTestTempDirectory("rea-source-unreadable-dir-");
      const deniedPath = join(root, blocked);
      await mkdir(deniedPath, { recursive: true });
      await writeFile(join(root, "main.ts"), "export const value = 1;\n");
      await chmod(deniedPath, 0);
      try {
        const read = await readReferenceSource(root);
        if (!read.ok) throw new Error(read.error.message);
        const directory = read.value.entries.filter(
          ({ path }) => path === blocked,
        );
        expect(directory).toHaveLength(1);
        expect(directory[0]).toMatchObject({
          status: "failed",
          kind: "directory",
          code: "io",
          message: expect.stringContaining("EACCES"),
        });
        const imported = await importTree(root);
        if (!imported.ok) throw new Error(imported.error.message);
        expect(imported.value.inventory_state).toBe("partial");
        expect(
          imported.value.entries.filter(({ path }) => path === blocked),
        ).toEqual([
          expect.objectContaining({
            kind: "directory",
            tree_state: "unreadable",
            limitations: [expect.any(String)],
          }),
        ]);
        expect(
          imported.value.entries.find(({ path }) => path === "main.ts"),
        ).toMatchObject({ content_state: "hashed" });
      } finally {
        await chmod(deniedPath, 0o700);
      }
    },
  );

  it.skipIf(permissionChecksUnavailable)(
    "keeps a partial graph when a symlink targets a search-only directory",
    async () => {
      const root = await createTestTempDirectory("rea-source-search-only-dir-");
      const searchOnly = join(root, "blocked");
      await mkdir(searchOnly);
      await writeFile(join(searchOnly, "file.js"), "export {};\n");
      await symlink("blocked/file.js", join(root, "link.js"));
      await chmod(searchOnly, 0o311);
      try {
        const imported = await importTree(root);
        if (!imported.ok) throw new Error(imported.error.message);
        expect(imported.value.inventory_state).toBe("partial");
        expect(
          imported.value.entries.find(({ path }) => path === "blocked"),
        ).toMatchObject({ kind: "directory", tree_state: "unreadable" });
        expect(
          imported.value.entries.find(({ path }) => path === "link.js"),
        ).toMatchObject({
          kind: "symlink",
          target: "blocked/file.js",
          target_state: "internal",
        });
      } finally {
        await chmod(searchOnly, 0o700);
      }
    },
  );

  it("keeps readable and empty directories enumerated exactly once", async () => {
    const root = await createTestTempDirectory("rea-source-readable-dirs-");
    await mkdir(join(root, "src", "empty"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "export const value = 1;\n");
    const imported = await importTree(root);
    if (!imported.ok) throw new Error(imported.error.message);
    for (const path of ["src", "src/empty"]) {
      expect(
        imported.value.entries.filter((entry) => entry.path === path),
      ).toEqual([
        expect.objectContaining({
          kind: "directory",
          tree_state: "enumerated",
          limitations: [],
        }),
      ]);
    }
  });
});
