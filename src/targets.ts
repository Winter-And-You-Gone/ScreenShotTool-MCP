// Stable short-lived target bindings (targetRef).
//
// profile_launch returns a `targetRef` (e.g. "target_abcd1234") that binds a
// profile to its running instance: profile id, executable name, pid, current
// hwnd, and the profile's main-window match rules. Later high-level tools
// (profile_action, profile_resolve, ui_query, ui_get, ui_catalog,
// ui_inspect_tree, capture_window) accept the targetRef and the server
// refreshes the binding when the window is recreated:
//
//   1. saved hwnd still valid          -> use it
//   2. hwnd invalid but process alive  -> re-resolve by the profile's
//      main-window rules and update the binding (rebound:true)
//   3. process alive, no window        -> WINDOW_NOT_FOUND_FOR_PROCESS
//      (the process is NOT dead; never call it a crash)
//   4. process exited                  -> TARGET_PROCESS_EXITED
//      (with lifecycle details + lastOperation; causality is never asserted)
//
// Bindings are in-memory only and expire (default 20 minutes, like the run
// cache). This module is pure data + injected callbacks so the hot-reload
// boundary stays clean: it does not import windows.ts or profiles/registry.ts
// (callers supply the lookups).

import { McpUiError } from "./uia/results.js";

// Target lifecycle classification (never asserts root cause - only observable
// state). `terminated-by-mcp` is set only when the MCP server itself called
// close_app / taskkill for this pid.
export type TargetLifecycleState =
  | "alive"
  | "window-recreated"
  | "window-lost-process-alive"
  | "process-exited"
  | "process-exited-with-code"
  | "terminated-by-mcp"
  | "unknown";

// Lightweight per-target operation ring (bounded). Records ONLY safe
// interaction metadata - never passwords, tokens, full text input, sensitive
// args, or screenshot images. Temporal correlation is recorded, causality is
// never asserted (see `lastOperation` wording rules).
export type TargetOperationRecord = {
  tool: string;
  startedAt: number;
  finishedAt?: number;
  interactionMethod?: string;
  before?: {
    processAlive?: boolean;
    windowAlive?: boolean;
    hwnd?: string;
  };
  after?: {
    processAlive?: boolean;
    windowAlive?: boolean;
    hwnd?: string;
  };
  // True when the before hwnd was stale after the operation but the target
  // session stayed alive and rebound to a new window. NEVER treated as
  // target-disappeared: the target session is still alive.
  windowRebound?: boolean;
  // Present only when the AFTER lifecycle probe itself failed (diagnostics
  // unavailable). The original operation outcome is never replaced by a
  // diagnostics failure.
  afterDiagnosticsAvailable?: boolean;
  result:
    | "success"
    | "business-error"
    | "protocol-error"
    | "target-disappeared";
  // Safe machine code only (e.g. ELEMENT_NOT_FOUND, TARGET_PROCESS_EXITED).
  // Error MESSAGES are never recorded - they can embed user data.
  errorCode?: string;
};

export const TARGET_OPERATION_RING_MAX = 20;

export type TargetBinding = {
  targetRef: string;
  profileId: string;
  // Executable name(s) used to find windows when the saved hwnd is stale.
  executableNames: string[];
  // Process name(s) / title rules used to re-resolve the main window.
  processNames: string[];
  titleContains?: string[];
  mainWindow?: { title?: string; titleMatch?: "exact" | "contains" | "regex" };
  pid: number;
  hwnd?: string;
  title?: string;
  createdAt: number;
  lastResolvedAt: number;
  // Process identity recorded when the MCP server spawned the process
  // (startedByMcp=true). exitObservedAt / exitCode are best-effort: Win32
  // exit codes are only available while the process handle can be queried
  // (GetExitCodeProcess on a stale pid returns STILL_ACTIVE or fails); a
  // missing exitCode is NOT evidence of anything.
  startedByMcp?: boolean;
  startedAt?: number;
  // Launch contract, SEPARATE from startedByMcp: a process can be started by
  // the MCP server yet be independent of its lifetime (the profile_launch
  // default). "independent" = the process should survive the server's exit;
  // "managed" = explicitly owned by the server.
  lifetime?: "independent" | "managed";
  lastSeenAliveAt?: number;
  exitObservedAt?: number;
  exitCode?: number;
  terminatedByMcp?: boolean;
  // Ring of recent operations against this target (bounded).
  operations: TargetOperationRecord[];
};

// Resolution outcome for a targetRef. `target` is present on success and on
// rebind; on WINDOW_NOT_FOUND_FOR_PROCESS the result reports processAlive /
// windowAlive / profileWindowMatched so the model never misreads "no window"
// as "crashed".
export type TargetResolution =
  | { ok: true; target: { targetRef: string; pid: number; hwnd?: string; title?: string; rebound: boolean; previousHwnd?: string; lifecycle?: TargetLifecycleState } }
  | { ok: false; error: McpUiError; processAlive: boolean; windowAlive: boolean; profileWindowMatched: boolean };

