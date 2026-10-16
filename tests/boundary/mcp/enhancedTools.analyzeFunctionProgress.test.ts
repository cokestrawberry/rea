import { afterEach, describe, expect, it } from "vitest";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { ok } from "../../../src/domain/result.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

describe("analyze_function MCP progress", () => {
  it("reports strictly increasing progress from one reporter", async () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const client = await connect({
      execute: () =>
        Promise.resolve(
          ok(
            createAnalysisExecution(
              dossier,
              {
                id: "fixture",
                name: "Fixture analysis provider",
                version: "1",
              },
              {
                subject: {
                  path: "/fixture.app",
                  sha256: "a".repeat(64),
                  format: "mach-o",
                  architecture: "arm64",
                },
              },
            ),
          ),
        ),
    });
    const updates: Array<{
      readonly progress: number;
      readonly message: string | undefined;
    }> = [];

    const result = await client.callTool(
      { name: "analyze_function", arguments: { procedure: "0x401000" } },
      {
        onprogress: ({ progress, message }) => {
          updates.push({ progress, message });
        },
      },
    );

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(updates).toEqual([
      { progress: 1, message: "analyze_function: started" },
      { progress: 2, message: "analyze_function: completed" },
    ]);
  });
});
