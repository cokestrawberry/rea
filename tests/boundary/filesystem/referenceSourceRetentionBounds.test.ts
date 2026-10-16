import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { ReferenceSourceEntry } from "../../../src/reference/ReferenceSourceReaderTypes.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { readReferenceSource } from "../../support/referenceSourceResourceScope.js";

// Retention bounds derive from the V8 string limit; shrink it so tiny files reach them.
vi.mock("node:buffer", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:buffer")>();
  return {
    ...original,
    constants: { ...original.constants, MAX_STRING_LENGTH: 16 },
  };
});

const sha256 = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const readFiles = (entries: readonly ReferenceSourceEntry[]) =>
  entries.flatMap((entry) =>
    entry.status === "read" && entry.kind === "file" ? [entry] : [],
  );

it("keeps bytes only for files within the per-file retention bound", async () => {
  const root = await createTestTempDirectory("rea-reference-file-bound-");
  const within = "x".repeat(16);
  const beyond = "y".repeat(17);
  await writeFile(join(root, "within.js"), within);
  await writeFile(join(root, "beyond.js"), beyond);

  const result = await readReferenceSource(root, {
    shouldRetainBytes: () => true,
  });

  if (!result.ok) throw result.error;
  expect(result.value.entries).toEqual([
    {
      status: "read",
      kind: "file",
      path: "beyond.js",
      sha256: sha256(beyond),
      size: 17,
    },
    {
      status: "read",
      kind: "file",
      path: "within.js",
      sha256: sha256(within),
      size: 16,
      bytes: Buffer.from(within),
    },
  ]);
  expect(result.value.entries[0]).not.toHaveProperty("bytes");
  expect(result.value.bytesRead).toBe(33);
});

it("stops keeping bytes once the cumulative retention bound is reached", async () => {
  const root = await createTestTempDirectory("rea-reference-total-bound-");
  const content = "z".repeat(11);
  for (const name of ["a.js", "b.js", "c.js"])
    await writeFile(join(root, name), content);

  const result = await readReferenceSource(root, {
    shouldRetainBytes: () => true,
  });

  if (!result.ok) throw result.error;
  const files = readFiles(result.value.entries);
  expect(files).toHaveLength(3);
  expect(files.filter(({ bytes }) => bytes !== undefined)).toHaveLength(2);
  expect(files.map(({ sha256: digest }) => digest)).toEqual(
    Array.from({ length: 3 }, () => sha256(content)),
  );
  expect(result.value.bytesRead).toBe(33);
});