export type TargetLookupDeps = {
  // Real process liveness (OpenProcess/GetExitCodeProcess) + IsWindow.
  // exitCode is best-effort (null when the platform cannot obtain it after
  // the process exited or the handle is gone).
  checkProcessAlive: (input: { pid?: number; hwnd?: string | number }) => Promise<{ processAlive: boolean; windowAlive: boolean; exitCode?: number | null }>;
  // List top-level windows, optionally filtered by pid.
  listWindows: (filters: { pid?: number; processName?: string; titleContains?: string }) => Promise<Array<{ hwnd: string; title: string; pid: number; processName: string }>>;
};

export const TARGET_REF_TTL_MS = 20 * 60 * 1000;
export const TARGET_REF_PREFIX = "target_";

// Module-level store (process lifetime, like the run cache). Tests can clear
// it via resetTargetBindings().
const bindings = new Map<string, TargetBinding>();

export function targetRefFor(profileId: string, pid: number, hwnd?: string): string {
  // Collision-resistant without Date.now/random: pid + hwnd + monotonic
  // sequence keep ids unique within a process lifetime.
  return `${TARGET_REF_PREFIX}${profileId}_${pid}${hwnd !== undefined ? `_${hwnd}` : ""}`;
}

export function registerTarget(binding: Omit<TargetBinding, "targetRef" | "createdAt" | "lastResolvedAt" | "operations">): TargetBinding {
  const targetRef = targetRefFor(binding.profileId, binding.pid, binding.hwnd);
  const now = Date.now();
  const stored: TargetBinding = { ...binding, targetRef, createdAt: now, lastResolvedAt: now, operations: [] };
  bindings.set(targetRef, stored);
  return stored;
}

// A record may be created before the outcome is known: the unified operation
// wrapper registers startedAt + before state FIRST (so a throwing operation
// still leaves a record), then finalizes result/finishedAt/after. Callers
// that already know the outcome pass the full record.
export type TargetOperationRecordDraft = Omit<TargetOperationRecord, "result"> & { result?: TargetOperationRecord["result"] };

// Record one safe operation against a target (bounded ring). Never records
// sensitive data - only the tool name, lifecycle observations, and safe
// interaction metadata. Returns the stored record so the caller can finalize
// it in place (startedAt before the operation, finishedAt/result afterwards).
export function recordTargetOperation(
  targetRef: string,
  record: TargetOperationRecordDraft
): TargetOperationRecord | undefined {
  const binding = bindings.get(targetRef);
  if (!binding) return undefined;
  const stored: TargetOperationRecord = {
    // Transient placeholder until the wrapper finalizes the outcome; every
    // wrapper path overwrites it before the operation is observable.
    result: "success",
    ...record
  };
  binding.operations.push(stored);
  if (binding.operations.length > TARGET_OPERATION_RING_MAX) {
    binding.operations.splice(0, binding.operations.length - TARGET_OPERATION_RING_MAX);
  }
  return stored;
}

export function lastTargetOperation(targetRef: string): TargetOperationRecord | undefined {
  const binding = bindings.get(targetRef);
  if (!binding || binding.operations.length === 0) return undefined;
  return binding.operations[binding.operations.length - 1];
}

// Classify the current observable state of a target. This is EXACTLY what was
// observed - never a root-cause claim.
export function classifyTargetLifecycle(
  binding: TargetBinding,
  processAlive: boolean,
  windowAlive: boolean
): TargetLifecycleState {
  if (!processAlive) {
    if (binding.terminatedByMcp) return "terminated-by-mcp";
    if (binding.exitCode !== undefined && binding.exitCode !== 0) return "process-exited-with-code";
    return "process-exited";
  }
  if (binding.hwnd !== undefined && !windowAlive) return "window-lost-process-alive";
  return "alive";
}

export function getTarget(targetRef: string): TargetBinding | undefined {
  const binding = bindings.get(targetRef);
  if (!binding) return undefined;
  if (Date.now() - binding.lastResolvedAt > TARGET_REF_TTL_MS) {
    bindings.delete(targetRef);
    return undefined;
  }
  return binding;
}

export function unregisterTarget(targetRef: string): void {
  bindings.delete(targetRef);
}

export function listTargetBindings(): TargetBinding[] {
  const now = Date.now();
  for (const [ref, b] of bindings) {
    if (now - b.lastResolvedAt > TARGET_REF_TTL_MS) bindings.delete(ref);
  }
  return [...bindings.values()];
}

export function resetTargetBindings(): void {
  bindings.clear();
}

