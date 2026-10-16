import { expect, it, vi } from "vitest";

import { inspectManagedNativeBoundariesBytes } from "./ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";

// One issue per ManifestResource row exhausts the decode budget before the
// argument limit, so the issues are injected at the inventory boundary.
const inventoryIssues = vi.hoisted(() =>
  Array.from({ length: 150_000 }, (_, index) => ({
    code: "invalid-row" as const,
    scope: `metadata.ManifestResource:${index}`,
    offset: null,
    detail: "Injected inventory issue",
  })),
);

vi.mock("./ManagedMetadataInventory.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./ManagedMetadataInventory.js")>();
  return {
    ...original,
    readManagedMetadataInventory: (
      ...args: Parameters<typeof original.readManagedMetadataInventory>
    ) => {
      const inventory = original.readManagedMetadataInventory(...args);
      return {
        ...inventory,
        issues: [...inventory.issues, ...inventoryIssues],
      };
    },
  };
});

it("retains inventory issues beyond the argument limit of push", () => {
  const bytes = buildManagedPeFixture();
  const result = inspectManagedNativeBoundariesBytes(
    bytes,
    managedPeFixtureTarget(bytes),
  );

  expect(result.coverage.state).toBe("partial");
  expect(result.coverage.issues).toEqual(inventoryIssues);
}, 60_000);
