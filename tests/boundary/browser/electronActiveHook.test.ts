import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { electronActiveTimelineEventSchema } from "../../../src/domain/javascript/electronActiveObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const temporary: string[] = [];

const electronModuleSource = `const { EventEmitter } = require("node:events");
const app = new EventEmitter();
app.isReady = () => true;
app.relaunch = () => undefined;
app.setAsDefaultProtocolClient = () => true;
app.setLoginItemSettings = () => undefined;
const ipcMain = new EventEmitter();
ipcMain.handlers = new Map();
ipcMain.handle = (channel, listener) => ipcMain.handlers.set(channel, listener);
const ipcRenderer = {
  send: () => undefined,
  sendSync: () => "ok",
  invoke: () => Promise.resolve("ok"),
  postMessage: () => undefined,
};
class WebContents extends EventEmitter {
  constructor() {
    super();
    this.id = 12;
    this.session = sessionModule.fromPartition("web-contents");
    app.emit("web-contents-created", {}, this);
  }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  loadDataURL() { return Promise.resolve(); }
  send() { return undefined; }
  postMessage() { return undefined; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; return undefined; }
}
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = 3;
    this.webContents = new WebContents();
    this.options = options;
    this.webContents.getLastWebPreferences = () => options.webPreferences;
    app.emit("browser-window-created", {}, this);
  }
}
const utilityProcess = {
  fork: () => {
    const child = new EventEmitter();
    child.pid = 44;
    child.postMessage = () => undefined;
    return child;
  },
};
globalThis.__nativeShellCalls = [];
const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(),
  showItemInFolder: (path) => { globalThis.__nativeShellCalls.push(["showItemInFolder", path]); },
  writeShortcutLink: (path) => { globalThis.__nativeShellCalls.push(["writeShortcutLink", path]); return true; },
};
const createSession = () => {
  const value = new EventEmitter();
  value.setPermissionRequestHandler = (handler) => { value.permissionRequestHandler = handler; };
  value.setPermissionCheckHandler = (handler) => { value.permissionCheckHandler = handler; };
  value.setCertificateVerifyProc = () => undefined;
  app.emit("session-created", value);
  return value;
};
const session = createSession();
const sessions = new Map();
const sessionModule = {
  defaultSession: session,
  fromPartition(partition) {
    if (!sessions.has(partition)) sessions.set(partition, createSession());
    return sessions.get(partition);
  },
  fromPath(path) { return this.fromPartition(path); },
};
const contextBridge = {
  exposeInMainWorld: () => undefined,
  exposeInIsolatedWorld: () => undefined,
};
module.exports = {
  app,
  get BrowserWindow() { return BrowserWindow; },
  contextBridge,
  ipcMain,
  ipcRenderer,
  session: sessionModule,
  shell,
  utilityProcess,
};
`;

const activeCaptureSource = `(async () => {
const electron = require("electron");
const window = new electron.BrowserWindow({ webPreferences: { preload: "/approved/preload.js" } });
const channel = "x".repeat(2048);
electron.ipcMain.handle(channel, async () => ({ ok: true }));
await electron.ipcMain.handlers.get(channel)({ sender: { id: 9 }, senderFrame: { routingId: 7 } }, ...Array.from({ length: 40 }, () => ({ value: true })));
window.webContents.send("main-to-renderer", { value: true });
window.webContents.emit("render-process-gone", { reason: "crashed" });
const longEventName = "l".repeat(2048);
window.webContents.emit(longEventName);
const utility = electron.utilityProcess.fork("utility.js");
utility.emit("message", { data: { value: true } });
utility.postMessage({ value: true });
electron.session.defaultSession.emit("will-download", window.webContents, { cancel() {} });
electron.session.fromPartition("persist:custom").emit("will-download", window.webContents, { cancel() {} });
const defaultPopupDecision = window.webContents.windowOpenHandler({ url: "https://default-popup.invalid" });
window.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
const popupDecision = window.webContents.windowOpenHandler({ url: "https://popup.invalid" });
electron.shell.openExternal("https://example.invalid").catch(() => undefined);
electron.app.relaunch();
electron.contextBridge.exposeInMainWorld("api", { value: true });
window.webContents.loadURL("https://example.invalid").catch(() => undefined);
for (let index = 0; index < 6000; index++) electron.app.relaunch();
electron.ipcRenderer.send("x".repeat(9 * 1024 * 1024));
electron.app.emit("r".repeat(9 * 1024 * 1024));
const manyArguments = Array(30_000).fill(true);
for (let index = 0; index < 8; index++) electron.ipcRenderer.send("shape-budget", ...manyArguments);
try { process.dlopen({}, "/missing/native.node"); } catch {}
const firstSnapshot = globalThis.__reaElectronActiveSnapshot();
const firstIpc = firstSnapshot.events.find((event) => event.kind === "main-handler-invocation");
if (firstIpc) { firstIpc.channel = "mutated"; firstIpc.argument_shapes.push("mutated"); }
firstSnapshot.events.length = 0;
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({ snapshot, default_popup_decision: defaultPopupDecision, popup_decision: popupDecision }) + "\\n");
})();
`;

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

