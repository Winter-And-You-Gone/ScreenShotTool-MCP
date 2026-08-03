// Profile registry + resolution logic.
//
// profile_resolve and profile_action are implemented here in the TS layer:
// they look up candidate selectors for a logical control, try each via the
// generic UIA wrappers, and either return the matched element or re-perform
// the action through performUiAction. No PowerShell is touched directly.
//
// DEPENDENCY INJECTION: this module does NOT import windows.ts. The UIA
// functions are passed in by the caller (index.ts) as a UiaDeps object. This
// guarantees the profile layer always uses the *current* runtime's UIA
// functions after a hot reload, so there is exactly one Windows helper worker
// per process. (Previously registry.ts statically imported windows.js, which
// under hot reload produced a second module instance and a second worker.)

import type { AppProfile, SelectorConfidence } from "./types.js";
import { vaporViewProfile } from "./vaporview.js";
import type { UiElementSelector } from "../uia/types.js";
import type {
  GetResult,
  ActionResult,
  QueryResult,
  InspectTreeResult
} from "../uia/types.js";
import {
  getCandidateSelectors,
  getControlConfidence,
  normalizeControlEntry,
  profileWindowSelector
} from "./types.js";
import type { ProfileResolveInput, ProfileActionInput } from "../schemas.js";
import { McpUiError } from "../uia/results.js";

// The UIA surface the profile layer needs. index.ts supplies the real
// implementations from the loaded windows.js runtime module.
export type UiaDeps = {
  getUiElement: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    timeoutMs?: number;
  }) => Promise<GetResult>;
  performUiAction: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    action: string;
    value?: string;
    rangeValue?: number;
    allowCoordinateFallback?: boolean;
    allowMessageClickFallback?: boolean;
    forceCoordinateClick?: boolean;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    timeoutMs?: number;
  }) => Promise<ActionResult>;
  queryUi: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    includePatterns?: boolean;
    maxResults?: number;
    timeoutMs?: number;
  }) => Promise<QueryResult>;
  inspectUiTree: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    timeoutMs?: number;
    interactiveOnly?: boolean;
    automationIdOnly?: boolean;
    includePatterns?: boolean;
    includeOffscreen?: boolean;
  }) => Promise<InspectTreeResult>;
};

export const profiles: Record<string, AppProfile> = {
  [vaporViewProfile.id]: vaporViewProfile
};

export function listProfiles(): AppProfile[] {
  return Object.values(profiles);
}

export function getProfile(id: string): AppProfile | undefined {
  return profiles[id];
}

// Find the profile whose processName or titleContains matches the given
// target. Used by ui_catalog to auto-enrich controls with profileControl
// labels without requiring the caller to pass a profile id.
export function findProfileForTarget(target: { processName?: string; titleContains?: string; pid?: number }): AppProfile | undefined {
  for (const p of Object.values(profiles)) {
    if (target.processName) {
      const tn = target.processName.toLowerCase();
      if (p.processNames.some((n) => n.toLowerCase() === tn)) return p;
    }
    if (target.titleContains && p.titleContains?.some((t) => t.toLowerCase() === target.titleContains!.toLowerCase())) {
      return p;
    }
  }
  return undefined;
}

