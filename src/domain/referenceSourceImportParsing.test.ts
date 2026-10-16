import { afterEach, expect, it, vi } from "vitest";

import { parseReferenceSourceImports } from "./referenceSourceImportParsing.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("reports a decoder string-length failure as a size failure, not invalid UTF-8", () => {
  vi.stubGlobal(
    "TextDecoder",
    class {
      decode(): never {
        throw Object.assign(
          new Error("Cannot create a string longer than 0x1fffffe8 characters"),
          { code: "ERR_STRING_TOO_LONG" },
        );
      }
    },
  );

  const parsed = parseReferenceSourceImports(
    "large.js",
    new Uint8Array([0x61]),
    "JavaScript",
  );

  expect(parsed.parse_failures).toEqual([
    {
      path: "large.js",
      parser: "source-size",
      reason:
        "Source size exceeds the parsing bounds; import targets were not parsed.",
    },
  ]);
  expect(parsed.relationships).toEqual([]);
});

it("still reports malformed bytes as invalid UTF-8", () => {
  const parsed = parseReferenceSourceImports(
    "invalid.js",
    new Uint8Array([0xff]),
    "JavaScript",
  );

  expect(parsed.parse_failures).toEqual([
    {
      path: "invalid.js",
      parser: "utf-8",
      reason:
        "Source bytes are not valid UTF-8; import targets were not parsed.",
    },
  ]);
});