it("retains active hook evidence within its event-retention budget", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "exercise.cjs");
  await writeFile(script, activeCaptureSource);
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly default_popup_decision: { readonly action: string };
    readonly popup_decision: { readonly action: string };
    readonly snapshot: {
      readonly hook_error: boolean;
      readonly events: readonly Record<string, unknown>[];
      readonly observed: number;
      readonly retained: number;
      readonly dropped: number;
      readonly dropped_ipc: number;
      readonly dropped_runtime: number;
      readonly retention_budget_bytes: number;
    };
  };
  const { snapshot } = result;
  expect(
    electronActiveTimelineEventSchema.array().parse(snapshot.events),
  ).toHaveLength(snapshot.retained);

  expect(snapshot.hook_error).toBe(false);
  expect(snapshot.events).toHaveLength(snapshot.retained);
  expect(snapshot.observed).toBe(snapshot.retained + snapshot.dropped);
  expect(snapshot.observed).toBeGreaterThan(5_000);
  expect(snapshot.dropped_ipc).toBeGreaterThanOrEqual(2);
  expect(snapshot.dropped_runtime).toBe(1);
  expect(snapshot.dropped).toBe(
    snapshot.dropped_ipc + snapshot.dropped_runtime,
  );
  expect(
    snapshot.events.some(
      (event) =>
        event.kind === "ipc-renderer-send" &&
        Array.isArray(event.argument_shapes) &&
        event.argument_shapes.length === 30_000,
    ),
  ).toBe(true);
  expect(
    Buffer.byteLength(JSON.stringify(snapshot), "utf8"),
  ).toBeLessThanOrEqual(snapshot.retention_budget_bytes);
  const sequences = snapshot.events.map((event) => event.sequence as number);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "window-lifecycle", event: "created" }),
      expect.objectContaining({ kind: "preload", event: "configured" }),
      expect.objectContaining({ kind: "shell-attempt", phase: "blocked" }),
      expect.objectContaining({ kind: "updater", phase: "blocked" }),
      expect.objectContaining({ kind: "native-addon" }),
      expect.objectContaining({ kind: "popup-attempt", phase: "blocked" }),
    ]),
  );
  expect(result.default_popup_decision).toEqual({ action: "deny" });
  expect(result.popup_decision).toEqual({ action: "deny" });
  expect(
    snapshot.events.filter(
      (event) => event.event === "loadURL" && event.phase === "attempted",
    ),
  ).toHaveLength(1);
  expect(
    snapshot.events.find((event) => event.event === "render-process-gone"),
  ).toMatchObject({ sender: "window:3" });
  expect(
    snapshot.events.filter(
      (event) => event.kind === "download" && event.phase === "blocked",
    ),
  ).toHaveLength(2);
  const ipc = snapshot.events.find(
    (event) => event.kind === "main-handler-invocation",
  );
  expect(ipc).toMatchObject({
    correlation_id: expect.stringMatching(/^capture:\d+:\d+$/u),
    direction: "renderer-to-main",
    sender: "webContents:9",
    frame: "frame:7",
  });
  expect(ipc?.channel).toBe("x".repeat(2_048));
  expect(ipc?.argument_shapes).toHaveLength(40);
  expect(snapshot.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "web-contents-lifecycle",
        event: "l".repeat(2048),
      }),
    ]),
  );
});