// Does a window match the binding's profile main-window rules?
function matchesMainWindow(binding: TargetBinding, win: { hwnd: string; title: string; pid: number; processName: string }): boolean {
  const processMatches = binding.processNames.length === 0
    || binding.processNames.some((n) => n.toLowerCase().replace(/\.exe$/, "") === win.processName.toLowerCase().replace(/\.exe$/, ""));
  if (!processMatches) return false;
  if (binding.titleContains && binding.titleContains.length > 0) {
    const tc = win.title.toLowerCase();
    if (!binding.titleContains.some((t) => tc.includes(t.toLowerCase()))) return false;
  }
  const mainTitle = binding.mainWindow?.title;
  if (mainTitle !== undefined) {
    const match = binding.mainWindow?.titleMatch ?? "contains";
    if (match === "regex") {
      try {
        if (!new RegExp(mainTitle, "i").test(win.title)) return false;
      } catch {
        return false;
      }
    } else if (match === "exact") {
      if (win.title.toLowerCase() !== mainTitle.toLowerCase()) return false;
    } else if (!win.title.toLowerCase().includes(mainTitle.toLowerCase())) {
      return false;
    }
  }
  return true;
}

// Resolve a targetRef to a live target, refreshing the hwnd when the window
// was recreated. Process-alive-but-windowless is reported separately (NOT a
// crash); only a real process exit returns TARGET_PROCESS_EXITED.
export async function resolveTargetRef(
  targetRef: string,
  deps: TargetLookupDeps
): Promise<TargetResolution> {
  const binding = getTarget(targetRef);
  if (!binding) {
    return {
      ok: false,
      processAlive: false,
      windowAlive: false,
      profileWindowMatched: false,
      error: new McpUiError(
        "TARGET_REQUIRED",
        `targetRef '${targetRef}' is unknown or expired (bindings live for ${TARGET_REF_TTL_MS / 60000} minutes in memory).`,
        { targetRef: targetRef, expired: true },
        "Run profile_launch again and use the returned targetRef."
      )
    };
  }

  // 1. Saved hwnd still valid?
  if (binding.hwnd !== undefined) {
    const state = await deps.checkProcessAlive({ hwnd: binding.hwnd, pid: binding.pid });
    if (state.windowAlive && state.processAlive) {
      binding.lastResolvedAt = Date.now();
      binding.lastSeenAliveAt = Date.now();
      return {
        ok: true,
        target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: binding.hwnd, title: binding.title, rebound: false }
      };
    }
  } else {
    const state = await deps.checkProcessAlive({ pid: binding.pid });
    if (state.processAlive && state.windowAlive) {
      binding.lastResolvedAt = Date.now();
      binding.lastSeenAliveAt = Date.now();
      return { ok: true, target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: binding.hwnd, title: binding.title, rebound: false } };
    }
  }

  // 2. Saved hwnd is stale. Is the process itself still alive?
  const state = await deps.checkProcessAlive({ pid: binding.pid });
  if (!state.processAlive) {
    // Read the operation ring BEFORE unregistering the binding (the ring
    // lives on the binding).
    const lastOp = lastTargetOperation(targetRef);
    unregisterTarget(targetRef);
    if (binding.exitObservedAt === undefined) {
      binding.exitObservedAt = Date.now();
    }
    if (state.exitCode !== undefined && state.exitCode !== null && binding.exitCode === undefined) {
      binding.exitCode = state.exitCode;
    }
    const lifecycle = classifyTargetLifecycle(binding, false, false);
    return {
      ok: false,
      processAlive: false,
      windowAlive: false,
      profileWindowMatched: false,
      error: new McpUiError(
        "TARGET_PROCESS_EXITED",
        `The process for targetRef '${targetRef}' (pid ${binding.pid}) has exited.`,
        {
          targetRef,
          pid: binding.pid,
          profile: binding.profileId,
          processAlive: false,
          windowAlive: false,
          startedByMcp: binding.startedByMcp ?? false,
          // Launch contract: independent targets are expected to outlive the
          // MCP server - an exit here is never the server's fault.
          ...(binding.lifetime ? { lifetime: binding.lifetime } : {}),
          ...(binding.exitCode !== undefined ? { exitCode: binding.exitCode } : {}),
          ...(binding.exitObservedAt !== undefined ? { exitObservedAt: new Date(binding.exitObservedAt).toISOString() } : {}),
          lifecycle,
          // Temporal diagnostic context, explicitly NOT a causality claim.
          ...(lastOp ? { lastOperation: { tool: lastOp.tool, interactionMethod: lastOp.interactionMethod, completed: lastOp.finishedAt !== undefined, startedAt: new Date(lastOp.startedAt).toISOString() } } : {}),
          causality: "unknown"
        },
        "Relaunch the app with profile_launch and use the new targetRef. The recorded last operation is temporal diagnostic context and does not prove that the tool caused the exit."
      )
    };
  }

  // 3. Process alive: re-resolve the main window by the profile's rules.
  binding.lastSeenAliveAt = Date.now();
  const windows = await deps.listWindows({ pid: binding.pid });
  const matched = windows.filter((w) => matchesMainWindow(binding, w));
  if (matched.length === 0) {
    // The process is alive but no profile window is available. This is NOT a
    // crash - the window may be starting, hidden, or recreated. The caller
    // reports processAlive/windowAlive/profileWindowMatched so the model can
    // decide (e.g. wait) instead of assuming the app died.
    const lifecycle = classifyTargetLifecycle(binding, true, windows.length > 0);
    return {
      ok: false,
      processAlive: true,
      windowAlive: windows.length > 0,
      profileWindowMatched: false,
      error: new McpUiError(
        "WINDOW_NOT_FOUND_FOR_PROCESS",
        "The process is alive, but no matching profile window is currently available.",
        { targetRef, pid: binding.pid, profile: binding.profileId, processAlive: true, windowAlive: windows.length > 0, profileWindowMatched: false, lifecycle, previousHwnd: binding.hwnd },
        "Wait for the main window or call profile_resolve with the same targetRef. No matching window does not prove the process crashed; the window may be starting, hidden, or recreated."
      )
    };
  }

  // 4. Rebound: update the binding to the new main window.
  const win = matched[0]!;
  const previousHwnd = binding.hwnd;
  binding.hwnd = win.hwnd;
  binding.title = win.title;
  binding.lastResolvedAt = Date.now();
  binding.lastSeenAliveAt = Date.now();
  return {
    ok: true,
    target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: win.hwnd, title: win.title, rebound: true, lifecycle: "window-recreated", ...(previousHwnd !== undefined ? { previousHwnd } : {}) }
  };
}

