import type { ProcessScenario } from "../../domain/process/processScenario.js";

const REDACTION = "<redacted-input>";
const TRAILING_LINE_BREAKS = /[\r\n]+$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Terminal-visible text of the scenario's sensitive scripted inputs. */
export interface SensitiveTerminalInput {
  /** Each input without its submitting line break, which is what PTY echo repeats. */
  readonly values: readonly string[];
  /** False when an input's echo is rewritten by the line discipline and cannot be matched exactly. */
  readonly redactable: boolean;
}

/** Derive the echoed form of every input the caller marked sensitive. */
export const sensitiveTerminalInput = (
  scenario: ProcessScenario,
): SensitiveTerminalInput => {
  const values = new Set<string>();
  let redactable = true;
  for (const event of scenario.events) {
    if (event.type !== "input" || !event.sensitive) continue;
    const echoed = event.data.replace(TRAILING_LINE_BREAKS, "");
    // Control characters and inner line breaks echo as ^X sequences or CR LF.
    if (CONTROL_CHARACTER.test(echoed)) redactable = false;
    else if (echoed !== "") values.add(echoed);
  }
  return { values: [...values], redactable };
};

/** Stateful redaction of literal values across PTY chunk boundaries. */
export interface SensitiveOutputRedactor {
  /** Redact complete values and hold back a tail that may begin a value. */
  readonly push: (chunk: string) => string;
  /** Release the held tail once no later chunk can complete a value. */
  readonly flush: () => string;
}

/** Replace every literal occurrence of `values` in a chunked output stream. */
export const createSensitiveOutputRedactor = (
  values: readonly string[],
): SensitiveOutputRedactor => {
  if (values.length === 0) return { push: (chunk) => chunk, flush: () => "" };
  const matcher = new RegExp(
    [...values]
      .sort((left, right) => right.length - left.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
  const longest = Math.max(...values.map((value) => value.length));
  const startsValue = (tail: string): boolean =>
    values.some(
      (value) => value.length > tail.length && value.startsWith(tail),
    );
  let held = "";
  return {
    push: (chunk) => {
      const pending = held + chunk;
      const matches = [...pending.matchAll(matcher)];
      // A tail that begins inside a complete match is redacted with it.
      const insideMatch = (position: number): boolean =>
        matches.some(
          (match) =>
            match.index < position && position < match.index + match[0].length,
        );
      let end = pending.length;
      for (
        let start = Math.max(0, pending.length - longest + 1);
        start < pending.length;
        start += 1
      )
        if (startsValue(pending.slice(start)) && !insideMatch(start)) {
          end = start;
          break;
        }
      held = pending.slice(end);
      return pending.slice(0, end).replace(matcher, REDACTION);
    },
    flush: () => {
      const tail = held.replace(matcher, REDACTION);
      held = "";
      return tail;
    },
  };
};
