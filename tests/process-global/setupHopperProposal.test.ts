import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FakeSetupHost } from "../../src/application/Setup.fixture.js";
import type { SetupHost } from "../../src/application/SetupTypes.js";
import type { confirmInteractiveSetup } from "../../src/cli/interactiveSetup.js";
import { registerSetupCommands } from "../../src/cli/setupCommands.js";
import type { CliInstance } from "../../src/cli/types.js";
import { CLI_COMMANDS } from "../../src/cliCommandNames.js";
import { silentLogger } from "../../src/logger.js";

const state = vi.hoisted(() => ({
  host: undefined as SetupHost | undefined,
  confirm: vi.fn<typeof confirmInteractiveSetup>(),
}));
vi.mock("../../src/application/SetupHost.js", async (original) => ({
  ...(await original<typeof import("../../src/application/SetupHost.js")>()),
  systemSetupHost: () => state.host,
}));
vi.mock("../../src/doctorRuntime.js", () => ({
  createSystemDoctorHost: () => ({}),
}));
vi.mock("../../src/cli/interactiveSetup.js", () => ({
  confirmInteractiveSetup: state.confirm,
  renderSetupDryRun: vi.fn(),
  renderInteractiveSetupResult: vi.fn(),
  renderSetupProgress: vi.fn(),
}));

const terminalStreams = [process.stdin, process.stdout, process.stderr];
const originalTerminalFlags = terminalStreams.map((stream) =>
  Object.getOwnPropertyDescriptor(stream, "isTTY"),
);
const originalExitCode = process.exitCode;

beforeEach(() => {
  state.confirm.mockReset();
  state.confirm.mockResolvedValue({
    approved: false,
    selectedActionIds: [],
    cancelled: true,
  });
  for (const stream of terminalStreams)
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  terminalStreams.forEach((stream, index) => {
    const descriptor = originalTerminalFlags[index];
    if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", descriptor);
  });
  process.exitCode = originalExitCode;
});

const runInteractiveSetup = async (options: {
  readonly client?: readonly string[] | undefined;
  readonly installHopper?: boolean | undefined;
}) => {
  const host = new FakeSetupHost();
  host.clients = [
    { name: "codex", displayName: "Codex", configPath: "/codex.toml" },
  ];
  state.host = host;
  const commands = new Map<
    string,
    {
      run(input: {
        options: Record<string, unknown>;
        formatExplicit: boolean;
      }): Promise<unknown>;
    }
  >();
  const cli = {
    command: (name: string, definition: unknown) => {
      commands.set(
        name,
        definition as {
          run(input: {
            options: Record<string, unknown>;
            formatExplicit: boolean;
          }): Promise<unknown>;
        },
      );
      return cli;
    },
  } as unknown as CliInstance;
  registerSetupCommands(cli, silentLogger, {});
  const command = commands.get(CLI_COMMANDS.setup);
  if (command === undefined)
    throw new Error("setup CLI command was not registered");
  await command.run({
    options: {
      yes: false,
      installHopper: false,
      client: [],
      skillClient: [],
      allDetected: false,
      dryRun: false,
      accessible: false,
      ...options,
    },
    formatExplicit: false,
  });
  const call = state.confirm.mock.calls[0];
  if (call === undefined) throw new Error("setup did not request consent");
  const [actions, , context] = call;
  return { stage: context?.stage, kinds: actions.map(({ kind }) => kind) };
};

it.each([
  {
    label: "no explicit scope",
    options: {},
    stage: "select",
    proposesHopper: true,
  },
  {
    label: "an explicit client without the Hopper question",
    options: { client: ["codex"] },
    stage: "confirm",
    proposesHopper: false,
  },
  {
    label: "an explicit client with --install-hopper",
    options: { client: ["codex"], installHopper: true },
    stage: "confirm",
    proposesHopper: true,
  },
])(
  "proposes Hopper in an interactive run only where it is asked or requested: $label",
  async ({ options, stage, proposesHopper }) => {
    const result = await runInteractiveSetup(options);
    expect(result.stage).toBe(stage);
    expect(result.kinds.includes("install_hopper")).toBe(proposesHopper);
  },
);
