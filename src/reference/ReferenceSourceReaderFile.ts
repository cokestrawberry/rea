import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
} from "../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";

import {
  entryFailure,
  filesystemFailureDetail,
  safeSize,
} from "./ReferenceSourceReaderErrors.js";
import {
  isAborted,
  sameFile,
  validateDirectory,
} from "./ReferenceSourceReaderValidate.js";
import type {
  ReferenceSourceEntry,
  StableFileRequest,
} from "./ReferenceSourceReaderTypes.js";

const READ_CHUNK_BYTES = 64 * 1024;

type PreparedFileRead =
  | {
      readonly status: "ready";
      readonly before: BigIntStats;
    }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FileContentsRead =
  | {
      readonly status: "ok";
      readonly sha256: string;
      /** Empty unless the read retained bytes. */
      readonly chunks: Buffer[];
      readonly total: number;
    }
  | { readonly status: "failed"; readonly entry: ReferenceSourceEntry };

type FinalizeFileReadRequest = {
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly absolute: string;
  readonly path: string;
  readonly handle: FileHandle;
  readonly before: BigIntStats;
  readonly parentBefore: { readonly ok: true; readonly stats: BigIntStats };
  readonly sha256: string;
  readonly retainBytes: boolean;
  readonly chunks: Buffer[];
  readonly total: number;
  readonly signal?: AbortSignal;
};

const prepareFileRead = async (
  request: StableFileRequest,
  handle: FileHandle,
): Promise<PreparedFileRead> => {
  const { path, expected, signal } = request;
  if (isAborted(signal)) {
    return {
      status: "failed",
      entry: entryFailure(
        path,
        "file",
        "cancelled",
        "File read cancelled",
        safeSize(expected.size),
      ),
    };
  }
  const before = await handle.stat({ bigint: true });
  if (!sameFile(expected, before)) {
    return {
      status: "failed",
      entry: entryFailure(
        path,
        "file",
        "changed",
        "File changed before it was read",
        safeSize(before.size),
      ),
    };
  }
  return { status: "ready", before };
};

/**
 * Hash a stable-size file through its borrowed descriptor; growth is a change.
 * Chunks are kept only when `retainBytes` is set.
 */
export const readFileContents = async (request: {
  readonly handle: {
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ): Promise<{ readonly bytesRead: number }>;
  };
  readonly path: string;
  readonly expectedSize: bigint;
  readonly retainBytes: boolean;
  readonly signal?: AbortSignal;
}): Promise<FileContentsRead> => {
  const { handle, path, retainBytes, signal } = request;
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let scratch: Buffer | undefined;
  let total = 0;
  for (;;) {
    if (isAborted(signal))
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "cancelled",
          "File read cancelled",
          total,
        ),
      };
    // One extra byte detects growth without allocating a full chunk at EOF.
    const remaining = request.expectedSize - BigInt(total);
    const chunkBytes =
      remaining >= BigInt(READ_CHUNK_BYTES)
        ? READ_CHUNK_BYTES
        : Number(remaining) + 1;
    const chunk = retainBytes
      ? Buffer.allocUnsafe(chunkBytes)
      : (scratch ??= Buffer.allocUnsafe(READ_CHUNK_BYTES));
    const read = await handle.read(chunk, 0, chunkBytes, null);
    if (isAborted(signal))
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "cancelled",
          "File read cancelled",
          total,
        ),
      };
    if (read.bytesRead === 0) break;
    total += read.bytesRead;
    if (BigInt(total) > request.expectedSize)
      return {
        status: "failed",
        entry: entryFailure(
          path,
          "file",
          "changed",
          "File grew while it was read",
          total,
        ),
      };
    const observed = chunk.subarray(0, read.bytesRead);
    hash.update(observed);
    if (retainBytes) chunks.push(observed);
  }
  return { status: "ok", sha256: hash.digest("hex"), chunks, total };
};

