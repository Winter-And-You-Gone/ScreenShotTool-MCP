// Profile resolution + composite actions.
//
// profile_resolve and profile_action are implemented here in the TS layer:
// they look up candidate selectors for a logical control, try each via the
// generic UIA wrappers, and either return the matched element or re-perform
// the action through performUiAction. No PowerShell is touched directly.
//
// PROFILES ARE DATA: every profile comes from a loaded App Pack (the pack
// registry), never from hardcoded source. Menu behavior that differs between
// apps (section rows that open submenus on keyboard-Right, command rows that
// need a non-blocking Enter, the panel window that receives keys) is declared
// in the pack's controls.json `menu` hints; this module interprets them.
//
// DEPENDENCY INJECTION: this module does NOT import windows.ts. The UIA
// functions are passed in by the caller (index.ts) as a UiaDeps object. This
// guarantees the profile layer always uses the *current* runtime's UIA
// functions after a hot reload, so there is exactly one Windows helper worker
// per process.

import type { AppProfile, ControlEntry, SelectorConfidence } from "./types.js";
import { getAppProfile, listAppProfiles, registry as packRegistry } from "../app-packs/registry.js";
import type { UiElementSelector } from "../uia/types.js";
import type {
  GetResult,
  ActionResult,
  QueryResult,
  InspectTreeResult,
  UiElementState
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
  // Post a key event to a window without moving the physical mouse. Used by
  // composite menu actions (openSubmenu sends Right; menu-command invoke sends
  // Enter) for apps whose custom menus open submenus on hover/keyboard and
  // whose command rows open modal dialogs that block InvokePattern.Invoke().
  sendKey: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    key: string;
    modifiers?: string[];
    noActivate?: boolean;
  }) => Promise<unknown>;
};

export function getProfile(id: string): AppProfile | undefined {
  return getAppProfile(id);
}

export function listProfiles(): AppProfile[] {
  return listAppProfiles();
}

// Find the profile whose processName or titleContains matches the given
// target. Used by ui_catalog to auto-enrich controls with profileControl
// labels without requiring the caller to pass a profile id.
export function findProfileForTarget(target: { processName?: string; titleContains?: string; pid?: number }): AppProfile | undefined {
  const pack = packRegistry.findPackForTarget(target);
  if (!pack) return undefined;
  return getAppProfile(pack.manifest.id);
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

  // Composite actions (selectByName/selectByIndex/getSelection/openMenu/
  // openSubmenu/ensureSelected) need to resolve the control first, then
  // orchestrate expand -> popup -> item -> verify across multiple UIA calls.
  // Resolve the unique element up front. `invoke` on a menu command declared
  // with menu.invokeMode="keyboard-enter" is also routed here: those rows open
  // a modal dialog whose exec() blocks InvokePattern.Invoke(), so the
  // composite path triggers them via a non-blocking focus + Enter key.
  const composite = new Set(["selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected"]);
  if (composite.has(input.action) || (input.action === "invoke" && isKeyboardInvokeControl(entry))) {
    const compositeResult = await performCompositeProfileAction(deps, profile, input, entry, windowSel);
    // Composite actions verify before/after state; a failed verification is a
    // step failure, not a silent success.
    const resultValue = compositeResult.result as { success?: boolean } | undefined;
    if (resultValue && resultValue.success === false) {
      throw new McpUiError("ACTION_FAILED", `Composite action '${input.action}' on '${input.control}' did not verify (before/after state check failed).`, {
        profile: profile.id, control: input.control, action: input.action, result: compositeResult.result
      });
    }
    return compositeResult;
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
      controlCount: Object.keys(p.controls).length,
      source: "app-pack"
    }))
  };
}

