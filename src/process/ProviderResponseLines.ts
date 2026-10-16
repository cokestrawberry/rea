import { constants } from "node:buffer";
import { ProviderResponseLineLimitError } from "./ProviderResponseLineLimit.js";

/** Own fragmented response lines and reject expansion before joining. */
export class ProviderResponseLines {
  #fragments: string[] = [];
  #units = 0;

  constructor(
    readonly provider: "Hopper" | "Ghidra",
    readonly onLine: (line: string) => boolean | void,
    readonly onOverflow: (error: ProviderResponseLineLimitError) => void,
  ) {}

  push(chunk: string): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      const units = this.#units + end - start;
      if (units > constants.MAX_STRING_LENGTH) {
        this.reset();
        this.onOverflow(
          new ProviderResponseLineLimitError(this.provider, units),
        );
        return;
      }
      this.#fragments.push(chunk.slice(start, end));
      this.#units = units;
      if (newline < 0) return;
      const line = this.#fragments.join("").trim();
      this.reset();
      if (line !== "" && this.onLine(line) === false) return;
      start = newline + 1;
    }
  }

  reset(): void {
    this.#fragments = [];
    this.#units = 0;
  }
}