// Resolve a logical control name to a concrete element by trying each
// candidate selector in order. Returns the first unique match.
//
// Error classification (per spec):
//  - 0 matches (getUiElement returns found:false, or throws ELEMENT_NOT_FOUND):
//    record "not-found", try next candidate.
//  - 1 match: success.
//  - ELEMENT_AMBIGUOUS: record "ambiguous", try next candidate.
//  - Severe errors (WINDOW_NOT_FOUND, WINDOW_AMBIGUOUS, UIA_ROOT_UNAVAILABLE,
//    UIA_ASSEMBLY_UNAVAILABLE, TARGET_PROCESS_EXITED, INVALID_SELECTOR):
//    re-throw immediately - these are NOT "selector didn't match", they mean
//    the environment is broken and continuing would mislead the caller.
//  - Other errors (PATTERN_NOT_SUPPORTED etc.): record "error", try next.
export async function resolveProfileControl(
  deps: UiaDeps,
  input: ProfileResolveInput
): Promise<{
  profile: string;
  control: string;
  found: boolean;
  selectorUsed?: UiElementSelector;
  candidateIndex?: number;
  confidence?: SelectorConfidence;
  notes?: string;
  candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }>;
  element?: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const entry = normalizeControlEntry(profile.controls[input.control]);
  if (!entry) {
    throw new McpUiError(
      "PROFILE_CONTROL_NOT_FOUND",
      `Profile '${input.profile}' has no control named '${input.control}'.`,
      { profile: input.profile, control: input.control }
    );
  }
  const candidates = entry.selectors;
  const confidence = entry.confidence;

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];

  // Codes that mean "the environment is broken", not "this selector didn't
  // match". These short-circuit and propagate.
  const severeCodes = new Set([
    "WINDOW_NOT_FOUND",
    "WINDOW_AMBIGUOUS",
    "UIA_ROOT_UNAVAILABLE",
    "UIA_ASSEMBLY_UNAVAILABLE",
    "TARGET_PROCESS_EXITED",
    "INVALID_SELECTOR"
  ]);

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await deps.getUiElement({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
        selector,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth: input.maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs
      });
      if (result.found) {
        candidatesTried.push({ selector, outcome: "found" });
        return {
          profile: profile.id,
          control: input.control,
          found: true,
          selectorUsed: selector,
          candidateIndex: i,
          confidence,
          notes: entry.notes,
          candidatesTried,
          element: result.element
        };
      }
      candidatesTried.push({ selector, outcome: "not-found" });
    } catch (error) {
      if (error instanceof McpUiError) {
        if (severeCodes.has(error.code)) {
          throw error;
        }
        const outcome = error.code === "ELEMENT_AMBIGUOUS" ? "ambiguous" : "error";
        candidatesTried.push({ selector, outcome, message: error.message });
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // All candidates exhausted without a unique match.
  throw new McpUiError(
    "PROFILE_CONTROL_NOT_FOUND",
    `Profile '${input.profile}' could not resolve control '${input.control}' to a unique element.`,
    {
      profile: profile.id,
      control: input.control,
      confidence,
      notes: entry.notes,
      attempts: candidatesTried.slice(0, 10)
    }
  );
}

// Perform an action on a logical control. Reuses performUiAction (the generic
// UIA layer) - no pattern logic is duplicated here.
export async function performProfileAction(
  deps: UiaDeps,
  input: ProfileActionInput
): Promise<{
  profile: string;
  control: string;
  selectorUsed?: UiElementSelector;
  confidence?: SelectorConfidence;
  notes?: string;
  result: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const entry = normalizeControlEntry(profile.controls[input.control]);
  if (!entry) {
    throw new McpUiError(
      "PROFILE_CONTROL_NOT_FOUND",
      `Profile '${input.profile}' has no control named '${input.control}'.`,
      { profile: input.profile, control: input.control }
    );
  }
  const candidates = entry.selectors;
  const confidence = entry.confidence;

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];
  let lastError: unknown = null;

  const severeCodes = new Set([
    "WINDOW_NOT_FOUND",
    "WINDOW_AMBIGUOUS",
    "UIA_ROOT_UNAVAILABLE",
    "UIA_ASSEMBLY_UNAVAILABLE",
    "TARGET_PROCESS_EXITED",
    "INVALID_SELECTOR"
  ]);

  // Composite actions (selectByName/selectByIndex/getSelection/openMenu) need
  // to resolve the control first, then orchestrate expand -> popup -> item ->
  // verify across multiple UIA calls. Resolve the unique element up front.
  const composite = new Set(["selectByName", "selectByIndex", "getSelection", "openMenu"]);
  if (composite.has(input.action)) {
    return performCompositeProfileAction(deps, profile, input, entry, windowSel);
  }

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await deps.performUiAction({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
        selector,
        action: input.action,
        value: input.value,
        rangeValue: input.rangeValue,
        allowCoordinateFallback: input.allowCoordinateFallback,
        allowMessageClickFallback: input.allowMessageClickFallback,
        forceCoordinateClick: input.forceCoordinateClick,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth: input.maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs
      });
      return {
        profile: profile.id,
        control: input.control,
        selectorUsed: selector,
        confidence,
        notes: entry.notes,
        result
      };
    } catch (error) {
      lastError = error;
      if (error instanceof McpUiError) {
        if (severeCodes.has(error.code)) {
          throw error;
        }
        if (error.code === "ELEMENT_NOT_FOUND") {
          candidatesTried.push({ selector, outcome: "not-found", message: error.message });
        } else {
          candidatesTried.push({ selector, outcome: error.code, message: error.message });
        }
        // PATTERN_NOT_SUPPORTED / ACTION_FAILED / COORDINATE_FALLBACK_DISABLED:
        // the element was found but the action failed - trying more candidates
        // won't help, so stop and surface the last error.
        if (error.code === "PATTERN_NOT_SUPPORTED" || error.code === "ACTION_FAILED" || error.code === "COORDINATE_FALLBACK_DISABLED") {
          break;
        }
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (lastError instanceof McpUiError) {
    throw lastError;
  }
  throw new McpUiError("ACTION_FAILED", "All candidate selectors failed.", {
    profile: profile.id,
    control: input.control,
    confidence,
    notes: entry.notes,
    attempts: candidatesTried.slice(0, 10)
  });
}

// profile_list is pure data - no UIA deps needed.
export function profileList() {
  return {
    profiles: listProfiles().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      processNames: p.processNames,
      controlCount: Object.keys(p.controls).length
    }))
  };
}

