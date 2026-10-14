import { constants } from "node:buffer";

import { ProviderResponseLineLimitError } from "../process/ProviderResponseLineLimit.js";

/** Callbacks for one newline-delimited Ghidra response stream. */
export interface GhidraResponseBufferOptions {
  readonly onLine: (line: string) => void;
  readonly onOverflow: (error: ProviderResponseLineLimitError) => void;
}

/** Splits fragmented UTF-8 socket data into response lines. */
export class GhidraResponseBuffer {
  readonly #options: GhidraResponseBufferOptions;
  #buffer = "";
  #fragments: string[] = [];
  #fragmentUnits = 0;

  constructor(options: GhidraResponseBufferOptions) {
    this.#options = options;
  }

  /** Consume one decoded socket chunk. */
  push(chunk: string): void {
    const pending = this.#buffer.length + this.#fragmentUnits + chunk.length;
    // Joining past the runtime string limit throws outside any error handler.
    if (pending > constants.MAX_STRING_LENGTH) {
      this.reset();
      this.#options.onOverflow(
        new ProviderResponseLineLimitError("Ghidra", pending),
      );
      return;
    }
    this.#fragments.push(chunk);
    this.#fragmentUnits += chunk.length;
    if (!chunk.includes("\n")) return;
    this.#buffer += this.#fragments.join("");
    this.#fragments = [];
    this.#fragmentUnits = 0;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const encodedLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const line = encodedLine.trim();
      if (line.length > 0) this.#options.onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  /** Drop any incomplete line when a session closes. */
  reset(): void {
    this.#buffer = "";
    this.#fragments = [];
    this.#fragmentUnits = 0;
  }
}