// Bind a targetRef for a profile launch outcome. hwnd may be undefined when
// the launch did not wait for a window. startedByMcp records whether the MCP
// server spawned this process (used by exit diagnostics - never a causality
// claim).
export function bindLaunchTarget(input: {
  profileId: string;
  executableNames: string[];
  processNames: string[];
  titleContains?: string[];
  mainWindow?: { title?: string; titleMatch?: "exact" | "contains" | "regex" };
  pid: number;
  hwnd?: string;
  title?: string;
  startedByMcp?: boolean;
  startedAt?: number;
  lifetime?: "independent" | "managed";
}): TargetBinding {
  return registerTarget(input);
}

// Auto-bind a targetRef when the caller gave a profile but no target/pid/hwnd
// and exactly ONE matching instance is running. Returns undefined when no
// instance matches; throws TARGET_AMBIGUOUS when several match.
export async function autoResolveTarget(input: {
  profileId: string;
  executableNames: string[];
  processNames: string[];
  titleContains?: string[];
  mainWindow?: { title?: string; titleMatch?: "exact" | "contains" | "regex" };
  listWindows: TargetLookupDeps["listWindows"];
}): Promise<TargetBinding | undefined> {
  const windows = await input.listWindows({});
  const matches = windows.filter((w) =>
    input.processNames.some((n) => n.toLowerCase().replace(/\.exe$/, "") === w.processName.toLowerCase().replace(/\.exe$/, ""))
  );
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    const summary = matches.map((w) => ({ pid: w.pid, hwnd: w.hwnd, title: w.title }));
    throw new McpUiError(
      "TARGET_AMBIGUOUS",
      `${matches.length} running instances match profile '${input.profileId}'; pass an explicit targetRef (from profile_launch), pid, or hwnd.`,
      { profile: input.profileId, instances: summary },
      "Run profile_launch to get a targetRef for the specific instance, or pass pid/hwnd."
    );
  }
  const win = matches[0]!;
  return bindLaunchTarget({
    profileId: input.profileId,
    executableNames: input.executableNames,
    processNames: input.processNames,
    titleContains: input.titleContains,
    mainWindow: input.mainWindow,
    pid: win.pid,
    hwnd: win.hwnd,
    title: win.title
  });
}

// Re-resolve the main window of an EXISTING binding by its profile rules.
// Returns the updated binding or undefined when no window matches right now.
export async function rebindTargetByRules(
  binding: TargetBinding,
  deps: TargetLookupDeps
): Promise<TargetBinding | undefined> {
  const state = await deps.checkProcessAlive({ pid: binding.pid });
  if (!state.processAlive) {
    unregisterTarget(binding.targetRef);
    return undefined;
  }
  const windows = await deps.listWindows({ pid: binding.pid });
  const matched = windows.filter((w) => matchesMainWindow(binding, w));
  if (matched.length === 0) return undefined;
  const win = matched[0]!;
  binding.hwnd = win.hwnd;
  binding.title = win.title;
  binding.lastResolvedAt = Date.now();
  return binding;
}
