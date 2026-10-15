import { isIP } from "node:net";
import { constants as bufferConstants } from "node:buffer";

import type { ProcessScenario } from "../../domain/process/processScenario.js";

import type { ProcessSample } from "../../domain/process/processCapture.js";

export interface ProcessTextNormalizer {
  (value: string): string;
  (
    value: string,
    maxBytes: number,
    onOmitted?: (bytes: number) => void,
  ): string | undefined;
}
/** Bucket one elapsed process-capture timestamp under scenario normalization. */
export const normalizeProcessElapsedTime = (
  elapsedMs: number,
  timeBucketMs: number,
): number => Math.floor(elapsedMs / timeBucketMs) * timeBucketMs;

/** Prepare capture-local matchers while retaining a live terminal PID lookup. */
export const createProcessTextNormalizer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number | (() => number),
): ProcessTextNormalizer => {
  const normalizePaths = scenario.normalization.paths
    ? createPathNormalizer(scenario, temporaryRoot)
    : (value: string): string => value;
  let previousPid: number | undefined;
  let normalizePids = (value: string): string => value;
  const normalize = (
    value: string,
    maxBytes = Infinity,
    onOmitted?: (bytes: number) => void,
  ): string | undefined => {
    let normalized = normalizePaths(value);
    if (scenario.normalization.ports)
      normalized = normalizePortTokens(normalized);
    if (scenario.normalization.pids) {
      const currentPid = typeof pid === "number" ? pid : pid();
      if (currentPid !== previousPid) {
        previousPid = currentPid;
        normalizePids = createPidNormalizer([currentPid]);
      }
      normalized = normalizePids(normalized);
    }
    if (Buffer.byteLength(normalized) > maxBytes) {
      onOmitted?.(Buffer.byteLength(normalized));
      return undefined;
    }
    for (const pattern of scenario.normalization.patterns) {
      const size = literalReplacementSize(
        normalized,
        pattern.pattern,
        pattern.replacement,
      );
      if (
        size.bytes > maxBytes ||
        (maxBytes !== Infinity &&
          size.length > bufferConstants.MAX_STRING_LENGTH)
      ) {
        onOmitted?.(size.bytes);
        return undefined;
      }
      normalized = normalized.replaceAll(
        pattern.pattern,
        () => pattern.replacement,
      );
    }
    return normalized;
  };
  return normalize as ProcessTextNormalizer;
};