// Build the UiaDeps object from a loaded windows module. Used by index.ts.
export function buildUiaDeps(windows: {
  getUiElement: (input: never) => Promise<GetResult>;
  performUiAction: (input: never) => Promise<ActionResult>;
  queryUi: (input: never) => Promise<QueryResult>;
  inspectUiTree: (input: never) => Promise<InspectTreeResult>;
}): UiaDeps {
  return {
    getUiElement: windows.getUiElement as UiaDeps["getUiElement"],
    performUiAction: windows.performUiAction as UiaDeps["performUiAction"],
    queryUi: windows.queryUi as UiaDeps["queryUi"],
    inspectUiTree: windows.inspectUiTree as UiaDeps["inspectUiTree"]
  };
}

// Resolve a profile control to the first candidate selector that uniquely
// matches. Used by composite actions which need a concrete selector to drive
// sub-actions (expand/select) on the resolved control.
async function resolveUniqueSelector(
  deps: UiaDeps,
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  entry: { selectors: UiElementSelector[] },
  input: { includeProcessPopups?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number }
): Promise<UiElementSelector> {
  const severeCodes = new Set(["WINDOW_NOT_FOUND", "WINDOW_AMBIGUOUS", "UIA_ROOT_UNAVAILABLE", "UIA_ASSEMBLY_UNAVAILABLE", "TARGET_PROCESS_EXITED", "INVALID_SELECTOR"]);
  for (const selector of entry.selectors) {
    try {
      const r = await deps.getUiElement({
        hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains,
        selector, includeProcessPopups: input.includeProcessPopups, maxDepth: input.maxDepth, maxNodes: input.maxNodes, timeoutMs: input.timeoutMs
      });
      if (r.found) return selector;
    } catch (e) {
      if (e instanceof McpUiError && severeCodes.has(e.code)) throw e;
    }
  }
  throw new McpUiError("PROFILE_CONTROL_NOT_FOUND", `Could not resolve control to a unique element for composite action.`, { selectors: entry.selectors });
}