// Build the UiaDeps object from a loaded windows module. Used by index.ts.
export function buildUiaDeps(windows: {
  getUiElement: (input: never) => Promise<GetResult>;
  performUiAction: (input: never) => Promise<ActionResult>;
  queryUi: (input: never) => Promise<QueryResult>;
  inspectUiTree: (input: never) => Promise<InspectTreeResult>;
  sendKey: (input: never) => Promise<unknown>;
}): UiaDeps {
  return {
    getUiElement: windows.getUiElement as UiaDeps["getUiElement"],
    performUiAction: windows.performUiAction as UiaDeps["performUiAction"],
    queryUi: windows.queryUi as UiaDeps["queryUi"],
    inspectUiTree: windows.inspectUiTree as UiaDeps["inspectUiTree"],
    sendKey: windows.sendKey as UiaDeps["sendKey"]
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

// A control declared with menu.invokeMode="keyboard-enter" is a menu command
// row that must be triggered via focus + Enter (non-blocking) instead of
// InvokePattern (modal dialogs block Invoke()).
function isKeyboardInvokeControl(entry: ControlEntry): boolean {
  return entry.menu?.invokeMode === "keyboard-enter";
}

function isSectionRow(profile: AppProfile, automationId: string): boolean {
  const patterns = profile.submenuAidPatterns ?? [];
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(automationId);
    } catch {
      return false;
    }
  });
}

// Build a menu-item descriptor for the openMenu/openSubmenu result.
function buildMenuItem(e: UiElementState, profile: AppProfile): {
  automationId: string; name: string; controlType: string; enabled: boolean;
  checked: boolean | null; hasSubmenu: boolean; supportedActions: string[];
  recommendedSelector: UiElementSelector;
} {
  const pats = e.patterns ?? [];
  const supportedActions: string[] = [];
  if (pats.some((p) => p.includes("Invoke"))) supportedActions.push("invoke");
  if (pats.some((p) => p.includes("Toggle"))) {
    supportedActions.push("toggle");
    supportedActions.push("setChecked");
  }
  const shortName = (e.automationId.split(".").pop() ?? e.automationId).replace(/Action$/, "Action");
  return {
    automationId: e.automationId,
    name: e.name,
    controlType: e.controlType,
    enabled: e.enabled,
    checked: e.toggleState === "On" ? true : e.toggleState === "Off" ? false : null,
    hasSubmenu: isSectionRow(profile, e.automationId),
    supportedActions,
    recommendedSelector: { automationId: `${shortName}$`, match: "regex", controlType: "Button" }
  };
}

// Resolve the menu panel HWND so composite menu actions can post keyboard
// events to it. Uses the control's declared menu.panelControl when present
// (resolved via the profile); otherwise falls back to the main window HWND.
async function getMenuPanelHwnd(
  deps: UiaDeps,
  profile: AppProfile,
  entry: ControlEntry,
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  timeoutMs: number
): Promise<string | number | undefined> {
  const panelControl = entry.menu?.panelControl;
  if (panelControl) {
    const panelEntry = normalizeControlEntry(profile.controls[panelControl]);
    if (panelEntry) {
      for (const selector of panelEntry.selectors) {
        try {
          const r = await deps.getUiElement({
            hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains,
            selector, includeProcessPopups: true, timeoutMs
          });
          if (r.found && r.element.nativeWindowHandle) return r.element.nativeWindowHandle;
        } catch { /* try next */ }
      }
    }
  }
  return windowSel.hwnd;
}

