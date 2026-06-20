import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CaptureScreenRegionInput,
  CaptureWindowInput,
  ClickMenuItemInput,
  ClickWindowInput,
  LaunchAppInput,
  ListWindowsInput,
  MoveMouseWindowInput,
  TypeTextInput,
  SendKeyInput,
  ReadClipboardInput,
  WriteClipboardInput,
  GetWindowStateInput,
  WaitForWindowInput
} from "./schemas.js";

export type WaitAndSuppressInput = {
  pid: number;
  processName?: string;
  existingHwnds?: string[];
  timeoutMs?: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
};

export type WindowInfo = {
  hwnd: string;
  title: string;
  pid: number;
  processName: string;
  className: string;
  rect: Rect;
  visible?: boolean;
  iconic?: boolean;
};

export type CaptureResult = {
  path: string;
  width: number;
  height: number;
  target: string;
  rect: Rect;
  timestamp: string;
};

export type ClickResult = {
  clicked: boolean
  target: string
  hwnd: string
  title: string
  pid: number
  button: "left" | "right" | "middle"
  doubleClick: boolean
  method: "post_message" | "native_menu_command"
  messageTarget?: {
    hwnd: string
    className: string
    client: boolean
    hitTest: number
    uiaInvoked: boolean
  }
  nativeMenu?: NativeMenuResult
  windowPoint: { x: number; y: number }
  screenPoint: { x: number; y: number }
  timestamp: string
}

export type MoveMouseResult = {
  moved: boolean
  target: string
  hwnd: string
  title: string
  pid: number
  method: "post_message"
  windowPoint: { x: number; y: number }
  screenPoint: { x: number; y: number }
  timestamp: string
}

export type ClickMenuItemResult = {
  clicked: boolean
  target: string
  hwnd: string
  title: string
  pid: number
  method: "native_menu_command"
  menuPath: NativeMenuResult[]
  commandId: number
  timestamp: string
}

export type TypeTextResult = {
  typed: boolean
  target: string
  hwnd: string
  title: string
  pid: number
  textLength: number
  skipped: string[]
  timestamp: string
}

export type SendKeyResult = {
  sent: boolean
  key: string
  modifiers: string[]
  target: string
  hwnd: string
  title: string
  pid: number
  timestamp: string
}

export type ReadClipboardResult = {
  available: boolean
  text: string
  length: number
  timestamp: string
}

export type WriteClipboardResult = {
  written: boolean
  length: number
  timestamp: string
}

export type WindowStateResult = WindowInfo & {
  visible: boolean
  minimized: boolean
  maximized: boolean
  foreground: boolean
  enabled: boolean
  topmost: boolean
  toolWindow: boolean
  layered: boolean
  clickThrough: boolean
  noActivate: boolean
  cloaked: boolean
  alpha: number
  style: string
  exStyle: string
  timestamp: string
}

export type WaitForWindowResult = {
  found: boolean
  mode: "appear" | "disappear"
  window: WindowInfo | null
  elapsedMs: number
  timeoutMs?: number
  timestamp: string
}

type WaitAndSuppressResult = {
  found: boolean
  window: WindowInfo | null
}

type NativeMenuResult = {
  index: number;
  text: string;
  normalizedText: string;
  commandId: number | null;
};

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runtimeRoot = sourceRoot.endsWith(`${path.sep}dist`) ? path.dirname(sourceRoot) : sourceRoot
const helperPath = path.join(runtimeRoot, "scripts", "win-capture.ps1")
const defaultOutputDir = path.join(runtimeRoot, "outputs")
const powershellCommand = findPowerShellCommand()

