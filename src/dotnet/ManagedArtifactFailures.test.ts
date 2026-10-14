import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "./ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

const moduleRowCountOffset = (bytes: Buffer): number => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const root = pe.rvaToOffset(
    pe.cli.metadata.rva,
    pe.cli.metadata.size,
    "cli.metadata",
  );
  const versionLength = bytes.readUInt32LE(root + 12);
  const streamHeader = ((root + 16 + versionLength + 3) & ~3) + 4;
  // The Module table is the first valid table, so its row count opens the counts.
  return root + bytes.readUInt32LE(streamHeader) + 24;
};

describe("managed artifact failure classification", () => {
  it("distinguishes native, malformed, and unsupported metadata", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedArtifactBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
    );
    expect(native).toMatchObject({
      classification: { status: "not-managed" },
      metadata: { status: "absent" },
      coverage: { state: "unavailable" },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      managedPeFixtureTarget(unsupportedTableBytes),
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);
  });

  it.each([
    {
      rowCount: 0x0100_0000,
      code: "invalid-tables",
      scope: "metadata.table-row-count",
    },
    {
      rowCount: 0x00ff_ffff,
      code: "invalid-metadata-root",
      scope: "metadata.table-data",
    },
  ])(
    "classifies a declared row count of $rowCount against the 24-bit RID range",
    ({ rowCount, code, scope }) => {
      const bytes = buildManagedPeFixture();
      const offset = moduleRowCountOffset(bytes);
      bytes.writeUInt32LE(rowCount, offset);
      const result = inspectManagedArtifactBytes(
        bytes,
        managedPeFixtureTarget(bytes),
      );
      expect(result.coverage.issues).toEqual([
        expect.objectContaining({ code, scope }),
      ]);
    },
  );

  it("rejects a ReadyToRun OS-override machine without a CLI directory", () => {
    const bytes = buildNativePeFixture();
    bytes.writeUInt16LE(0x014c ^ 0x7b79, bytes.readUInt32LE(0x3c) + 4);
    expect(() =>
      inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes)),
    ).toThrow("Unsupported PE machine 0x7a35");
  });

  it("keeps malformed reference and attribute issues across inventory callers", () => {
    const bytes = buildManagedPeFixture({
      references: [
        "System.Runtime",
        "System.Runtime",
        "UnityEngine.CoreModule",
      ],
      malformedAssemblyReferenceRows: [3],
      malformedCustomAttributeRows: [1],
    });
    const target = managedPeFixtureTarget(bytes);
    const artifact = inspectManagedArtifactBytes(bytes, target);
    const members = inspectManagedMembersBytes(bytes, target);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, target);
    const issueCodes = ["invalid-heap-index", "invalid-row"];

    expect(artifact.references.map(({ name }) => name)).toEqual([
      "System.Runtime",
      "System.Runtime",
    ]);
    expect(artifact.attributes).toEqual([]);
    expect(artifact.coverage.issues.map(({ code }) => code)).toEqual(
      issueCodes,
    );
    expect(members.coverage.issues.map(({ code }) => code)).toEqual(issueCodes);
    expect(boundaries.coverage).toMatchObject({
      state: "partial",
      issues: [
        expect.objectContaining({ code: "invalid-heap-index" }),
        expect.objectContaining({ code: "invalid-row" }),
      ],
    });
  });
});