async function performCompositeProfileAction(
  deps: UiaDeps,
  profile: AppProfile,
  input: ProfileActionInput,
  entry: ControlEntry,
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string }
): Promise<{ profile: string; control: string; selectorUsed?: UiElementSelector; confidence?: SelectorConfidence; notes?: string; result: unknown }> {
  const selector = await resolveUniqueSelector(deps, windowSel, entry, input);
  const actionTimeout = input.timeoutMs ?? 15000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const win = () => ({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains });

  // ── openMenu: open the application menu and enumerate its items. ──
  // Invoke the menu button; success is proved by the declared section control
  // appearing (or, generically, by a new popup root). Idempotent: when the
  // menu is already open (sections already present), the invoke is skipped -
  // repeating openMenu must not toggle the menu closed.
  if (input.action === "openMenu") {
    const sectionSelector = entry.menu?.sectionControl
      ? firstSelectorOf(profile, entry.menu.sectionControl)
      : undefined;

    if (sectionSelector) {
      const pre = await deps.queryUi({ ...win(), selector: sectionSelector, includeProcessPopups: true, maxDepth: 12, maxResults: 50, timeoutMs: 5000 }).catch(() => null);
      if (pre && pre.elements.length > 0) {
        return {
          profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
          result: {
            success: true, method: "noop", popupOpened: true, alreadyOpen: true,
            items: pre.elements.map((e) => buildMenuItem(e, profile)), itemCount: pre.elements.length
          }
        };
      }
    }

    const treeBefore = await deps.inspectUiTree({ ...win(), includeProcessPopups: true, maxDepth: 2, maxNodes: 60, timeoutMs: 8000 }).catch(() => null);
    const rootsBefore = treeBefore ? treeBefore.roots.filter((r) => !r.isMain).length : 0;

    await deps.performUiAction({ ...win(), selector, action: "invoke", includeProcessPopups: true, timeoutMs: actionTimeout });

    let sections: UiElementState[] = [];
    if (sectionSelector) {
      const r = await waitForMatches(deps, windowSel, sectionSelector, 6000);
      sections = r.elements;
    } else {
      // Generic proof: wait for a new popup root, then enumerate visible
      // buttons as menu items.
      const opened = await waitForPopupRoot(deps, win, rootsBefore, 6000);
      if (opened) {
        const q = await deps.queryUi({ ...win(), selector: { controlType: "Button" }, includeProcessPopups: true, maxDepth: 14, maxResults: 200, timeoutMs: 6000 }).catch(() => ({ elements: [] as UiElementState[] }));
        sections = q.elements.filter((e) => !e.offscreen);
      }
    }
    const treeAfter = await deps.inspectUiTree({ ...win(), includeProcessPopups: true, maxDepth: 2, maxNodes: 60, timeoutMs: 8000 }).catch(() => null);
    const rootsAfter = treeAfter ? treeAfter.roots.filter((r) => !r.isMain).length : 0;

    const popupOpened = sections.length > 0 || rootsAfter > rootsBefore;
    if (!popupOpened) {
      throw new McpUiError("ACTION_FAILED", "openMenu: menu did not open (no new popup root and no section rows appeared).", { control: input.control, rootsBefore, rootsAfter, sectionsBefore: 0, sectionsAfter: sections.length });
    }
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: {
        success: true, method: "InvokePattern", popupOpened: true,
        popupRoots: (treeAfter?.roots ?? []).filter((r) => !r.isMain).map((r) => ({ hwnd: r.hwnd, title: r.title, ownerHwnd: windowSel.hwnd })),
        items: sections.map((e) => buildMenuItem(e, profile)),
        itemCount: sections.length
      }
    };
  }

  // ── openSubmenu: open a section's submenu via focus + Right key. ──
  // Section rows declared with menu.opensSubmenu open their submenu on
  // hover/keyboard-Right, NOT via InvokePattern. Keys are posted to the menu
  // panel HWND (declared via menu.panelControl, else the main window).
  if (input.action === "openSubmenu") {
    const panelHwnd = await getMenuPanelHwnd(deps, profile, entry, windowSel, actionTimeout);
    const before = await deps.queryUi({ ...win(), selector: { controlType: "Button" }, includeProcessPopups: true, maxDepth: 14, maxResults: 200, timeoutMs: 6000 }).catch(() => ({ elements: [] as UiElementState[] }));
    const beforeAids = new Set(before.elements.filter((e) => !e.offscreen).map((e) => e.automationId));
    await deps.performUiAction({ ...win(), selector, action: "focus", includeProcessPopups: true, timeoutMs: actionTimeout });
    await sleep(150);
    await deps.sendKey({ hwnd: panelHwnd, key: "right", noActivate: true });
    const after = await waitForMatches(deps, windowSel, { controlType: "Button" }, 6000);
    // Submenu items = visible command rows that were not visible before.
    const submenuItems = after.elements.filter((e) => !e.offscreen && !beforeAids.has(e.automationId) && !isSectionRow(profile, e.automationId));
    if (submenuItems.length === 0) {
      throw new McpUiError("ACTION_FAILED", "openSubmenu: no submenu items appeared after Right key.", { control: input.control, visibleAfter: after.elements.filter((e) => !e.offscreen).length });
    }
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: {
        success: true, method: "keyboard-right", popupOpened: true,
        items: submenuItems.map((e) => buildMenuItem(e, profile)), itemCount: submenuItems.length
      }
    };
  }

  // ── invoke (menu command, keyboard-enter mode): focus + Enter. ──
  // Command rows declared with menu.invokeMode="keyboard-enter" open a modal
  // dialog that blocks InvokePattern.Invoke() until the dialog closes, so the
  // composite path posts Enter asynchronously and returns. The caller verifies
  // the outcome (e.g. a dialog appeared) via expect.
  if (input.action === "invoke" && isKeyboardInvokeControl(entry)) {
    const panelHwnd = await getMenuPanelHwnd(deps, profile, entry, windowSel, actionTimeout);
    const treeBefore = await deps.inspectUiTree({ ...win(), includeProcessPopups: true, maxDepth: 2, maxNodes: 60, timeoutMs: 8000 }).catch(() => null);
    const rootsBefore = treeBefore ? treeBefore.roots.filter((r) => !r.isMain).length : 0;
    await deps.performUiAction({ ...win(), selector, action: "focus", includeProcessPopups: true, timeoutMs: actionTimeout });
    await sleep(150);
    await deps.sendKey({ hwnd: panelHwnd, key: "enter", noActivate: true });
    await sleep(450);
    const treeAfter = await deps.inspectUiTree({ ...win(), includeProcessPopups: true, maxDepth: 2, maxNodes: 60, timeoutMs: 8000 }).catch(() => null);
    const rootsAfter = treeAfter ? treeAfter.roots.filter((r) => !r.isMain).length : 0;
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: {
        success: true, method: "keyboard-invoke", triggered: true,
        rootsBefore, rootsAfter,
        popupRoots: (treeAfter?.roots ?? []).filter((r) => !r.isMain).map((r) => ({ hwnd: r.hwnd, title: r.title, ownerHwnd: windowSel.hwnd }))
      }
    };
  }

  // ── getSelection: query selected ListItems. ──
  if (input.action === "getSelection") {
    const r = await deps.queryUi({ ...win(), selector: { controlType: "ListItem" }, includeProcessPopups: true, maxDepth: 20, maxResults: 200, timeoutMs: actionTimeout });
    const selected = r.elements.filter((e) => e.selected === true);
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: { success: true, method: "getSelection", selected: selected.map((e) => ({ name: e.name, automationId: e.automationId })), count: selected.length }
    };
  }

  // ── ensureSelected: make a checkable control selected (idempotent). ──
  // Reads toggleState first; already-selected -> success without any action;
  // otherwise invoke and verify the final state. Safe to repeat.
  if (input.action === "ensureSelected") {
    const before = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);
    if (before?.element?.toggleState === "On") {
      return {
        profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
        result: { success: true, method: "noop", alreadySelected: true, toggleState: "On" }
      };
    }
    await deps.performUiAction({ ...win(), selector, action: "invoke", includeProcessPopups: true, timeoutMs: actionTimeout });
    const after = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);
    const nowSelected = after?.element?.toggleState === "On";
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: { success: nowSelected, method: "invoke", alreadySelected: false, before: before?.element?.toggleState ?? null, after: after?.element?.toggleState ?? null }
    };
  }

  // ── selectByName / selectByIndex on a ComboBox. ──
  // Primary: ExpandCollapse + ListItem SelectionItemPattern. Fallback (apps
  // that do not expose ListItem): keyboard navigation (focus, Alt+Down, Home,
  // Down×index, Enter). The current value is read before AND after and MUST
  // change, else the action is reported as failed (not just "keys were sent").
  const before = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);
  const beforeValue = before?.element?.value ?? null;

  let selected: { name: string; automationId: string } | null = null;
  let method = "keyboard-fallback";
  try {
    await deps.performUiAction({ ...win(), selector, action: "expand", includeProcessPopups: true, timeoutMs: actionTimeout });
    const listItems = await waitForMatches(deps, windowSel, { controlType: "ListItem" }, 6000);
    if (listItems.elements.length > 0) {
      let target: UiElementState | undefined;
      if (input.action === "selectByName") {
        const matches = listItems.elements.filter((e) => e.name === input.value);
        if (matches.length === 0) throw new McpUiError("ELEMENT_NOT_FOUND", `No ListItem named '${input.value}'.`, { control: input.control, available: listItems.elements.map((e) => e.name) });
        if (matches.length > 1) throw new McpUiError("ELEMENT_AMBIGUOUS", `${matches.length} ListItems named '${input.value}'.`, { control: input.control });
        target = matches[0];
      } else {
        const idx = input.index ?? 0;
        if (idx >= listItems.elements.length) throw new McpUiError("ELEMENT_NOT_FOUND", `ListItem index ${idx} out of range (0..${listItems.elements.length - 1}).`, { control: input.control });
        target = listItems.elements[idx];
      }
      if (!target) throw new McpUiError("ELEMENT_NOT_FOUND", `selectByName/Index: target ListItem not resolved.`, { control: input.control });
      const itemSelector: UiElementSelector = target.automationId
        ? { automationId: target.automationId, controlType: "ListItem" }
        : { name: target.name, controlType: "ListItem" };
      await deps.performUiAction({ ...win(), selector: itemSelector, action: "select", includeProcessPopups: true, timeoutMs: actionTimeout });
      selected = { name: target.name, automationId: target.automationId };
      method = "SelectionItemPattern";
    }
  } catch (e) {
    if (e instanceof McpUiError && (e.code === "ELEMENT_AMBIGUOUS" || e.code === "ELEMENT_NOT_FOUND") && e.details && (e.details as { available?: string[] }).available) {
      throw e;
    }
    // otherwise fall through to keyboard fallback
  }

  if (!selected) {
    // Keyboard fallback. Focus the combo first.
    await deps.performUiAction({ ...win(), selector, action: "focus", includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => undefined);
    await sleep(150);
    const keyHwnd = windowSel.hwnd;
    if (input.action === "selectByIndex") {
      // Open the popup with Alt+Down, then navigate Home + Down x index.
      await deps.sendKey({ hwnd: keyHwnd, key: "down", modifiers: ["alt"], noActivate: true });
      await sleep(400);
      const idx = input.index ?? 0;
      await deps.sendKey({ hwnd: keyHwnd, key: "home", noActivate: true });
      await sleep(120);
      for (let i = 0; i < idx; i++) {
        await deps.sendKey({ hwnd: keyHwnd, key: "down", noActivate: true });
        await sleep(70);
      }
      await deps.sendKey({ hwnd: keyHwnd, key: "enter", noActivate: true });
      await sleep(350);
      selected = { name: `(keyboard index ${idx})`, automationId: "" };
      method = "keyboard-index";
    } else {
      // selectByName keyboard fallback: type the exact value as edit text
      // (Qt combo accepts typed text) then Enter - no popup needed. Verified
      // by the after-value read below; if it did not take, the action fails.
      await deps.performUiAction({ ...win(), selector, action: "setValue", value: input.value, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => undefined);
      await sleep(200);
      await deps.sendKey({ hwnd: keyHwnd, key: "enter", noActivate: true });
      await sleep(300);
      selected = { name: input.value ?? "", automationId: "" };
      method = "keyboard-name";
    }
  }

  // Collapse the popup (best-effort) and read the after value.
  await deps.performUiAction({ ...win(), selector, action: "collapse", includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => undefined);
  const after = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout }).catch(() => null);
  const afterValue = after?.element?.value ?? null;
  const valueChanged = afterValue !== null && afterValue !== beforeValue;

  return {
    profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
    result: {
      success: valueChanged, method, selected, beforeValue, afterValue, valueChanged,
      popupClosed: true, before: before?.element ?? null, after: after?.element ?? null
    }
  };
}