type HelperRequest =
  | { action: "list-windows"; filters?: ListWindowsInput }
  | { action: "capture-window"; target: Omit<CaptureWindowInput, "outputPath">; outputPath: string }
  | { action: "capture-screen-region"; region: CaptureScreenRegionInput["region"]; outputPath: string }
  | { action: "click-window"; target: ClickWindowInput }
  | { action: "move-mouse-window"; target: MoveMouseWindowInput }
  | { action: "click-menu-item"; target: ClickMenuItemInput }
  | { action: "type-text"; target: TypeTextInput }
  | { action: "send-key"; target: SendKeyInput }
  | { action: "minimize-window"; target: { hwnd: string } }
  | { action: "noactivate-minimize"; target: { hwnd: string; previousForegroundHwnd?: string } }
  | { action: "wait-and-suppress"; target: WaitAndSuppressInput }
  | { action: "read-clipboard"; target?: Record<string, unknown> }
  | { action: "write-clipboard"; target: WriteClipboardInput }
  | { action: "get-window-state"; target: GetWindowStateInput }
  | { action: "wait-for-window"; target: Omit<WaitForWindowInput, "timeoutMs" | "pollIntervalMs"> & { timeoutMs?: number; pollIntervalMs?: number } }

export function getDefaultOutputDir(): string {
  return defaultOutputDir
}

export async function typeText(input: TypeTextInput): Promise<TypeTextResult> {
  return runHelper<TypeTextResult>({ action: "type-text", target: input })
}

export async function sendKey(input: SendKeyInput): Promise<SendKeyResult> {
  return runHelper<SendKeyResult>({ action: "send-key", target: input })
}

export async function readClipboard(_input?: ReadClipboardInput): Promise<ReadClipboardResult> {
  return runHelper<ReadClipboardResult>({ action: "read-clipboard", target: {} })
}

export async function writeClipboard(input: WriteClipboardInput): Promise<WriteClipboardResult> {
  return runHelper<WriteClipboardResult>({ action: "write-clipboard", target: input })
}

export async function getWindowState(input: GetWindowStateInput): Promise<WindowStateResult> {
  return runHelper<WindowStateResult>({ action: "get-window-state", target: input })
}

export async function waitForWindow(input: WaitForWindowInput): Promise<WaitForWindowResult> {
  // Run in a SEPARATE PowerShell process (not the shared worker) so that a
  // long wait (up to 300 s) doesn't starve other MCP tool calls.  Using
  // async spawn (not spawnSync) keeps the Node event loop unblocked so
  // callers can schedule closeApp etc. in parallel.
  const timeoutMs = (input.timeoutMs ?? 30_000) + 5000;
  return runStandaloneHelper<WaitForWindowResult>(
    { action: "wait-for-window", target: input },
    timeoutMs,
    "wait_for_window"
  );
}

export async function ensureExecutablePath(exePath: string): Promise<void> {
  if (!path.isAbsolute(exePath)) {
    throw new Error("exePath must be an absolute path.");
  }

  if (path.extname(exePath).toLowerCase() !== ".exe") {
    throw new Error("exePath must point to a .exe file.");
  }

  try {
    await access(exePath, fsConstants.X_OK);
  } catch {
    await access(exePath, fsConstants.R_OK);
  }
}

export async function ensureOutputPath(outputPath?: string): Promise<string> {
  if (outputPath && !path.isAbsolute(outputPath)) {
    throw new Error("outputPath must be an absolute path when provided.");
  }

  const finalPath = outputPath ? path.resolve(outputPath) : path.join(defaultOutputDir, `${timestampForFile()}-${randomSuffix()}.png`);

  if (path.extname(finalPath).toLowerCase() !== ".png") {
    throw new Error("outputPath must end with .png.");
  }

  await mkdir(path.dirname(finalPath), { recursive: true });
  return finalPath;
}

