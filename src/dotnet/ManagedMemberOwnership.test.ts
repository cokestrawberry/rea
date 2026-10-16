import { fc, it } from "@fast-check/vitest";
import { describe, expect, vi } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { managedDecodeBudget } from "./ManagedDecodeBudget.js";
import { memberDeclaringTypeRowLookup } from "./ManagedMemberOwnership.js";
import { memberListIndexSize } from "./ManagedMemberPointers.js";
import { readManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import {
  buildManagedMemberPointerFixture,
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

const metadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
};

/** Rewrite the fixture's three TypeDef list columns; returns each row's FieldList offset. */
const writeTypeLists = (
  bytes: Buffer,
  fields: readonly number[],
  methods: readonly number[],
): readonly number[] => {
  const layout = metadataLayout(bytes);
  const types = layout.table(2);
  if (types === undefined) throw new Error("Fixture omitted TypeDef");
  return Array.from({ length: 3 }, (_, row) => {
    const fieldOffset =
      types.offset +
      row * types.rowSize +
      4 +
      2 * layout.stringIndexSize +
      layout.codedIndexSize("TypeDefOrRef");
    bytes.writeUInt16LE(fields[row] ?? 0, fieldOffset);
    bytes.writeUInt16LE(
      methods[row] ?? 0,
      fieldOffset + memberListIndexSize(layout, 4),
    );
    return fieldOffset;
  });
};

describe("managed declaring type ownership", () => {
  it.prop([
    fc.tuple(
      fc.tuple(
        ...Array.from({ length: 3 }, () => fc.integer({ min: 0, max: 6 })),
      ),
      fc.tuple(
        ...Array.from({ length: 3 }, () => fc.integer({ min: 0, max: 6 })),
      ),
    ),
  ])(
    "retains first-match field and method owners for arbitrary metadata lists",
    ([fields, methods]) => {
      const bytes = buildManagedMemberPointerFixture();
      writeTypeLists(bytes, fields, methods);
      const target = managedPeFixtureTarget(bytes);
      const members = inspectManagedMembersBytes(bytes, target);
      const artifact = inspectManagedArtifactBytes(bytes, target);
      for (const [table, starts, list] of [
        ["fields", fields, "field_list"],
        ["methods", methods, "method_list"],
      ] as const) {
        // Each type's list covers exactly the positions whose members it declares.
        const declaring = members[table].map(
          (member) => member.declaring_type_token,
        );
        expect(members.types.map((type) => type[list].count)).toEqual(
          members.types.map(
            (type) => declaring.filter((token) => token === type.token).length,
          ),
        );
        // The fixture's pointers reorder physical rows 1,2 to list positions 2,1.
        const expected = [2, 1].map((position) => {
          const owner = starts.findIndex(
            (start, index) =>
              position >= start && position < (starts[index + 1] ?? 3),
          );
          return owner < 0 ? null : members.types[owner]?.full_name;
        });
        expect(members[table].map((member) => member.declaring_type)).toEqual(
          expected,
        );
      }
      expect(artifact.attributes[0]?.type_name).toBe(
        members.methods[0]?.declaring_type,
      );
    },
  );

  it("reports a decreasing list as invalid and keeps type lists on member owners", () => {
    const bytes = buildManagedMemberPointerFixture();
    // FieldList of the third type drops below the second's; MethodList stays ascending.
    const fieldListOffsets = writeTypeLists(bytes, [1, 2, 1], [1, 1, 2]);
    const result = inspectManagedMembersBytes(
      bytes,
      managedPeFixtureTarget(bytes),
    );

    expect(
      result.types.map(({ field_list, method_list }) => ({
        field_list,
        method_list,
      })),
    ).toEqual([
      {
        field_list: { first_row: 1, last_row: 1, count: 1 },
        method_list: { first_row: null, last_row: null, count: 0 },
      },
      {
        field_list: { first_row: null, last_row: null, count: 0 },
        method_list: { first_row: 1, last_row: 1, count: 1 },
      },
      {
        field_list: { first_row: 2, last_row: 2, count: 1 },
        method_list: { first_row: 2, last_row: 2, count: 1 },
      },
    ]);
    expect(result.fields.map((field) => field.declaring_type)).toEqual([
      "Fixture.B",
      "<Module>",
    ]);
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual([
      {
        code: "invalid-row",
        scope: "metadata.TypeDef:0x02000003",
        offset: fieldListOffsets[2],
        detail: expect.stringContaining("TypeDef FieldList 1 is below"),
      },
    ]);
  });

  it("indexes large unordered member lists once per layout", () => {
    const count = 100_000;
    const bytes = buildManagedPeFixture({
      additionalEmptyTypes: count - 1,
      methodRowCount: count,
    });
    const layout = metadataLayout(bytes);
    const types = layout.table(2);
    if (types === undefined) throw new Error("Fixture omitted TypeDef");
    const methodOffset =
      types.offset +
      4 +
      2 * layout.stringIndexSize +
      layout.codedIndexSize("TypeDefOrRef") +
      memberListIndexSize(layout, 4);
    // The first reversed range forces first-match semantics, with the owner last.
    // 100,000 MethodDef rows require a four-byte method-list index.
    bytes.writeUInt32LE(2, methodOffset);
    const start = performance.now();
    const lookup = memberDeclaringTypeRowLookup(bytes, layout, 6);
    expect(
      Array.from({ length: count }, (_, row) => lookup(row + 1)).every(
        (owner) => owner === count,
      ),
    ).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(memberDeclaringTypeRowLookup(bytes, layout, 6)).toBe(lookup);
    expect([lookup(0), lookup(count + 1)]).toEqual([0, 0]);
  });

  it("admits ownership storage before allocation and retains failed admission", () => {
    const bytes = buildManagedPeFixture();
    const layout = metadataLayout(bytes);
    const budget = managedDecodeBudget(layout);
    const capacityFailure = new ManagedReaderFailure({
      code: "resource-limit",
      scope: "metadata.representation",
      offset: layout.table(2)?.offset ?? null,
      detail: "No remaining ownership index capacity",
    });
    const admission = vi.spyOn(budget, "reserve").mockImplementation(() => {
      throw capacityFailure;
    });
    let allocations = 0;
    vi.stubGlobal(
      "Uint32Array",
      new Proxy(Uint32Array, {
        construct(target, args, newTarget) {
          allocations++;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    try {
      expect(() => memberDeclaringTypeRowLookup(bytes, layout, 6)).toThrow(
        capacityFailure,
      );
      expect(() => memberDeclaringTypeRowLookup(bytes, layout, 6)).toThrow(
        capacityFailure,
      );
      expect(admission).toHaveBeenCalledTimes(1);
      expect(allocations).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      admission.mockRestore();
    }
  });
});
