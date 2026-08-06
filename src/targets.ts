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
//   4. process exited                  -> PROCESS_EXITED
//
// Bindings are in-memory only and expire (default 20 minutes, like the run
// cache). This module is pure data + injected callbacks so the hot-reload
// boundary stays clean: it does not import windows.ts or profiles/registry.ts
// (callers supply the lookups).

import { McpUiError } from "./uia/results.js";

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
};

// Resolution outcome for a targetRef. `target` is present on success and on
// rebind; on WINDOW_NOT_FOUND_FOR_PROCESS the result reports processAlive /
// windowAlive / profileWindowMatched so the model never misreads "no window"
// as "crashed".
export type TargetResolution =
  | { ok: true; target: { targetRef: string; pid: number; hwnd?: string; title?: string; rebound: boolean; previousHwnd?: string } }
  | { ok: false; error: McpUiError; processAlive: boolean; windowAlive: boolean; profileWindowMatched: boolean };

export type TargetLookupDeps = {
  // Real process liveness (OpenProcess/GetExitCodeProcess) + IsWindow.
  checkProcessAlive: (input: { pid?: number; hwnd?: string | number }) => Promise<{ processAlive: boolean; windowAlive: boolean }>;
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

export function registerTarget(binding: Omit<TargetBinding, "targetRef" | "createdAt" | "lastResolvedAt">): TargetBinding {
  const targetRef = targetRefFor(binding.profileId, binding.pid, binding.hwnd);
  const now = Date.now();
  const stored: TargetBinding = { ...binding, targetRef, createdAt: now, lastResolvedAt: now };
  bindings.set(targetRef, stored);
  return stored;
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
// crash); only a real process exit returns PROCESS_EXITED.
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
      return {
        ok: true,
        target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: binding.hwnd, title: binding.title, rebound: false }
      };
    }
  } else {
    const state = await deps.checkProcessAlive({ pid: binding.pid });
    if (state.processAlive && state.windowAlive) {
      binding.lastResolvedAt = Date.now();
      return { ok: true, target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: binding.hwnd, title: binding.title, rebound: false } };
    }
  }

  // 2. Saved hwnd is stale. Is the process itself still alive?
  const state = await deps.checkProcessAlive({ pid: binding.pid });
  if (!state.processAlive) {
    unregisterTarget(targetRef);
    return {
      ok: false,
      processAlive: false,
      windowAlive: false,
      profileWindowMatched: false,
      error: new McpUiError(
        "PROCESS_EXITED",
        `The process for targetRef '${targetRef}' (pid ${binding.pid}) has exited.`,
        { targetRef, pid: binding.pid, profile: binding.profileId },
        "Relaunch the app with profile_launch and use the new targetRef."
      )
    };
  }

  // 3. Process alive: re-resolve the main window by the profile's rules.
  const windows = await deps.listWindows({ pid: binding.pid });
  const matched = windows.filter((w) => matchesMainWindow(binding, w));
  if (matched.length === 0) {
    // The process is alive but no profile window is available. This is NOT a
    // crash - the window may be starting, hidden, or recreated. The caller
    // reports processAlive/windowAlive/profileWindowMatched so the model can
    // decide (e.g. wait) instead of assuming the app died.
    return {
      ok: false,
      processAlive: true,
      windowAlive: windows.length > 0,
      profileWindowMatched: false,
      error: new McpUiError(
        "WINDOW_NOT_FOUND_FOR_PROCESS",
        "The process is alive, but no matching profile window is currently available.",
        { targetRef, pid: binding.pid, profile: binding.profileId, processAlive: true, windowAlive: windows.length > 0, profileWindowMatched: false },
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
  return {
    ok: true,
    target: { targetRef: binding.targetRef, pid: binding.pid, hwnd: win.hwnd, title: win.title, rebound: true, ...(previousHwnd !== undefined ? { previousHwnd } : {}) }
  };
}

// Bind a targetRef for a profile launch outcome. hwnd may be undefined when
// the launch did not wait for a window.
export function bindLaunchTarget(input: {
  profileId: string;
  executableNames: string[];
  processNames: string[];
  titleContains?: string[];
  mainWindow?: { title?: string; titleMatch?: "exact" | "contains" | "regex" };
  pid: number;
  hwnd?: string;
  title?: string;
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