export async function launchApp(input: LaunchAppInput): Promise<{ pid: number; window: WindowInfo | null }> {
  await ensureExecutablePath(input.exePath);
  const cwd = await ensureWorkingDirectory(input.cwd);
  const processName = path.basename(input.exePath, path.extname(input.exePath));
  const existingProcessWindows = input.waitForWindow ? await listWindows({ processName }) : [];
  const existingHwnds = new Set(existingProcessWindows.map((window) => window.hwnd));

  const child = await spawnApp(input, cwd);

  if (typeof child.pid !== "number") {
    throw new Error("Failed to start process.");
  }

  const exitState: { exited: boolean; code: number | null; signal: NodeJS.Signals | null } = {
    exited: false,
    code: null,
    signal: null
  };
  child.on("exit", (code, signal) => {
    exitState.exited = true;
    exitState.code = code;
    exitState.signal = signal;
  });

  if (!input.waitForWindow) {
    return { pid: child.pid, window: null };
  }

  let window: WindowInfo | null = null;
  let previousForegroundHwnd: string | undefined;
  let suppressRan = false;

  if (input.noActivate) {
    // Phase 1: wait-and-suppress via the shared worker (pre-warmed, zero
    // cold-start). Captures previous foreground internally, polls for the
    // first new window, pushes to HWND_BOTTOM, then sustains suppression
    // for min(8s, timeoutMs) to cover delayed self-activation.
    try {
      const suppressResult = await runHelper<WaitAndSuppressResult>(
        {
          action: "wait-and-suppress",
          target: {
            pid: child.pid,
            processName,
            existingHwnds: [...existingHwnds],
            timeoutMs: input.timeoutMs
          }
        }
      );
      suppressRan = true;
      if (suppressResult.found) {
        window = suppressResult.window;
      }
    } catch {
      // suppressRan stays false — fall through
    }
  }

  if (!window) {
    window = await pollForWindow(child.pid, processName, existingHwnds, input.timeoutMs, exitState);
  }

  // Phase 2: when Phase 1 timed out (app started slowly) but pollForWindow
  // found a window, fire a short suppression pass. The window is not in
  // existingHwnds (those were captured pre-spawn), so Wait-And-Suppress
  // will find it as "new", push it to HWND_BOTTOM, and sustain for 8s.
  if (input.noActivate && window && !suppressRan) {
    try {
      await runHelper<WaitAndSuppressResult>(
        {
          action: "wait-and-suppress",
          target: {
            pid: child.pid,
            processName,
            existingHwnds: [...existingHwnds],
            timeoutMs: 8000
          }
        }
      );
    } catch {
      // Best-effort
    }
  }

  if (window === null && exitState.exited) {
    throw new Error(`Process exited before a window appeared (pid=${child.pid}, code=${exitState.code}, signal=${exitState.signal ?? "none"}).`);
  }

  if (input.startMinimized && window) {
    try {
      await minimizeWindow(window.hwnd, input.noActivate, previousForegroundHwnd);
    } catch (error) {
      console.error(`startMinimized failed for hwnd ${window.hwnd}: ${formatSpawnError(error)}`);
    }
  }

  return { pid: child.pid, window };
}

export async function closeApp(pid: number): Promise<{ pid: number; closed: boolean }> {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    shell: false
  });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    throw new Error(message || `taskkill failed for pid ${pid}.`);
  }

  return { pid, closed: true };
}

export async function listWindows(filters: ListWindowsInput = {}): Promise<WindowInfo[]> {
  return runHelper<WindowInfo[]>({ action: "list-windows", filters });
}

export async function captureWindow(input: CaptureWindowInput): Promise<CaptureResult> {
  const outputPath = await ensureOutputPath(input.outputPath);
  const { outputPath: _outputPath, ...target } = input;
  // Capture runs in a SEPARATE PowerShell process (not the shared worker).
  // PrintWindow/CopyFromScreen can block synchronously on an unresponsive
  // target window (e.g. an Electron/Qt app that isn't pumping messages), and
  // when that happens on the shared worker it stalls the entire FIFO queue —
  // every subsequent MCP tool call (list_windows, click_window, ...) waits
  // behind it until the 90s kill switch trips. Client gateways typically 504
  // before that, surfacing as "input/output 0, status 504". Running capture
  // standalone isolates the stall: a hung capture dies alone at its own
  // (shorter) timeout and other tools keep working. Cost is ~1s cold start per
  // capture, which is negligible next to the cost of a wedged MCP server.
  return runStandaloneHelper<CaptureResult>(
    { action: "capture-window", target, outputPath },
    CAPTURE_TIMEOUT_MS,
    "capture_window"
  );
}

