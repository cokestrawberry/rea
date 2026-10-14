import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { runCliJavaScriptApplicationAnalysis } from "../../../src/cli/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps the completed analysis when resource cleanup fails", async () => {
  const root = await createTestTempDirectory("rea-js-cli-cleanup-failure-");
  await writeFile(join(root, "main.js"), "fetch('');\n");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const originalClose = ArtifactResourceScope.prototype.close;
  vi.spyOn(ArtifactResourceScope.prototype, "close").mockImplementation(
    async function (this: ArtifactResourceScope) {
      await originalClose.call(this);
      throw new Error("injected resource close failure");
    },
  );

  const output = await runCliJavaScriptApplicationAnalysis({
    input_path: root,
  });

  expect(output).toMatchObject({
    error: "JavaScript application analysis failed",
    code: "cleanup_incomplete",
    details: { partial_observation: { evidence_id: expect.any(String) } },
  });
});
