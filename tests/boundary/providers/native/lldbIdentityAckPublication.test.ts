import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    // Widens the gap between creating the ack name and writing its content.
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const [path, data, options] = args;
      if (
        typeof path === "string" &&
        basename(path).startsWith("identity.ack")
      ) {
        await fs.writeFile(path, "", options);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fs.writeFile(path, data, options);
      }
      return fs.writeFile(...args);
    },
  };
});

import { nativeCallObservationInputSchema } from "../../../../src/domain/native/nativeCallObservation.js";
import { ok } from "../../../../src/domain/result.js";
import type { NativeCallTracer } from "../../../../src/native/LldbCallTracer.js";
import { LldbCallTracer } from "../../../../src/native/LldbCallTracer.js";

const request: Parameters<NativeCallTracer["trace"]>[0] = {
  executable: "/fixture/target",
  architecture: "arm64",
  expectedSha256: "0".repeat(64),
  input: nativeCallObservationInputSchema.parse({
    breakpoints: [{ kind: "function", name: "main" }],
  }),
};

it.skipIf(process.platform === "win32")(
  "publishes the LLDB identity ack only once its content is complete",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-lldb-ack-"));
    const observed = join(directory, "observed");
    const fakeLldb = join(directory, "lldb");
    await writeFile(
      fakeLldb,
      [
        "#!/bin/sh",
        "for last; do :; done",
        "root=${last#rea_trace }",
        "root=${root%/*}",
        'printf %s $$ > "$root/pid"',
        'until [ -e "$root/identity.ack" ]; do sleep 0.01; done',
        'ack=$(cat "$root/identity.ack")',
        `printf %s "$ack" > "${observed}"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    const tracer = new LldbCallTracer(
      { PATH: process.env.PATH ?? "" },
      undefined,
      async () => ok({ path: fakeLldb, sha256: "0".repeat(64) }),
    );
    try {
      await tracer.trace(request, AbortSignal.timeout(10_000));
      await expect(readFile(observed, "utf8")).resolves.toBe("readable");
    } finally {
      await tracer.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