export async function captureScreenRegion(input: CaptureScreenRegionInput): Promise<CaptureResult> {
  const outputPath = await ensureOutputPath(input.outputPath);
  return runStandaloneHelper<CaptureResult>(
    { action: "capture-screen-region", region: input.region, outputPath },
    CAPTURE_TIMEOUT_MS,
    "capture_screen_region"
  );
}

export async function clickWindow(input: ClickWindowInput): Promise<ClickResult> {
  return runHelper<ClickResult>({ action: "click-window", target: input });
}

export async function moveMouseWindow(input: MoveMouseWindowInput): Promise<MoveMouseResult> {
  return runHelper<MoveMouseResult>({ action: "move-mouse-window", target: input });
}

export async function clickMenuItem(input: ClickMenuItemInput): Promise<ClickMenuItemResult> {
  return runHelper<ClickMenuItemResult>({ action: "click-menu-item", target: input });
}

async function pollForWindow(
  pid: number,
  processName: string,
  existingHwnds: Set<string>,
  timeoutMs: number,
  exitState?: { exited: boolean }
): Promise<WindowInfo | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (exitState?.exited) {
      return null;
    }

    const processWindows = await listWindows({ pid });
    if (processWindows.length > 0) {
      return processWindows[0]!;
    }

    const newNamedWindow = (await listWindows({ processName }))
      .find((window) => !existingHwnds.has(window.hwnd));
    if (newNamedWindow) {
      return newNamedWindow;
    }

    await delay(500);
  }

  return null;
}

async function ensureWorkingDirectory(cwd?: string): Promise<string | undefined> {
  if (!cwd) {
    return undefined;
  }

  if (!path.isAbsolute(cwd)) {
    throw new Error("cwd must be an absolute path when provided.");
  }

  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`cwd must be a directory: ${cwd}`);
  }

  return path.resolve(cwd);
}

async function spawnApp(input: LaunchAppInput, cwd?: string): Promise<ReturnType<typeof spawn>> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.exePath, input.args, {
      cwd,
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: false
    });
  } catch (error) {
    throw new Error(`Failed to start process: ${formatSpawnError(error)}`);
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  }).catch((error: unknown) => {
    throw new Error(`Failed to start process: ${formatSpawnError(error)}`);
  });

  child.on("error", (error: Error) => {
    console.error(`Child process error (pid=${child.pid ?? "unknown"}): ${error.message}`);
  });
  child.unref();
  return child;
}

// Hard timeout for a single request on the shared PowerShell worker.
//
// Must exceed the slowest request the schema can produce. The type_text
// schema (src/schemas.ts) caps estimated work at maxTypeTextEstimatedMs
// (55s), and PowerShell's Start-Sleep plus per-char overhead drifts a few
// seconds above the estimate at the limit. 90s gives comfortable headroom
// so a legitimately large type_text never trips the worker kill switch
// (which would also nuke any other queued requests on the same worker).
const HELPER_TIMEOUT_MS = 90000;

// Timeout for standalone capture requests (capture_window / capture_screen_region).
//
// Capture is fundamentally different from the other actions: it can block
// synchronously inside Win32 on an unresponsive target window — PrintWindow
// sends WM_PRINT and waits for the target to render, CopyFromScreen + focus
// restore waits on SetForegroundWindow. If the target's UI thread is stuck
// (loading, modal dialog, hung renderer), the call hangs indefinitely.
//
// Capture itself should complete in well under 5s in the normal case; 20s is
// a generous ceiling that still catches genuine hangs well before client
// gateways 504 (typically 30-60s). A timed-out capture is killed via
// taskkill /T /F in runStandaloneHelper, so it can't leak.
const CAPTURE_TIMEOUT_MS = 20000;

