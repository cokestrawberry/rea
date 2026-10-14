import type { FileHandle } from "node:fs/promises";

import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { RegularFileChangedError } from "../filesystem/RegularFile.js";

/** Positional access to one private snapshot, valid only while its descriptor is owned. */
export interface GhidraSnapshotReader {
  readonly size: number;
  /** Read exactly `[start, end)` into memory. */
  read(start: number, end: number): Promise<Buffer>;
  /** Stream `[start, size)` in bounded chunks without retaining it. */
  stream(start: number): AsyncIterable<Buffer>;
}

/** Bind a reader to an admitted snapshot descriptor and its observed size. */
export const createGhidraSnapshotReader = (
  handle: FileHandle,
  size: number,
  path: string,
  signal: AbortSignal | undefined,
): GhidraSnapshotReader => ({
  size,
  read: async (start, end) => {
    const bytes = Buffer.allocUnsafe(end - start);
    let total = 0;
    while (total < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        total,
        bytes.length - total,
        start + total,
      );
      if (bytesRead === 0) throw new RegularFileChangedError(path);
      total += bytesRead;
    }
    return bytes;
  },
  stream: async function* (start: number) {
    let position = start;
    // The inclusive end reads one byte past `size` so growth is detected.
    for await (const chunk of readFileHandleChunks(handle, {
      start,
      end: size,
      signal,
    })) {
      position += chunk.length;
      yield chunk;
    }
    if (position !== size) throw new RegularFileChangedError(path);
  },
});
