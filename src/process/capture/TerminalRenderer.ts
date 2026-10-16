import { createRequire } from "node:module";
import type { TerminalRetention } from "../../domain/process/processCaptureCoverage.js";

import type {
  RecordProcessCaptureEvent,
  RenderedTerminalFrame,
} from "../../domain/process/processCapture.js";

const require = createRequire(import.meta.url);
// SAFETY: both pinned xterm packages publish CommonJS at runtime and matching declarations.
const HeadlessPackage =
  require("@xterm/headless") as typeof import("@xterm/headless");
// SAFETY: the addon package is pinned with the compatible headless xterm release.
const SerializePackage =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const TRAILING_SPACES = / +$/u;

interface TerminalRendererOptions {
  readonly columns: number;
  readonly rows: number;
  readonly scrollback: number;
  readonly maxBytes: number;
  readonly normalize: (
    value: string,
    maxBytes: number,
    onOmitted?: (bytes: number) => void,
  ) => string | undefined;
  readonly recordEvent?: RecordProcessCaptureEvent;
}

/**
 * Owns one headless terminal and serializes writes into deterministic frames.
 * Reconstructs bounded terminal states while raw PTY chunks remain authoritative.
 *
 * Rendered frames answer what an operator saw after control-sequence handling;
 * raw frames preserve byte/chunk differences that can render identically.
 * Comparisons retain both because neither representation subsumes the other.
 */
export class TerminalRenderer {
  readonly #terminal: InstanceType<typeof HeadlessPackage.Terminal>;
  readonly #serializeAddon = new SerializePackage.SerializeAddon();
  readonly #frames: RenderedTerminalFrame[] = [];
  #pending: Promise<void> = Promise.resolve();
  #capturedBytes = 0;
  #observedBytes = 0;
  #observedFrames = 0;
  #truncated = false;

  constructor(private readonly options: TerminalRendererOptions) {
    this.#terminal = new HeadlessPackage.Terminal({
      allowProposedApi: true,
      cols: options.columns,
      rows: options.rows,
      scrollback: options.scrollback,
    });
    this.#terminal.loadAddon(this.#serializeAddon);
  }

  /** Queue one PTY chunk and capture state only after xterm has parsed it. */
  write(data: string, atMs: number): void {
    this.#queue(
      () =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          this.#terminal.write(data, () => {
            try {
              this.#capture(atMs);
              resolveWrite();
            } catch (error) {
              rejectWrite(error);
            }
          });
        }),
    );
  }

  /** Queue a terminal resize after every preceding write. */
  resize(columns: number, rows: number, atMs: number): void {
    this.#queue(() => {
      this.#terminal.resize(columns, rows);
      this.#capture(atMs);
    });
  }

  /** Await all queued parsing and return immutable rendered observations. */
  async frames(): Promise<readonly RenderedTerminalFrame[]> {
    await this.#pending;
    return structuredClone(this.#frames);
  }

  /** Whether a rendered observation exceeded its independent capture budget. */
  truncated(): boolean {
    return this.#truncated;
  }

  /** Budget accounting after awaiting queued writes with frames(). */
  retention(): TerminalRetention {
    return {
      budget_bytes: this.options.maxBytes,
      observed_bytes: this.#observedBytes,
      retained_bytes: this.#capturedBytes,
      observed_frames: this.#observedFrames,
      retained_frames: this.#frames.length,
    };
  }

  /** Release addon and terminal resources after all writes settle. */
  async dispose(): Promise<void> {
    // frames() owns observation failures; cleanup reports only disposal failures.
    await this.#pending.catch(() => undefined);
    // xterm owns and disposes every addon loaded through loadAddon().
    this.#terminal.dispose();
  }

  #queue(operation: () => void | Promise<void>): void {
    this.#pending = this.#pending.then(operation);
    // PTY callbacks can fail before capture completion awaits frames(). Keep
    // the original rejection observable there without an unhandled rejection.
    void this.#pending.catch(() => undefined);
  }

  #capture(atMs: number): void {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    let remainingBytes = this.options.maxBytes - this.#capturedBytes;
    this.#observedFrames += 1;
    const omit = (bytes: number): void => {
      this.#observedBytes +=
        this.options.maxBytes - this.#capturedBytes - remainingBytes + bytes;
      this.#truncated = true;
    };
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      // Trailing blank cells carry no information beyond `columns`; dropping
      // them keeps sparse screens from costing a full row per blank line.
      const normalized = this.options.normalize(
        (line?.translateToString(false, 0, this.#terminal.cols) ?? "").padEnd(
          this.#terminal.cols,
          " ",
        ),
        remainingBytes + this.#terminal.cols * 3,
        omit,
      );
      if (normalized === undefined) return;
      const text = normalized.replace(TRAILING_SPACES, "");
      if (Buffer.byteLength(text) > remainingBytes) {
        omit(Buffer.byteLength(text));
        return;
      }
      remainingBytes -= Buffer.byteLength(text);
      lines.push(text);
    }
    const serializedState = this.options.normalize(
      this.#serializeAddon.serialize(),
      remainingBytes,
      omit,
    );
    if (serializedState === undefined) return;
    const bytes =
      Buffer.byteLength(serializedState) +
      lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
    this.#observedBytes += bytes;
    if (this.#capturedBytes + bytes > this.options.maxBytes) {
      this.#truncated = true;
      return;
    }
    this.#capturedBytes += bytes;
    const sequence = this.#frames.length;
    this.#frames.push({
      sequence,
      at_ms: atMs,
      columns: this.#terminal.cols,
      rows: this.#terminal.rows,
      cursor_x: buffer.cursorX,
      cursor_y: buffer.cursorY,
      active_buffer: buffer.type,
      lines,
      serialized_state: serializedState,
    });
    this.options.recordEvent?.("rendered_frames", sequence);
  }
}