type WorkerResponseOk = { ok: true; result: unknown };
type WorkerResponseErr = { ok: false; error: string };
type WorkerResponse = WorkerResponseOk | WorkerResponseErr;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  action: string;
  timeout: ReturnType<typeof setTimeout>;
};

type Worker = {
  child: ReturnType<typeof spawn>;
  stdoutBuffer: string;
  stderrBuffer: string;
  queue: PendingRequest[];
  exited: boolean;
  killing: boolean;
};

let activeWorker: Worker | null = null;
let workerStarting: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (activeWorker && !activeWorker.exited) {
    return activeWorker;
  }
  if (workerStarting) {
    return workerStarting;
  }

  workerStarting = (async (): Promise<Worker> => {
    await access(helperPath, fsConstants.R_OK);

    const child = spawn(powershellCommand, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Worker"
    ], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.unref();

    const worker: Worker = {
      child,
      stdoutBuffer: "",
      stderrBuffer: "",
      queue: [],
      exited: false,
      killing: false
    };

    if (!child.stdout || !child.stderr || !child.stdin) {
      throw new Error("Failed to attach pipes to PowerShell worker.");
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);

    child.stdout.on("data", (chunk: string) => {
      worker.stdoutBuffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = worker.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = worker.stdoutBuffer.slice(0, newlineIndex).trim();
        worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;

        const pending = worker.queue.shift();
        if (!pending) {
          // Stray output without a pending request — log and drop.
          console.error(`PowerShell worker emitted unsolicited line: ${line}`);
          continue;
        }

        clearTimeout(pending.timeout);
        try {
          const response = JSON.parse(line) as WorkerResponse;
          if (response.ok) {
            pending.resolve(response.result);
          } else {
            pending.reject(new Error(response.error || `PowerShell helper failed (action=${pending.action}).`));
          }
        } catch (error) {
          pending.reject(new Error(
            `PowerShell helper returned invalid JSON (action=${pending.action}): ${(error as Error).message}\nline: ${line}`
          ));
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      worker.stderrBuffer += chunk;
      // Keep buffer bounded to avoid unbounded growth on a chatty worker.
      if (worker.stderrBuffer.length > 16384) {
        worker.stderrBuffer = worker.stderrBuffer.slice(-8192);
      }
    });

    const teardown = (reason: Error) => {
      worker.exited = true;
      const pending = worker.queue.splice(0);
      for (const req of pending) {
        clearTimeout(req.timeout);
        req.reject(reason);
      }
      if (activeWorker === worker) {
        activeWorker = null;
      }
    };

    child.on("close", (code, signal) => {
      const stderrTail = worker.stderrBuffer.trim();
      const reason = worker.killing
        ? new Error(`PowerShell helper was killed (action timed out).`)
        : new Error(
            `PowerShell helper exited unexpectedly (code=${code}, signal=${signal ?? "none"})${stderrTail ? `: ${stderrTail}` : ""}.`
          );
      teardown(reason);
    });

    child.on("error", (error: Error) => {
      teardown(new Error(`PowerShell helper error: ${error.message}`));
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    activeWorker = worker;
    return worker;
  })();

  try {
    return await workerStarting;
  } finally {
    workerStarting = null;
  }
}

function killWorker(worker: Worker, reason: string): void {
  if (worker.exited || worker.killing) return;
  worker.killing = true;
  if (typeof worker.child.pid === "number") {
    spawnSync("taskkill.exe", ["/PID", String(worker.child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true
    });
  } else {
    worker.child.kill("SIGKILL");
  }
  console.error(`PowerShell worker killed: ${reason}`);
}

function unrefStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream | null): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

async function runHelper<T>(request: HelperRequest): Promise<T> {
  const worker = await getWorker();

  if (worker.exited || !worker.child.stdin || worker.child.stdin.destroyed) {
    activeWorker = null;
    throw new Error(`PowerShell helper not available (action=${request.action}).`);
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = worker.queue.findIndex((req) => req.timeout === timeout);
      if (idx >= 0) {
        worker.queue.splice(idx, 1);
      }
      // The request order is broken once a request times out — restart the worker
      // so subsequent requests get correlated with their responses again.
      killWorker(worker, `action=${request.action} exceeded ${HELPER_TIMEOUT_MS}ms`);
      reject(new Error(`PowerShell helper timed out after ${HELPER_TIMEOUT_MS}ms (action=${request.action}).`));
    }, HELPER_TIMEOUT_MS);

    worker.queue.push({
      resolve: resolve as (value: unknown) => void,
      reject,
      action: request.action,
      timeout
    });

    const inputLine = `${JSON.stringify(request)}\n`;
    if (!worker.child.stdin!.write(inputLine)) {
      // Backpressure: wait for drain. The PS worker processes line-by-line so this
      // is rare in practice, but we still handle it for correctness.
      worker.child.stdin!.once("drain", () => undefined);
    }
  });
}

