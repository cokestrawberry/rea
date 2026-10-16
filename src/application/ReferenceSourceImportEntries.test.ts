import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
  parseReferenceSourceEntries,
  shouldRetainReferenceSourceBytes,
} from "./ReferenceSourceImportEntries.js";
import { historicalSourceLanguages } from "../domain/referenceSourceGraph.js";
import type { ReferenceSourceRead } from "../reference/ReferenceSourceReaderTypes.js";

it("projects an unsupported non-regular entry as unknown kind instead of file", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "other",
        path: "src/pipe",
        code: "unsupported",
        message: "Entry is not a regular file",
        size: 0,
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/pipe",
    kind: "unknown",
    classifications: ["unknown"],
    limitations: [
      "Entry is not a regular file Exclude this entry or replace it with a regular file.",
    ],
  });
  expect(parsed.entries.some((entry) => entry.kind === "file")).toBe(false);
});

it("keeps a failed regular file as file kind", () => {
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "failed",
        kind: "file",
        path: "src/broken.ts",
        code: "io",
        message: "Entry could not be read",
      },
    ],
    bytesRead: 0,
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(read, new Set());
  expect(parsed.entries).toContainEqual({
    path: "src/broken.ts",
    kind: "file",
    sha256: null,
    size: null,
    language: null,
    classifications: ["source"],
    content_state: "unreadable",
    limitations: [
      "Entry could not be read This file could not be read. Check its permissions, then try again.",
    ],
  });
});

it("retains Kotlin source identity and language across the inventory projection", () => {
  const files = [
    [
      "MainActivity.kt",
      "import android.app.Activity\nclass MainActivity : Activity()\n",
      ["source"],
      "Kotlin",
    ],
    ["task.kts", 'println("hello")\n', ["source"], "Kotlin"],
    [
      "build.gradle.kts",
      'plugins { kotlin("jvm") version "2.3.0" }\n',
      ["manifest", "source"],
      "Kotlin",
    ],
    ["MainActivity.kt.backup", "backup\n", ["unknown"], null],
    ["Legacy.java", "class Legacy {}\n", ["source"], "Java"],
  ] as const;
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: files.map(([path, content]) => ({
      status: "read",
      kind: "file",
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    })),
    bytesRead: files.reduce(
      (sum, [, content]) => sum + Buffer.byteLength(content),
      0,
    ),
    limitations: [],
  };
  const parsed = parseReferenceSourceEntries(
    read,
    new Set(files.map(([path]) => path)),
  );
  for (const [path, content, classifications, language] of files)
    expect(parsed.entries).toContainEqual({
      path,
      kind: "file",
      language,
      classifications,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      content_state: "hashed",
      limitations: [],
    });
  expect(historicalSourceLanguages(parsed.entries)).toEqual(["Java", "Kotlin"]);
  expect(parsed.parseFailures).toEqual([]);
  expect(parsed.relationships).toEqual([]);
});

it("reports a parseable file whose bytes were not retained as a size failure, not invalid UTF-8", () => {
  const content = "import './dep.js';\n";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const read: ReferenceSourceRead = {
    root: "/selected/source",
    entries: [
      {
        status: "read",
        kind: "file",
        path: "main.js",
        sha256,
        size: Buffer.byteLength(content),
      },
    ],
    bytesRead: Buffer.byteLength(content),
    limitations: [],
  };

  const parsed = parseReferenceSourceEntries(read, new Set(["main.js"]));

  expect(parsed.parseFailures).toEqual([
    {
      path: "main.js",
      parser: "source-size",
      reason:
        "Source size exceeds the parsing bounds; import targets were not parsed.",
    },
  ]);
  expect(parsed.relationships).toEqual([]);
  expect(parsed.entries).toEqual([
    expect.objectContaining({
      path: "main.js",
      sha256,
      size: Buffer.byteLength(content),
      content_state: "hashed",
    }),
  ]);
});

it("retains bytes only for paths whose imports are parsed", () => {
  expect(
    ["main.js", "main.ts", "view.jsx", "view.tsx", "App.kt", "data.bin"].map(
      shouldRetainReferenceSourceBytes,
    ),
  ).toEqual([true, true, true, true, false, false]);
});
