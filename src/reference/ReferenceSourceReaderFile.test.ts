import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { readFileContents } from "./ReferenceSourceReaderFile.js";

const reader = (bytes: Buffer, maximumRead = bytes.length) => {
  let position = 0;
  return {
    read(buffer: Buffer, offset: number, length: number) {
      const end = Math.min(
        bytes.length,
        position + length,
        position + maximumRead,
      );
      const bytesRead = bytes.copy(buffer, offset, position, end);
      position = end;
      return Promise.resolve({ bytesRead });
    },
  };
};

it("retains all bytes across short reads through the declared size", async () => {
  const bytes = Buffer.from("complete observation");
  const result = await readFileContents({
    handle: reader(bytes, 3),
    path: "source.txt",
    expectedSize: BigInt(bytes.length),
    retainBytes: true,
  });
  if (result.status === "failed") throw result.entry;
  expect(Buffer.concat(result.chunks, result.total)).toEqual(bytes);
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("hashes a file across multiple chunks without retaining its bytes", async () => {
  const bytes = Buffer.alloc(3 * 64 * 1024 + 17, 0x61);
  const result = await readFileContents({
    handle: reader(bytes),
    path: "asset.bin",
    expectedSize: BigInt(bytes.length),
    retainBytes: false,
  });
  if (result.status === "failed") throw result.entry;
  expect(result.chunks).toEqual([]);
  expect(result.total).toBe(bytes.length);
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
});

it("reports growth instead of continuing to consume a changed file", async () => {
  const result = await readFileContents({
    handle: reader(Buffer.from("larger than admitted")),
    path: "source.txt",
    expectedSize: 1n,
    retainBytes: false,
  });
  expect(result).toEqual({
    status: "failed",
    entry: {
      status: "failed",
      kind: "file",
      path: "source.txt",
      code: "changed",
      message: "File grew while it was read",
      size: 2,
    },
  });
});

it("preserves cancellation that arrives during a descriptor read", async () => {
  const controller = new AbortController();
  const descriptor = reader(Buffer.from("observed"));
  const result = await readFileContents({
    handle: {
      async read(buffer, offset, length) {
        const read = await descriptor.read(buffer, offset, length);
        controller.abort();
        return read;
      },
    },
    path: "source.txt",
    expectedSize: 8n,
    retainBytes: true,
    signal: controller.signal,
  });
  expect(result).toMatchObject({
    status: "failed",
    entry: { code: "cancelled", path: "source.txt" },
  });
});