async function runStandaloneHelper<T>(request: HelperRequest, timeoutMs: number, label: string): Promise<T> {
  const requestJson = JSON.stringify(request);

  return new Promise<T>((resolve, reject) => {
    const child = spawn(powershellCommand, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath,
      "-InputJson", requestJson
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      if (typeof child.pid === "number") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          windowsHide: true
        });
      } else {
        child.kill();
      }
      finish(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    child.on("close", (code) => {
      finish(() => {
        const out = stdout.trim();
        if (code !== 0 || !out) {
          reject(new Error(`${label} failed (code=${code}): ${(stderr || "").trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(out) as T);
        } catch (err) {
          reject(new Error(`${label} returned invalid JSON: ${(err as Error).message}`));
        }
      });
    });

    child.on("error", (err) => {
      finish(() => {
        reject(err);
      });
    });
  });
}

export function shutdownHelper(): void {
  if (activeWorker && !activeWorker.exited) {
    try {
      activeWorker.child.stdin?.end();
    } catch {
      // ignore
    }
  }
  activeWorker = null;
  helperShutdowns.delete(shutdownHelper);
}

type HelperGlobal = typeof globalThis & {
  __screenshotToolHelperShutdowns?: Set<() => void>;
  __screenshotToolHelperCleanupRegistered?: boolean;
};

const helperGlobal = globalThis as HelperGlobal;
const helperShutdowns = helperGlobal.__screenshotToolHelperShutdowns ?? new Set<() => void>();
helperGlobal.__screenshotToolHelperShutdowns = helperShutdowns;
helperShutdowns.add(shutdownHelper);

if (!helperGlobal.__screenshotToolHelperCleanupRegistered) {
  helperGlobal.__screenshotToolHelperCleanupRegistered = true;
  process.once("beforeExit", shutdownAllHelpers);
  process.once("exit", shutdownAllHelpers);
}

function shutdownAllHelpers(): void {
  for (const shutdown of [...helperShutdowns]) {
    shutdown();
  }
}

function timestampForFile(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSpawnError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function findPowerShellCommand(): string {
  const pwsh = spawnSync("where.exe", ["pwsh.exe"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });

  return pwsh.status === 0 ? "pwsh.exe" : "powershell.exe";
}

function minimizeWindow(hwnd: string, noActivate = false, previousForegroundHwnd?: string): Promise<unknown> {
  const action = noActivate ? "noactivate-minimize" : "minimize-window";
  const target = noActivate && previousForegroundHwnd
    ? { hwnd, previousForegroundHwnd }
    : { hwnd };
  return runHelper({ action, target });
}
