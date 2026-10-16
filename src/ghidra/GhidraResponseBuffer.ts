import { ProviderResponseLines } from "../process/ProviderResponseLines.js";

import { ProviderResponseLineLimitError } from "../process/ProviderResponseLineLimit.js";

/** Callbacks for one newline-delimited Ghidra response stream. */
export interface GhidraResponseBufferOptions {
  readonly onLine: (line: string) => void;
  readonly onOverflow: (error: ProviderResponseLineLimitError) => void;
}

/** Splits fragmented UTF-8 socket data into response lines. */
export class GhidraResponseBuffer {
  readonly #lines: ProviderResponseLines;

  constructor(options: GhidraResponseBufferOptions) {
    this.#lines = new ProviderResponseLines(
      "Ghidra",
      options.onLine,
      options.onOverflow,
    );
  }

  push(chunk: string): void {
    this.#lines.push(chunk);
  }

  reset(): void {
    this.#lines.reset();
  }
}
