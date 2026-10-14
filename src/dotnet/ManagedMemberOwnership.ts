import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import { metadataRowCursor } from "./ManagedMetadataHeaps.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  memberListIndexSize,
  memberListRowLookup,
  memberListTable,
} from "./ManagedMemberPointers.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

type MemberTable = 4 | 6;
type OwnerLookup = (definitionRow: number) => number;

/** The list positions one TypeDef owns, so they always agree with its members' owners. */
export interface TypeMemberList {
  readonly first: number | null;
  readonly last: number | null;
  readonly count: number;
  /** The list starts below the previous TypeDef's start, so the lists are not monotonic. */
  readonly decreasing: boolean;
}

interface MemberOwnership {
  readonly typeList: (typeRow: number) => TypeMemberList;
  /** Pointer failures leave the type lists readable and the owner unknown. */
  readonly declaringTypeRow: OwnerLookup | ManagedReaderFailure;
}

const ownerships = new WeakMap<
  ManagedMetadataLayout,
  Map<MemberTable, MemberOwnership | ManagedReaderFailure>
>();

const memberOwnership = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
): MemberOwnership => {
  let byTable = ownerships.get(layout);
  const cached = byTable?.get(table);
  if (cached instanceof ManagedReaderFailure) throw cached;
  if (cached !== undefined) return cached;
  if (byTable === undefined) {
    byTable = new Map();
    ownerships.set(layout, byTable);
  }
  try {
    const positions = memberListTable(layout, table)?.rowCount ?? 0;
    const types = layout.table(2)?.rowCount ?? 0;
    managedDecodeBudget(layout).reserve(
      (2 * positions + 3 + 3 * (types + 1)) * Uint32Array.BYTES_PER_ELEMENT +
        (types + 1) +
        256,
      layout.table(2)?.offset ?? null,
    );
    const owners = new Uint32Array(positions + 1);
    const firsts = new Uint32Array(types + 1);
    const lasts = new Uint32Array(types + 1);
    const counts = new Uint32Array(types + 1);
    const decreasing = new Uint8Array(types + 1);
    // Skip already-owned positions so overlapping malformed lists remain near-linear.
    const next = Uint32Array.from({ length: positions + 2 }, (_, p) => p);
    const unowned = (position: number): number => {
      let root = position;
      while (next[root] !== root) root = next[root] ?? root;
      for (let p = position; p !== root;) {
        const following = next[p] ?? root;
        next[p] = root;
        p = following;
      }
      return root;
    };
    const startForType = (row: number): number => {
      const cursor = metadataRowCursor(bytes, layout, 2, row);
      cursor.readUInt32();
      cursor.readIndex(layout.stringIndexSize);
      cursor.readIndex(layout.stringIndexSize);
      cursor.readIndex(layout.codedIndexSize("TypeDefOrRef"));
      const fieldStart = cursor.readIndex(memberListIndexSize(layout, 4));
      return table === 4
        ? fieldStart
        : cursor.readIndex(memberListIndexSize(layout, 6));
    };
    let previous = 0;
    let start = types === 0 ? 0 : startForType(1);
    for (let row = 1; row <= types; row += 1) {
      const end = row === types ? positions + 1 : startForType(row + 1);
      const limit = Math.min(end, positions + 1);
      let count = 0;
      for (
        let p = unowned(Math.min(Math.max(start, 1), positions + 1));
        p < limit;
        p = unowned(p + 1)
      ) {
        owners[p] = row;
        next[p] = p + 1;
        if (count === 0) firsts[row] = p;
        lasts[row] = p;
        count += 1;
      }
      counts[row] = count;
      decreasing[row] = start < previous ? 1 : 0;
      previous = start;
      start = end;
    }
    const typeList = (typeRow: number): TypeMemberList => {
      const count = counts[typeRow] ?? 0;
      return {
        first: count === 0 ? null : (firsts[typeRow] ?? null),
        last: count === 0 ? null : (lasts[typeRow] ?? null),
        count,
        decreasing: decreasing[typeRow] === 1,
      };
    };
    let declaringTypeRow: OwnerLookup | ManagedReaderFailure;
    try {
      const positionOf = memberListRowLookup(bytes, layout, table);
      const definitions = layout.table(table)?.rowCount ?? 0;
      declaringTypeRow = (definition) =>
        definition < 1 || definition > definitions
          ? 0
          : (owners[positionOf(definition)] ?? 0);
    } catch (cause: unknown) {
      if (!(cause instanceof ManagedReaderFailure)) throw cause;
      declaringTypeRow = cause;
    }
    const ownership: MemberOwnership = { typeList, declaringTypeRow };
    byTable.set(table, ownership);
    return ownership;
  } catch (cause: unknown) {
    // Replaying a malformed layout must neither rebuild nor charge the index again.
    if (cause instanceof ManagedReaderFailure) byTable.set(table, cause);
    throw cause;
  }
};

/** One first-match TypeDef owner per physical member, shared by every inspection facet. */
export const memberDeclaringTypeRowLookup = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
): OwnerLookup => {
  const { declaringTypeRow } = memberOwnership(bytes, layout, table);
  if (declaringTypeRow instanceof ManagedReaderFailure) throw declaringTypeRow;
  return declaringTypeRow;
};

/** The first-match list positions one TypeDef owns, from the index that resolves member owners. */
export const typeMemberList = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  table: MemberTable,
  typeRow: number,
): TypeMemberList => memberOwnership(bytes, layout, table).typeList(typeRow);