const finalizeFileRead = async (
  request: FinalizeFileReadRequest,
): Promise<ReferenceSourceEntry> => {
  const {
    root,
    rootIdentity,
    absolute,
    path,
    handle,
    before,
    parentBefore,
    sha256,
    retainBytes,
    chunks,
    total,
  } = request;
  const after = await handle.stat({ bigint: true });
  const parentAfter = await validateDirectory(
    root,
    rootIdentity,
    dirname(absolute),
    request.signal,
  );
  if (!parentAfter.ok || !sameFile(parentBefore.stats, parentAfter.stats))
    return entryFailure(
      path,
      "file",
      "changed",
      "Parent directory changed while file was read",
      total,
    );
  if (!sameFile(before, after) || BigInt(total) !== after.size)
    return entryFailure(
      path,
      "file",
      "changed",
      "File changed while it was read",
      total,
    );
  return {
    status: "read",
    kind: "file",
    path,
    sha256,
    size: total,
    ...(retainBytes ? { bytes: Buffer.concat(chunks, total) } : {}),
  };
};

export const readStableFile = async (
  request: StableFileRequest,
): Promise<{
  readonly entry: ReferenceSourceEntry;
  readonly cleanup?: AnalysisCleanupObservation;
}> => {
  let owner: OwnedFileHandle | undefined;
  let cleanup: AnalysisCleanupObservation | undefined;
  let entry: ReferenceSourceEntry;
  try {
    entry = await readStableFileEntry(request, (admitted) => {
      owner = admitted;
    });
  } finally {
    if (owner !== undefined) {
      const result = await request.resources.release({
        kind: "file-handle",
        handle: owner,
        resource: request.absolute,
      });
      if (result.kind === "failed")
        cleanup = ArtifactReaderFailure.cleanupObservation(
          result.cause,
          request.absolute,
        );
    }
  }
  return { entry, ...(cleanup === undefined ? {} : { cleanup }) };
};

const readStableFileEntry = async (
  request: StableFileRequest,
  retain: (owner: OwnedFileHandle) => void,
): Promise<ReferenceSourceEntry> => {
  const { root, rootIdentity, absolute, path, expected, signal } = request;
  try {
    const parentBefore = await validateDirectory(
      root,
      rootIdentity,
      dirname(absolute),
      signal,
    );
    if (!parentBefore.ok)
      return entryFailure(
        path,
        "file",
        parentBefore.code,
        parentBefore.message,
        safeSize(expected.size),
      );
    const handle = await openRegularFile(absolute, {
      symlinks: "reject",
      signal,
    });
    retain(new OwnedFileHandle(handle));
    const prepared = await prepareFileRead(request, handle);
    if (prepared.status === "failed") return prepared.entry;
    const contents = await readFileContents({
      handle,
      path,
      expectedSize: prepared.before.size,
      retainBytes: request.retainBytes,
      ...(signal === undefined ? {} : { signal }),
    });
    if (contents.status === "failed") return contents.entry;
    return await finalizeFileRead({
      root,
      rootIdentity,
      absolute,
      path,
      handle,
      before: prepared.before,
      parentBefore,
      sha256: contents.sha256,
      retainBytes: request.retainBytes,
      chunks: contents.chunks,
      total: contents.total,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause: unknown) {
    if (cause instanceof RegularFileAdmissionFailure) {
      retain(cause.owner);
      cause = cause.cause;
    }
    if (isAborted(signal))
      return entryFailure(
        path,
        "file",
        "cancelled",
        "File read cancelled",
        safeSize(expected.size),
      );
    if (cause instanceof NonRegularFileReadError)
      return entryFailure(
        path,
        "file",
        "changed",
        "File is no longer a regular file",
        safeSize(expected.size),
      );
    const message = filesystemFailureDetail(
      cause,
      "File could not be read safely",
    );
    if (message === undefined) throw cause;
    return entryFailure(path, "file", "io", message, safeSize(expected.size));
  }
};
