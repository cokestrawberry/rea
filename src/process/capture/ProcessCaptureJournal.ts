import type { IPty } from "@lydell/node-pty";

import type { ProcessScenario } from "../../domain/process/processScenario.js";
import {
  normalizeProcessElapsedTime,
  normalizeProcessText,
} from "./ProcessNormalization.js";
import type { TerminalRenderer } from "./TerminalRenderer.js";
import type { RootSignaller } from "./ProcessCaptureLifecycle.js";
import { scheduleProcessDelay, type ProcessTimer } from "./ProcessTimer.js";

import type {
  InteractionEvent,
  ProcessCaptureEventJournalEntry,
  RecordProcessCaptureEvent,
} from "../../domain/process/processCapture.js";
import { monotonicProcessCaptureClock } from "./ProcessCaptureClock.js";
/** Mutable observation-order ledger whose writer is shared by capture producers. */
export interface ProcessCaptureJournal {
  readonly entries: readonly ProcessCaptureEventJournalEntry[];
  readonly recordEvent: RecordProcessCaptureEvent;
}

/** Create one monotonic event journal for a process capture. */
export const createProcessCaptureJournal = (): ProcessCaptureJournal => {
  const entries: ProcessCaptureEventJournalEntry[] = [];
  const recordEvent: RecordProcessCaptureEvent = (
    collection: ProcessCaptureEventJournalEntry["collection"],
    index: number,
  ): void => {
    entries.push({ capture_order: entries.length, collection, index });
  };
  return {
    entries,
    recordEvent,
  };
};

interface ScenarioInteractionOptions {
  readonly scenario: ProcessScenario;
  readonly getTerminal: () => IPty | undefined;
  readonly signalRoot: RootSignaller;
  readonly timers: Set<ProcessTimer>;
  readonly interactions: InteractionEvent[];
  readonly renderer: TerminalRenderer;
  readonly started: number;
  readonly dispatchedEventIndexes: Set<number>;
  readonly recordEvent: RecordProcessCaptureEvent;
}

const signalOutcome = (
  delivery: Awaited<ReturnType<RootSignaller>>["delivery"],
): InteractionEvent["outcome"] =>
  delivery === "signaled"
    ? "dispatched"
    : delivery === "gone"
      ? "target_exited"
      : "failed";

/** Schedule scenario interactions and record each observed dispatch atomically. */
export const scheduleScenarioInteractions = (
  options: ScenarioInteractionOptions,
): void => {
  const { scenario, getTerminal, timers, interactions, renderer, started } =
    options;
  const elapsedMs = (): number =>
    Math.max(0, monotonicProcessCaptureClock() - started);
  for (const [eventIndex, event] of scenario.events.entries()) {
    const record = (
      outcome: InteractionEvent["outcome"],
      dispatchedAt: number,
    ): void => {
      const sequence = interactions.length;
      interactions.push({
        sequence,
        scheduled_at_ms: event.at_ms,
        dispatched_at_ms: dispatchedAt,
        type: event.type,
        data:
          event.type === "input"
            ? event.sensitive
              ? `<redacted-input:${String(Buffer.byteLength(event.data))}-bytes>`
              : normalizeProcessText(
                  event.data,
                  scenario,
                  "<no-temporary-root>",
                  -1,
                )
            : event.type === "resize"
              ? `${String(event.columns)}x${String(event.rows)}`
              : event.signal,
        outcome,
      });
      options.recordEvent("interaction_events", sequence);
    };
    const timer = scheduleProcessDelay(event.at_ms, () => {
      options.dispatchedEventIndexes.add(eventIndex);
      if (event.type === "signal") {
        // The delivery is identity-checked, so the event is recorded when it
        // settles; recording at dispatch time would precede the signal.
        void options.signalRoot(event.signal).then(
          ({ delivery }) => record(signalOutcome(delivery), elapsedMs()),
          () => record("failed", elapsedMs()),
        );
        return;
      }
      const terminal = getTerminal();
      const dispatchedAt = elapsedMs();
      let outcome: InteractionEvent["outcome"] = "dispatched";
      if (terminal === undefined) outcome = "target_exited";
      else {
        try {
          if (event.type === "input") terminal.write(event.data);
          else {
            terminal.resize(event.columns, event.rows);
            renderer.resize(
              event.columns,
              event.rows,
              normalizeProcessElapsedTime(
                dispatchedAt,
                scenario.normalization.time_bucket_ms,
              ),
            );
          }
        } catch (cause: unknown) {
          // Terminal dispatch failures are recorded as failed outcomes.
          void cause;
          outcome = "failed";
        }
      }
      record(outcome, dispatchedAt);
    });
    timers.add(timer);
  }
};
