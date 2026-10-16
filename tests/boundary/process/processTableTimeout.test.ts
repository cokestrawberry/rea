import { chmod, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { expect, it } from "vitest";

import { verifyNoTokenOwnedProcesses } from "../../../src/process/ProcessOwnership.js";
import { createSystemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "reports incomplete cleanup when the ps process-table read exceeds its deadline",
  async () => {
    const directory = await createTestTempDirectory("rea-ps-timeout-test-");
    const fakePs = join(directory, "ps");
    await writeFile(fakePs, "#!/bin/sh\ntrap '' TERM\nexec sleep 60\n");
    await chmod(fakePs, 0o755);
    const host = createSystemProcessOwnershipHost(
      "linux",
      {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      },
      { psTimeoutMs: 200 },
    );

    const result = await verifyNoTokenOwnedProcesses("run-ps-timeout", host);

    expect(result).toMatchObject({
      cleaned: false,
      reason: expect.stringContaining("process table could not be inspected"),
    });
  },
);