// Poll queryUi until at least one element matches (or timeout). Returns the
// query result. Used to wait for a same-PID popup (menu/list) to appear after
// expand/invoke without moving the mouse.
async function waitForMatches(
  deps: UiaDeps,
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  selector: UiElementSelector,
  timeoutMs: number,
  pollMs = 150
): Promise<QueryResult> {
  const deadline = Date.now() + timeoutMs;
  let last: QueryResult = { found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 0 };
  while (Date.now() < deadline) {
    try {
      const r = await deps.queryUi({
        hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains,
        selector, includeProcessPopups: true, maxDepth: 20, maxNodes: 2000, maxResults: 200, timeoutMs: Math.min(8000, timeoutMs)
      });
      last = r;
      if (r.found && r.elements.length > 0) return r;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last;
}

// Composite actions orchestrate multi-step flows (expand -> popup -> select ->
// verify) across ui_action/ui_query/ui_get, handling same-PID popups. They
// never move the physical mouse and verify before/after state.
async function performCompositeProfileAction(
  deps: UiaDeps,
  profile: AppProfile,
  input: ProfileActionInput,
  entry: { selectors: UiElementSelector[]; confidence?: SelectorConfidence; notes?: string },
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string }
): Promise<{ profile: string; control: string; selectorUsed?: UiElementSelector; confidence?: SelectorConfidence; notes?: string; result: unknown }> {
  const selector = await resolveUniqueSelector(deps, windowSel, entry, input);
  const actionTimeout = input.timeoutMs ?? 15000;

  if (input.action === "openMenu") {
    // 1. Read before state. 2. Invoke the menu button. 3. Wait for MenuItem
    // popup. 4. Return the menu items. The caller closes the menu (Escape).
    const before = await deps.getUiElement({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);
    await deps.performUiAction({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, action: "invoke", includeProcessPopups: true, timeoutMs: actionTimeout });
    const items = await waitForMatches(deps, windowSel, { controlType: "MenuItem" }, 5000);
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: { success: true, method: "openMenu", menuItems: items.elements.map((e) => ({ name: e.name, automationId: e.automationId, enabled: e.enabled })), menuItemCount: items.elements.length, before: before?.element ?? null, after: null }
    };
  }

  if (input.action === "getSelection") {
    // Query ListItems with selected state. queryUi returns `selected` in state.
    const r = await deps.queryUi({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector: { controlType: "ListItem" }, includeProcessPopups: true, maxDepth: 20, maxResults: 200, timeoutMs: actionTimeout });
    const selected = r.elements.filter((e) => e.selected === true);
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: { success: true, method: "getSelection", selected: selected.map((e) => ({ name: e.name, automationId: e.automationId })), count: selected.length }
    };
  }

  // selectByName / selectByIndex on a ComboBox or List.
  const before = await deps.getUiElement({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);

  // Expand the combo/list to surface its items in a same-PID popup.
  try {
    await deps.performUiAction({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, action: "expand", includeProcessPopups: true, timeoutMs: actionTimeout });
  } catch {
    // Some controls are already expanded or expose items without a popup.
  }

  const listItems = await waitForMatches(deps, windowSel, { controlType: "ListItem" }, 6000);
  if (listItems.elements.length === 0) {
    throw new McpUiError("ELEMENT_NOT_FOUND", `selectByName/Index: no ListItem found after expand (control may not expose items via UIA popup).`, { control: input.control });
  }

  let target: QueryResult["elements"][number] | undefined;
  if (input.action === "selectByName") {
    const matches = listItems.elements.filter((e) => e.name === input.value);
    if (matches.length === 0) throw new McpUiError("ELEMENT_NOT_FOUND", `No ListItem named '${input.value}'.`, { control: input.control, available: listItems.elements.map((e) => e.name) });
    if (matches.length > 1) throw new McpUiError("ELEMENT_AMBIGUOUS", `${matches.length} ListItems named '${input.value}'.`, { control: input.control });
    target = matches[0];
  } else {
    // selectByIndex
    const idx = input.index ?? 0;
    if (idx >= listItems.elements.length) throw new McpUiError("ELEMENT_NOT_FOUND", `ListItem index ${idx} out of range (0..${listItems.elements.length - 1}).`, { control: input.control });
    target = listItems.elements[idx];
  }

  // Build a selector for the target item: prefer unique automationId, else name.
  const itemSelector: UiElementSelector = target!.automationId
    ? { automationId: target!.automationId, controlType: "ListItem" }
    : { name: target!.name, controlType: "ListItem" };

  const selectResult = await deps.performUiAction({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector: itemSelector, action: "select", includeProcessPopups: true, timeoutMs: actionTimeout });

  // Collapse the popup (best-effort) and read the after state.
  await deps.performUiAction({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, action: "collapse", includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => undefined);
  const after = await deps.getUiElement({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains, selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);

  return {
    profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
    result: { success: true, method: "selectByName/Index", selected: { name: target!.name, automationId: target!.automationId }, selectResult, before: before?.element ?? null, after: after?.element ?? null }
  };
}

// Launch a profiled application, resolving the executable via the spec's
// priority chain: explicit exePath > profile env var > config > common build
// dirs > PATH. Returns pid/hwnd/title and whether MCP started it. Never stores
// local absolute paths in the profile.
export async function launchProfile(
  deps: UiaDeps,
  windowsLaunch: (input: { exePath: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number }) => Promise<{ pid: number; window: { hwnd: string; title: string; pid: number; processName: string; className: string; rect: unknown } | null }>,
  listWindows: (filters: { processName?: string }) => Promise<Array<{ hwnd: string; title: string; pid: number; processName: string }>>,
  input: { profile: string; exePath?: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number; reuseIfRunning?: boolean }
): Promise<{ profile: string; pid: number; hwnd?: string; title?: string; startedByMcp: boolean; reused: boolean; uiaRootAvailable: boolean }> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  if (!profile.executableNames || profile.executableNames.length === 0) {
    throw new McpUiError("PROFILE_NOT_FOUND", `Profile '${input.profile}' has no executableNames; cannot launch.`, { profile: input.profile });
  }

  // Reuse an already-running instance if allowed.
  if (input.reuseIfRunning !== false) {
    for (const name of profile.executableNames) {
      const existing = await listWindows({ processName: name }).catch(() => []);
      if (existing.length > 0) {
        const win = existing[0]!;
        // Verify UIA root is reachable.
        let uiaOk = false;
        try {
          const r = await deps.getUiElement({ hwnd: win.hwnd, selector: { controlType: "Window" }, includeProcessPopups: false, timeoutMs: 8000 });
          uiaOk = r.found;
        } catch { uiaOk = false; }
        return { profile: profile.id, pid: win.pid, hwnd: win.hwnd, title: win.title, startedByMcp: false, reused: true, uiaRootAvailable: uiaOk };
      }
    }
  }

  const exePath = await resolveProfileExecutable(profile, input.exePath);
  const launched = await windowsLaunch({
    exePath,
    args: input.args,
    waitForWindow: input.waitForWindow,
    noActivate: input.noActivate,
    startMinimized: input.startMinimized,
    timeoutMs: input.timeoutMs
  });

  // Wait for UIA root to be available (best-effort).
  let uiaRootAvailable = false;
  if (launched.window) {
    try {
      const r = await deps.getUiElement({ hwnd: launched.window.hwnd, selector: { controlType: "Window" }, includeProcessPopups: false, timeoutMs: 10000 });
      uiaRootAvailable = r.found;
    } catch { uiaRootAvailable = false; }
  }

  return {
    profile: profile.id,
    pid: launched.pid,
    hwnd: launched.window?.hwnd,
    title: launched.window?.title,
    startedByMcp: true,
    reused: false,
    uiaRootAvailable
  };
}

// Resolve the executable path per the spec priority chain. Does NOT hardcode
// machine-specific absolute paths: env var and PATH lookup are runtime-only.
async function resolveProfileExecutable(profile: AppProfile, explicit?: string): Promise<string> {
  const { access, constants } = await import("node:fs/promises");
  const { resolve: resolvePath } = await import("node:path");

  const names = profile.executableNames;
  if (!names || names.length === 0) {
    throw new McpUiError("PROFILE_NOT_FOUND", `Profile '${profile.id}' has no executableNames; cannot launch.`, { profile: profile.id });
  }

  // 1. Explicit caller-supplied path.
  if (explicit) {
    try { await access(explicit, constants.X_OK); return resolvePath(explicit); } catch { /* fall through */ }
  }
  // 2. Profile env var (e.g. VAPORVIEW_EXE).
  if (profile.executableEnv && process.env[profile.executableEnv]) {
    const p = process.env[profile.executableEnv]!;
    try { await access(p, constants.X_OK); return resolvePath(p); } catch { /* fall through */ }
  }
  // 3. Common build/install locations (relative to the exe's own name, not
  //    machine-specific). Checked in a bounded, conventional order.
  for (const name of names) {
    const candidates = [
      `./build/Release/${name}`,
      `./build/Release/Release/${name}`,
      `./${name}`
    ];
    for (const c of candidates) {
      try { await access(c, constants.X_OK); return resolvePath(c); } catch { /* next */ }
    }
  }
  // 4. PATH lookup via where.exe (Windows).
  for (const name of names) {
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("where.exe", [name], { encoding: "utf8", shell: false, windowsHide: true });
      if (r.status === 0 && r.stdout.trim()) {
        const found = r.stdout.trim().split(/\r?\n/)[0]!;
        try { await access(found, constants.X_OK); return resolvePath(found); } catch { /* next */ }
      }
    } catch { /* next */ }
  }
  throw new McpUiError("PROFILE_NOT_FOUND", `Could not resolve an executable for profile '${profile.id}'. Set ${profile.executableEnv ?? "the env var"} or pass exePath.`, { profile: profile.id, executableEnv: profile.executableEnv });
}

// Enrich a ui_catalog result with profileControl labels by reverse-matching
// each cataloged control against the active profile's selectors. A control is
// labelled when its automationId exactly matches a profile selector's
// automationId (full-path Qt automationIds are unique).
export function enrichCatalogControls<C extends { automationId: string; recommendedSelector: UiElementSelector }>(
  profile: AppProfile | undefined,
  controls: C[]
): Array<C & { profileControl?: string }> {
  if (!profile) return controls;
  // Build automationId -> logicalControlName map from the profile.
  const aidToControl = new Map<string, string>();
  for (const [name, raw] of Object.entries(profile.controls)) {
    const entry = normalizeControlEntry(raw);
    if (!entry) continue;
    for (const sel of entry.selectors) {
      if (sel.automationId) aidToControl.set(sel.automationId, name);
    }
  }
  return controls.map((c) => {
    const profileControl = c.automationId ? aidToControl.get(c.automationId) : undefined;
    return profileControl ? { ...c, profileControl } : c;
  });
}