it("blocks synchronous shell effects with their native return contracts and retains argument shapes only", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-shell-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "shell.cjs");
  await writeFile(
    script,
    `const { shell } = require("electron");
const revealed = shell.showItemInFolder("/host/secret-folder/file.txt");
const written = shell.writeShortcutLink("C:\\\\Users\\\\host\\\\app.lnk", "create", { target: "C:\\\\payload.exe" });
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({
  revealed: revealed === undefined ? "undefined" : revealed,
  written,
  native_calls: globalThis.__nativeShellCalls,
  snapshot,
}) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(execution.stdout.trim()) as {
    readonly revealed: string;
    readonly written: boolean;
    readonly native_calls: readonly unknown[];
    readonly snapshot: {
      readonly hook_error: boolean;
      readonly events: readonly Record<string, unknown>[];
    };
  };
  expect(result.revealed).toBe("undefined");
  expect(result.written).toBe(false);
  expect(result.native_calls).toEqual([]);
  expect(result.snapshot.hook_error).toBe(false);
  const attempts = result.snapshot.events.filter(
    (event) => event.kind === "shell-attempt",
  );
  expect(attempts).toEqual([
    expect.objectContaining({
      event: "showItemInFolder",
      phase: "blocked",
      argument_shapes: ["string"],
    }),
    expect.objectContaining({
      event: "writeShortcutLink",
      phase: "blocked",
      argument_shapes: ["string", "string", "object"],
    }),
  ]);
  expect(JSON.stringify(result.snapshot)).not.toContain("secret-folder");
  expect(JSON.stringify(result.snapshot)).not.toContain("payload.exe");
  electronActiveTimelineEventSchema.array().parse(result.snapshot.events);
});

it("classifies a dropped browser preload as preload configuration at capture", async () => {
  const root = await createTestTempDirectory(
    "rea-electron-hook-browser-preload-",
  );
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "browser-preload.cjs");
  await writeFile(
    script,
    `Object.defineProperty(process, "type", { value: "browser" });
const electron = require("electron");
new electron.BrowserWindow({ webPreferences: { preload: "p".repeat(6 * 1024 * 1024) } });
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify(snapshot) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const snapshot = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly dropped_event_families: readonly {
      readonly family: string;
      readonly count: number;
    }[];
    readonly dropped_event_roles: readonly {
      readonly role: string;
      readonly count: number;
    }[];
  };
  expect(snapshot.dropped_event_families).toContainEqual({
    family: "preload-configuration",
    count: 1,
  });
  expect(snapshot.dropped_event_roles).toContainEqual({
    role: "browser",
    count: 1,
  });
});

