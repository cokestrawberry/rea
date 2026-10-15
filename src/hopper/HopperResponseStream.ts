import { ProviderResponseLines } from "../process/ProviderResponseLines.js";

import { ProviderResponseLineLimitError } from "../process/ProviderResponseLineLimit.js";
import {
  parseBridgeMessageLine,
  type HopperBridgeMessage,
} from "./protocol.js";

export interface HopperResponseStreamOptions {
  readonly accept: (message: HopperBridgeMessage) => boolean;
  readonly hasQueued: (id: number) => boolean;
  readonly nextRequestId: () => number;
  readonly abort: (message: string, cause?: Error) => void;
  readonly overflow: (error: ProviderResponseLineLimitError) => void;
}

/** Incrementally validates Hopper NDJSON response frames. */
export class HopperResponseStream {
  readonly #lines: ProviderResponseLines;

  constructor(readonly options: HopperResponseStreamOptions) {
    this.#lines = new ProviderResponseLines(
      "Hopper",
      (line) => this.#acceptLine(line),
      options.overflow,
    );
  }

  push(chunk: string): void {
    this.#lines.push(chunk);
  }

  reset(): void {
    this.#lines.reset();
  }

  #acceptLine(line: string): boolean {
    const parsed = parseBridgeMessageLine(line);
    if (!parsed.ok) {
      this.options.abort(parsed.error.message, parsed.error);
      return false;
    }
    if (this.options.accept(parsed.value)) return true;
    if (
      parsed.value.id >= this.options.nextRequestId() ||
      this.options.hasQueued(parsed.value.id)
    ) {
      this.options.abort("Hopper returned an unknown response id");
      return false;
    }
    return true;
  }
}
