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
  SendKeyInput
} from "./schemas.js";

export type WaitAndSuppressInput = {
  pid: number;
  processName?: string;
  existingHwnds?: string[];
  previousForegroundHwnd?: string;
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
  | { action: "noactivate-minimize"; target: { hwnd: string } }
  | { action: "wait-and-suppress"; target: WaitAndSuppressInput }

export function getDefaultOutputDir(): string {
  return defaultOutputDir
}

export async function typeText(input: TypeTextInput): Promise<TypeTextResult> {
  return runHelper<TypeTextResult>({ action: "type-text", target: input })
}

export async function sendKey(input: SendKeyInput): Promise<SendKeyResult> {
  return runHelper<SendKeyResult>({ action: "send-key", target: input })
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

  if (input.noActivate) {
    // Capture the current foreground hwnd so we can restore it after
    // the new window briefly steals focus.
    const previousFgResult = spawnSync(powershellCommand, [
      "-NoProfile", "-Command",
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'; [FG]::GetForegroundWindow().ToInt64().ToString()`
    ], { encoding: "utf8", shell: false, windowsHide: true });
    const previousFgHwnd = previousFgResult.stdout.trim();

    // Use the atomic wait-and-suppress helper via a standalone PS process
    // (not the worker), because the Alt+keybd_event trick for restoring
    // the foreground window requires desktop access that the hidden worker
    // process does not have.
    try {
      const suppressInput = JSON.stringify({
        action: "wait-and-suppress",
        target: {
          pid: child.pid,
          processName,
          existingHwnds: [...existingHwnds],
          previousForegroundHwnd: previousFgHwnd,
          timeoutMs: input.timeoutMs
        }
      });
      const suppressResult = spawnSync(powershellCommand, [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath,
        "-InputJson", suppressInput
      ], { encoding: "utf8", shell: false, windowsHide: true, timeout: input.timeoutMs + 5000 });
      if (suppressResult.stdout) {
        const parsed = JSON.parse(suppressResult.stdout.trim()) as { found: boolean; window: WindowInfo | null };
        if (parsed.found) {
          window = parsed.window;
        }
      }
    } catch {
      // Fallback: try the normal waitForWindow path.
    }
  }

  if (!window) {
    window = await waitForWindow(child.pid, processName, existingHwnds, input.timeoutMs, exitState);
  }

  if (window === null && exitState.exited) {
    throw new Error(`Process exited before a window appeared (pid=${child.pid}, code=${exitState.code}, signal=${exitState.signal ?? "none"}).`);
  }

  if (input.startMinimized && window) {
    try {
      await minimizeWindow(window.hwnd, input.noActivate);
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
  return runHelper<CaptureResult>({ action: "capture-window", target, outputPath });
}

export async function captureScreenRegion(input: CaptureScreenRegionInput): Promise<CaptureResult> {
  const outputPath = await ensureOutputPath(input.outputPath);
  return runHelper<CaptureResult>({ action: "capture-screen-region", region: input.region, outputPath });
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

async function waitForWindow(
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

const HELPER_TIMEOUT_MS = 60000;

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

export function shutdownHelper(): void {
  if (activeWorker && !activeWorker.exited) {
    try {
      activeWorker.child.stdin?.end();
    } catch {
      // ignore
    }
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

function minimizeWindow(hwnd: string, noActivate = false): Promise<unknown> {
  const action = noActivate ? "noactivate-minimize" : "minimize-window";
  return runHelper({ action, target: { hwnd } });
}
