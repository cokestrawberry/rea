import { Cli } from "incur";
import { expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../../../src/application/AnalysisProvider.js";
import { registerAdbCommands } from "../../../src/cli/adbCommands.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { registerFlutterCommands } from "../../../src/cli/flutterCommands.js";
import { registerJebCommands } from "../../../src/cli/jebCommands.js";
import type { CliInstance } from "../../../src/cli/types.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";

/** Provider whose close rejects with a plain AggregateError, as multi-owner cleanup does. */
const providerFailingToClose = (
  execute: () => Promise<Result<AnalysisExecution, AnalysisError>>,
) => ({
  async inspectAvailability(): Promise<never> {
    throw new Error("unexpected provider probe");
  },
  async close(): Promise<void> {
    throw new AggregateError(
      [new Error("owned worker did not stop")],
      "Provider cleanup failed.",
    );
  },
  execute,
});

type FailingProvider = ReturnType<typeof providerFailingToClose>;

const commands: readonly {
  readonly name: string;
  readonly argv: readonly string[];
  readonly register: (cli: CliInstance, provider: FailingProvider) => void;
}[] = [
  {
    name: "adb",
    argv: ["list-adb-devices"],
    register: (cli, provider) =>
      registerAdbCommands(cli, silentLogger, {}, provider),
  },
  {
    name: "apktool",
    argv: ["inspect-apktool-client"],
    register: (cli, provider) =>
      registerApktoolCommands(cli, silentLogger, {}, provider),
  },
  {
    name: "flutter",
    argv: ["identify-flutter-build", "/targets/app.apk"],
    register: (cli, provider) =>
      registerFlutterCommands(cli, silentLogger, provider),
  },
  {
    name: "jeb",
    argv: ["inspect-jeb-client"],
    register: (cli, provider) =>
      registerJebCommands(cli, silentLogger, {}, provider),
  },
];

const serve = async (
  register: (cli: CliInstance, provider: FailingProvider) => void,
  provider: FailingProvider,
  argv: readonly string[],
): Promise<unknown> => {
  const cli = Cli.create("provider-cleanup-failure-test", { sync: false });
  register(cli, provider);
  let stdout = "";
  await cli.serve([...argv, "--format", "json"], {
    stdout: (text) => {
      stdout += text;
    },
    exit: () => {},
  });
  return JSON.parse(stdout);
};

it.each(commands)(
  "$name keeps the completed Evidence when provider cleanup fails with an untyped error",
  async ({ register, argv }) => {
    const output = await serve(
      register,
      providerFailingToClose(async () =>
        ok(
          createAnalysisExecution(
            { completed: true },
            { id: "cleanup-fixture", name: "Cleanup fixture", version: null },
          ),
        ),
      ),
      argv,
    );

    expect(output).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        partial_observation: {
          provider: { id: "cleanup-fixture" },
          normalized_result: { completed: true },
        },
      },
    });
  },
);

it.each(commands)(
  "$name projects an untyped cleanup failure after an operation error as a typed error",
  async ({ register, argv }) => {
    const output = await serve(
      register,
      providerFailingToClose(async () =>
        err(
          new AnalysisInputError("cleanup_fixture", {
            userMessage: "The selected input was rejected.",
          }),
        ),
      ),
      argv,
    );

    expect(output).toMatchObject({
      code: "cleanup_incomplete",
      message: "The selected input was rejected.",
      details: { diagnostics: { primary_error: { code: "invalid_request" } } },
    });
  },
);
