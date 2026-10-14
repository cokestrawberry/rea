import { expect, it } from "vitest";

import type { InteractionEvent } from "../../domain/process/processCapture.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { monotonicProcessCaptureClock } from "./ProcessCaptureClock.js";
import {
  createProcessCaptureJournal,
  scheduleScenarioInteractions,
} from "./ProcessCaptureJournal.js";
import type { RootSignaller } from "./ProcessCaptureLifecycle.js";
import type { ProcessTimer } from "./ProcessTimer.js";
import { TerminalRenderer } from "./TerminalRenderer.js";

it("records capture events in monotonic observation order", () => {
  const journal = createProcessCaptureJournal();
  journal.recordEvent("filesystem_checkpoints", 0);
  journal.recordEvent("lifecycle", 0);
  journal.recordEvent("frames", 0);
  journal.recordEvent("filesystem_checkpoints", 1);

  expect(journal.entries).toEqual([
    { capture_order: 0, collection: "filesystem_checkpoints", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 0 },
    { capture_order: 2, collection: "frames", index: 0 },
    { capture_order: 3, collection: "filesystem_checkpoints", index: 1 },
  ]);
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const scheduleSignalEvent = (
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
  signalRoot: RootSignaller,
) => {
  const interactions: InteractionEvent[] = [];
  const journal = createProcessCaptureJournal();
  const renderer = new TerminalRenderer({
    columns: 80,
    rows: 24,
    scrollback: 0,
    maxBytes: 1_000,
    normalize: (value) => value,
  });
  scheduleScenarioInteractions({
    scenario: parseProcessScenario({
      executable: "unused",
      events: [{ type: "signal", at_ms: 0, signal }],
    }),
    getTerminal: () => {
      throw new Error("a signal event must not use the terminal");
    },
    signalRoot,
    timers: new Set<ProcessTimer>(),
    interactions,
    renderer,
    started: monotonicProcessCaptureClock(),
    dispatchedEventIndexes: new Set<number>(),
    recordEvent: journal.recordEvent,
  });
  return { interactions, journal, renderer };
};

it.each([
  ["signaled", "dispatched"],
  ["gone", "target_exited"],
  ["identity-changed", "failed"],
  ["unverified", "failed"],
] as const)(
  "records a scripted signal delivered as %s with outcome %s",
  async (delivery, outcome) => {
    const sent: string[] = [];
    const { interactions, journal, renderer } = scheduleSignalEvent(
      "SIGINT",
      async (signal) => {
        sent.push(signal);
        return { delivery };
      },
    );
    await waitFor(() => interactions.length > 0);
    await renderer.dispose();

    expect(
      sent,
      "the signal goes through the identity-checked signaller",
    ).toEqual(["SIGINT"]);
    expect(interactions).toMatchObject([
      { sequence: 0, type: "signal", data: "SIGINT", outcome },
    ]);
    expect(journal.entries).toEqual([
      { capture_order: 0, collection: "interaction_events", index: 0 },
    ]);
  },
);

it("records a scripted signal only after its delivery settles", async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { interactions, renderer } = scheduleSignalEvent(
    "SIGTERM",
    async () => {
      await hold;
      return { delivery: "signaled" };
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(
    interactions,
    "an unsettled delivery is not yet recorded as dispatched",
  ).toEqual([]);

  release();
  await waitFor(() => interactions.length > 0);
  await renderer.dispose();

  expect(interactions).toMatchObject([
    { type: "signal", outcome: "dispatched" },
  ]);
});

it("records a failed outcome when the signaller rejects", async () => {
  const { interactions, renderer } = scheduleSignalEvent(
    "SIGTERM",
    async () => {
      throw new Error("signal transport failed");
    },
  );
  await waitFor(() => interactions.length > 0);
  await renderer.dispose();

  expect(interactions).toMatchObject([{ type: "signal", outcome: "failed" }]);
});