const literalReplacementSize = (
  value: string,
  pattern: string,
  replacement: string,
): { readonly bytes: number; readonly length: number } => {
  let bytes = 0;
  let length = 0;
  let trailingHighSurrogate = false;
  const replacementBytes = Buffer.byteLength(replacement);
  const append = (text: string, textBytes = Buffer.byteLength(text)): void => {
    if (text.length === 0) return;
    bytes += textBytes;
    const first = text.charCodeAt(0);
    if (trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
    const last = text.charCodeAt(text.length - 1);
    trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
    length += text.length;
  };
  let offset = 0;
  for (;;) {
    const match = pattern === "" ? offset : value.indexOf(pattern, offset);
    if (match === -1 || match > value.length) break;
    append(value.slice(offset, match));
    append(replacement, replacementBytes);
    offset = match + pattern.length;
    if (pattern === "") {
      append(value.slice(offset, offset + 1));
      offset += 1;
    }
  }
  append(value.slice(offset));
  return { bytes, length };
};

/** Normalize one payload when its caller does not retain a capture-local matcher. */
export const normalizeProcessText = (
  value: string,
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number,
): string => createProcessTextNormalizer(scenario, temporaryRoot, pid)(value);

/** Match original paths once, preferring the most specific selected identity. */
const createPathNormalizer = (
  scenario: ProcessScenario,
  temporaryRoot: string,
): ((value: string) => string) => {
  const aliases = new Map<string, string>();
  const selected: readonly (readonly [string, string])[] = [
    [temporaryRoot, "<temporary-root>"],
    [scenario.working_directory, "<working-directory>"],
    [scenario.executable, "<executable>"],
    ...scenario.filesystem_observation_paths.map(
      (root, index): readonly [string, string] => [
        root,
        `<filesystem-root-${String(index)}>`,
      ],
    ),
  ];
  for (const [path, alias] of selected)
    if (path !== "" && !aliases.has(path)) aliases.set(path, alias);
  const paths = [...aliases.keys()].sort(
    (left, right) => right.length - left.length,
  );
  if (paths.length === 0) return (value) => value;
  const pattern = paths
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  const matcher = new RegExp(pattern, "gu");
  return (value) => value.replace(matcher, (path) => aliases.get(path) ?? path);
};

// A port may end a sentence, but a period followed by a letter, digit, or
// underscore in any script continues a decimal, version, or host name and is
// not a port boundary.
// PTY chunks are normalized independently, so a period that ends the chunk
// stays unnormalized: its continuation may arrive in the next chunk.
const normalizePortTokens = (value: string): string => {
  const endpointNormalized = value.replaceAll(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'<>]+|\blocalhost|\b(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:.%]+\]):(\d{1,5})(?![\p{L}\p{N}_@:]|\.(?:[\p{L}\p{N}_]|$))/giu,
    (match: string, endpoint: string, port: string) => {
      if (Number(port) > 65_535) return match;
      const isEndpoint = endpoint.includes("://")
        ? URL.canParse(`${endpoint}:${port}`)
        : endpoint.toLowerCase() === "localhost" ||
          isIP(endpoint.replace(/^\[|\]$/gu, "")) !== 0;
      return isEndpoint ? `${endpoint}:<port>` : match;
    },
  );
  return endpointNormalized.replaceAll(
    /(\b(?:port|tcp_port|udp_port|listen)\b["']?\s*[:=]\s*)(\d{1,5})(?![\p{L}\p{N}_]|\.(?:[\p{L}\p{N}_]|$))/giu,
    (match: string, prefix: string, port: string) =>
      Number(port) <= 65_535 ? `${prefix}<port>` : match,
  );
};

/** Project sampled observations under the caller-selected normalization rules. */
export const normalizeProcessSamples = (
  samples: readonly ProcessSample[],
  scenario: ProcessScenario,
  rootPid: number,
): readonly ProcessSample[] => {
  const identifiers = [
    rootPid,
    ...samples.flatMap((sample) => [
      sample.pid,
      sample.parent_pid,
      sample.process_group_id ?? 0,
      sample.session_id ?? 0,
    ]),
  ];
  const mapping = new Map<number, number>();
  for (const identifier of identifiers)
    if (identifier > 0 && !mapping.has(identifier))
      mapping.set(identifier, mapping.size + 1);
  const normalizeText = createProcessTextNormalizer(
    scenario,
    "<no-temporary-root>",
    rootPid,
  );
  const normalizeSamplePids = scenario.normalization.pids
    ? createPidNormalizer(identifiers)
    : undefined;
  const normalizeCommand = (command: string): string => {
    const normalized = normalizeText(command);
    const withNormalizedPids = normalizeSamplePids?.(normalized) ?? normalized;
    return withNormalizedPids.trim();
  };
  return samples.map((sample) => ({
    at_ms: normalizeProcessElapsedTime(
      sample.at_ms,
      scenario.normalization.time_bucket_ms,
    ),
    pid: scenario.normalization.pids
      ? (mapping.get(sample.pid) ?? 1)
      : sample.pid,
    parent_pid: scenario.normalization.pids
      ? (mapping.get(sample.parent_pid) ?? 0)
      : sample.parent_pid,
    process_group_id:
      !scenario.normalization.pids || sample.process_group_id === null
        ? sample.process_group_id
        : (mapping.get(sample.process_group_id) ?? 0),
    session_id:
      !scenario.normalization.pids || sample.session_id === null
        ? sample.session_id
        : (mapping.get(sample.session_id) ?? 0),
    command: normalizeCommand(sample.command),
  }));
};

const createPidNormalizer = (
  identifiers: readonly number[],
): ((value: string) => string) => {
  const tokens = [...new Set(identifiers)]
    .filter((identifier) => Number.isSafeInteger(identifier) && identifier > 0)
    .sort((left, right) => right - left)
    .map(String);
  if (tokens.length === 0) return (value) => value;
  const matcher = new RegExp(`(?<!\\d)(?:${tokens.join("|")})(?!\\d)`, "gu");
  return (value) => value.replace(matcher, "<pid>");
};