function firstSelectorOf(profile: AppProfile, control: string): UiElementSelector | undefined {
  return getCandidateSelectors(profile, control)[0];
}

// Wait until the number of non-main popup roots increases (or timeout).
async function waitForPopupRoot(
  deps: UiaDeps,
  win: () => { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  rootsBefore: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tree = await deps.inspectUiTree({ ...win(), includeProcessPopups: true, maxDepth: 2, maxNodes: 60, timeoutMs: 8000 }).catch(() => null);
    const rootsNow = tree ? tree.roots.filter((r) => !r.isMain).length : rootsBefore;
    if (rootsNow > rootsBefore) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Launch a profiled application, resolving the executable via the spec's
// priority chain: explicit exePath > profile env var > config > common build
// dirs > PATH. Returns pid/hwnd/title and whether MCP started it. Never stores
// local absolute paths in the profile.
export async function launchProfile(
  deps: UiaDeps,
  windowsLaunch: (input: { exePath: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number }) => Promise<{ pid: number; window: { hwnd: string; title: string; pid: number; processName: string; className: string; rect: unknown } | null }>,
  listWindows: (filters: { processName?: string }) => Promise<Array<{ hwnd: string; title: string; pid: number; processName: string }>>,
  input: { profile: string; exePath?: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number; reuseIfRunning?: boolean },
  getExeManifestLevel?: (exePath: string) => Promise<string>
): Promise<{ profile: string; pid: number; hwnd?: string; title?: string; startedByMcp: boolean; reused: boolean; uiaRootAvailable: boolean; manifestLevel?: string }> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  if (!profile.executableNames || profile.executableNames.length === 0) {
    throw new McpUiError("PROFILE_NOT_FOUND", `Profile '${input.profile}' has no executableNames; cannot launch.`, { profile: input.profile });
  }

  // Apply pack-declared launch defaults for omitted fields.
  const launchDefaults = profile.launch ?? {};

  // Reuse an already-running instance if allowed.
  if ((input.reuseIfRunning ?? launchDefaults.reuseIfRunning ?? true) !== false) {
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

  // Manifest check: reject an old elevated build BEFORE spawning it. A
  // requireAdministrator exe would trigger a UAC prompt and a non-elevated MCP
  // cannot inspect it anyway. "unknown" (no manifest / unreadable) is reported
  // as a structured warning but does NOT block launch, so a manifest-less dev
  // build can still run.
  let manifestLevel: string | undefined;
  if (profile.requiresAsInvoker && getExeManifestLevel) {
    manifestLevel = await getExeManifestLevel(exePath);
    if (manifestLevel === "requireAdministrator" || manifestLevel === "highestAvailable") {
      throw new McpUiError(
        "ELEVATED_MANIFEST_REJECTED",
        `The executable has a '${manifestLevel}' manifest. A non-elevated MCP cannot inspect it. Rebuild or install a build with an asInvoker manifest; the MCP server does NOT need to run elevated.`,
        { profile: profile.id, exePath, manifestLevel }
      );
    }
  }

  const launched = await windowsLaunch({
    exePath,
    args: input.args,
    waitForWindow: input.waitForWindow ?? launchDefaults.waitForWindow ?? true,
    noActivate: input.noActivate ?? launchDefaults.noActivate ?? true,
    startMinimized: input.startMinimized ?? false,
    timeoutMs: input.timeoutMs ?? launchDefaults.timeoutMs ?? 30000
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
    uiaRootAvailable,
    ...(manifestLevel !== undefined ? { manifestLevel } : {})
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
  // 2. Profile env var (e.g. MY_APP_EXE).
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
// automationId (full-path automationIds are unique).
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

export { isKeyboardInvokeControl as isMenuCommandControl };
