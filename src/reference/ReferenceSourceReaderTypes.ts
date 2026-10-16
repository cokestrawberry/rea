import type { BigIntStats } from "node:fs";

import type { Result } from "../domain/result.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

export type ReferenceSourceEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "other";

/**
 * Kind offered to exclusion predicates. `unknown` marks an entry whose
 * metadata could not be read, so its concrete kind cannot be claimed.
 */
export type ReferenceSourceExclusionKind = ReferenceSourceEntryKind | "unknown";

export interface ReferenceSourceReaderOptions {
  readonly signal?: AbortSignal;
  readonly shouldExclude?: (
    path: string,
    kind: ReferenceSourceExclusionKind,
  ) => boolean;
  /** Files selected here keep their bytes within the retention bounds; all others are only hashed. */
  readonly shouldRetainBytes?: (path: string) => boolean;
}

export type ReferenceSourceFailureCode =
  | "cancelled"
  | "changed"
  | "io"
  | "symlink"
  | "unsupported";

export type ReferenceSourceEntry =
  | {
      readonly status: "read";
      readonly kind: "file";
      readonly path: string;
      readonly sha256: string;
      /** Absent unless selected by `shouldRetainBytes` and within the retention bounds. */
      readonly bytes?: Uint8Array;
      readonly size: number;
    }
  | {
      readonly status: "read";
      readonly kind: "directory";
      readonly path: string;
    }
  | {
      readonly status: "read";
      readonly kind: "symlink";
      readonly path: string;
      /** Internal and relative missing targets are resolved from the inventory root. */
      readonly target: string;
      readonly targetState: "internal" | "external" | "missing";
    }
  | {
      readonly status: "failed";
      readonly kind: "file" | "directory" | "symlink" | "other" | "unknown";
      readonly path: string;
      readonly code: ReferenceSourceFailureCode;
      readonly message: string;
      readonly size?: number;
    };

export interface ReferenceSourceRead {
  readonly root: string;
  readonly entries: readonly ReferenceSourceEntry[];
  readonly bytesRead: number;
  /** Node exposes no portable openat traversal; pathname identity is checked around each operation. */
  readonly limitations: readonly string[];
}

export interface ReferenceSourceReaderError {
  readonly tag: "reference-source-reader";
  readonly code: "cancelled" | "invalid-root" | "io" | "unsupported";
  readonly message: string;
  readonly cleanup?: AnalysisCleanupObservation;
  /** Captured entries before failure; this does not establish complete tree coverage. */
  readonly partial?: ReferenceSourceRead;
  readonly cause?: unknown;
}

export type PendingDirectory = {
  readonly path: string;
};

export type TraversalState = {
  readonly resources: ArtifactResourceScope;
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly signal?: AbortSignal;
  readonly shouldExclude?: (
    path: string,
    kind: ReferenceSourceExclusionKind,
  ) => boolean;
  readonly shouldRetainBytes?: (path: string) => boolean;
  readonly entries: ReferenceSourceEntry[];
  readonly pending: PendingDirectory[];
  bytesRead: number;
  retainedBytes: number;
};

export type StableFileRequest = {
  readonly resources: ArtifactResourceScope;
  readonly root: string;
  readonly rootIdentity: BigIntStats;
  readonly absolute: string;
  readonly path: string;
  readonly expected: BigIntStats;
  readonly retainBytes: boolean;
  readonly signal?: AbortSignal;
};

export type ReferenceSourceResult<T> = Result<T, ReferenceSourceReaderError>;