it("records each child process launch once, including synchronous variants", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-child-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "child-processes.cjs");
  await writeFile(
    script,
    `const { exec, execFileSync, execSync, spawnSync } = require("node:child_process");
const node = process.execPath;
exec(JSON.stringify(node) + ' -e ""', () => {
  execSync(JSON.stringify(node) + ' -e ""');
  spawnSync(node, ["-e", ""]);
  execFileSync(node, ["-e", ""]);
  try { execFileSync(node, ["-e", "process.exit(3)"]); } catch {}
  const missing = spawnSync(require("node:path").join(process.cwd(), "missing-executable"));
  const timedOut = spawnSync(node, ["-e", "setInterval(() => {}, 1000)"], { timeout: 50 });
  if (missing.error?.code !== "ENOENT" || timedOut.error?.code !== "ETIMEDOUT") throw new Error("spawnSync errors were not preserved");
  process.stdout.write(JSON.stringify(globalThis.__reaElectronActiveSnapshot()) + "\\n");
});
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const snapshot = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly events: readonly {
      readonly kind: string;
      readonly event: string;
      readonly phase: string;
      readonly error: boolean;
    }[];
  };
  const launches = (phase: string) =>
    snapshot.events
      .filter(
        (event) =>
          event.kind === "process-lifecycle" &&
          event.event.startsWith("child.") &&
          event.phase === phase,
      )
      .map(({ event }) => event);
  const launched = [
    "child.exec",
    "child.execSync",
    "child.spawnSync",
    "child.execFileSync",
    "child.execFileSync",
    "child.spawnSync",
    "child.spawnSync",
  ];
  expect(launches("attempted")).toEqual(launched);
  expect(launches("completed")).toEqual(launched.slice(0, 4));
  expect(launches("failed")).toEqual([
    "child.execFileSync",
    "child.spawnSync",
    "child.spawnSync",
  ]);
  expect(
    snapshot.events.filter(
      ({ event, phase }) => event === "child.spawnSync" && phase === "failed",
    ),
  ).toMatchObject([{ error: true }, { error: true }]);
});

it("denies permissions on sessions whose application never installs a handler", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-permissions-");
  temporary.push(root);
  await writeElectronFixture(root);
  const script = join(root, "permissions.cjs");
  await writeFile(
    script,
    `const { EventEmitter } = require("node:events");
const electron = require("electron");
const createNativeSession = () => {
  const value = new EventEmitter();
  value.setPermissionRequestHandler = (handler) => { value.permissionRequestHandler = handler; };
  value.setPermissionCheckHandler = (handler) => { value.permissionCheckHandler = handler; };
  return value;
};
const decide = (session) => {
  let requested = null;
  session.permissionRequestHandler?.({ id: 5 }, "media", (granted) => { requested = granted; });
  return { requested, checked: session.permissionCheckHandler?.({ id: 5 }, "media") ?? null };
};
const createdSession = createNativeSession();
electron.app.emit("session-created", createdSession);
const contentsSession = createNativeSession();
electron.app.emit("session-created", contentsSession);
const webContents = new EventEmitter();
webContents.id = 21;
webContents.session = contentsSession;
webContents.setWindowOpenHandler = (handler) => { webContents.windowOpenHandler = handler; };
electron.app.emit("web-contents-created", {}, webContents);
const decisions = {
  default_session: decide(electron.session.defaultSession),
  partition_session: decide(electron.session.fromPartition("persist:custom")),
  path_session: decide(electron.session.fromPath("/custom/path")),
  created_session: decide(createdSession),
  web_contents_session: decide(contentsSession),
};
const popup = webContents.windowOpenHandler({ url: "https://popup.invalid" });
const snapshot = globalThis.__reaElectronActiveSnapshot();
process.stdout.write(JSON.stringify({ decisions, popup, snapshot }) + "\\n");
`,
  );
  const execution = await runNode(script, root);
  expect(execution.code, execution.stderr).toBe(0);
  const result = JSON.parse(
    execution.stdout.trim().split("\n").at(-1) ?? "null",
  ) as {
    readonly decisions: Record<
      string,
      { readonly requested: boolean | null; readonly checked: boolean | null }
    >;
    readonly popup: { readonly action: string };
    readonly snapshot: {
      readonly events: readonly Record<string, unknown>[];
    };
  };

  const denied = { requested: false, checked: false };
  expect(result.decisions).toEqual({
    default_session: denied,
    partition_session: denied,
    path_session: denied,
    created_session: denied,
    web_contents_session: denied,
  });
  expect(result.popup).toEqual({ action: "deny" });
  for (const event of ["permission-request", "permission-check"])
    expect(
      result.snapshot.events.filter(
        (recorded) =>
          recorded.event === event &&
          recorded.kind === "permission" &&
          recorded.phase === "blocked",
      ),
    ).toHaveLength(5);
});

it("isolates hook and exercise from ancestor Electron packages", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-ancestor-");
  temporary.push(root);
  await writeElectronFixture(root, 'module.exports = "/ambient/Electron";');
  const ambientHook = await stageHook(join(root, "producer", "scripts"));
  expect(createRequire(ambientHook)("electron")).toBe("/ambient/Electron");

  const fixture = join(root, "fixture");
  await writeElectronFixture(fixture);
  const script = join(fixture, "exercise.cjs");
  await writeFile(
    script,
    `const { BrowserWindow } = require("electron");
const window = new BrowserWindow({ webPreferences: {} });
process.stdout.write(JSON.stringify({
  hook_error: globalThis.__reaElectronActiveSnapshot().hook_error,
  window_open_handler: typeof window.webContents.windowOpenHandler,
}) + "\\n");
`,
  );
  const result = await runNode(script, fixture, ambientHook);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    hook_error: false,
    window_open_handler: "function",
  });
});

it("preserves fatal process termination after recording uncaught exceptions", async () => {
  const root = await createTestTempDirectory("rea-electron-hook-fatal-");
  temporary.push(root);
  await writeElectronFixture(
    root,
    'throw new Error("controlled Electron unavailable");',
  );
  const script = join(root, "fatal.cjs");
  await writeFile(
    script,
    'process.stdout.write(String(globalThis.__reaElectronActiveSnapshot().hook_error) + "\\n");\nthrow new Error("fatal-hook-secret");\n',
  );
  const result = await runNode(script, root);

  expect(result.code).not.toBe(0);
  expect(result.stdout.trim()).toBe("true");
  expect(result.stderr).toContain("fatal-hook-secret");
});

const writeElectronFixture = async (
  root: string,
  source = electronModuleSource,
) => {
  const directory = join(root, "node_modules", "electron");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "electron", main: "index.cjs" }),
  );
  await writeFile(join(directory, "index.cjs"), source);
};

const stageHook = async (
  root: string,
  source = fileURLToPath(
    new URL("../../../scripts/electron-active-hook.cjs", import.meta.url),
  ),
) => {
  await mkdir(root, { recursive: true });
  const hook = join(root, "electron-active-hook.cjs");
  await Promise.all([
    copyFile(source, hook),
    copyFile(
      join(dirname(source), "electron-active-hook-boundaries.cjs"),
      join(root, "electron-active-hook-boundaries.cjs"),
    ),
  ]);
  return hook;
};

const runNode = async (
  script: string,
  root: string,
  sourceHook?: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> => {
  const hook = await stageHook(root, sourceHook);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-r", hook, script], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
};
