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
import { evaluateExpect } from "../expect.js";
import { evaluateControlState, snapshotFromElement, type ControlStateEvaluation } from "./control-state.js";
import { resolveFallbackPolicy, EXECUTABLE_FALLBACK_METHODS, type FallbackDecision } from "./fallback.js";
import { evaluateVisibility, isRectFullyVisible, toRect, determineScrollDirection, nextRangeValueStep, type RectLike, type VisibilityResult } from "./visibility.js";
import {
  backgroundPolicyForAction,
  effectiveModeFor,
  foregroundRequiredError,
  resolveInteractionMode,
  type InteractionMode,
  type InteractionReport,
  type InteractionOptions
} from "../interaction.js";

// The UIA surface the profile layer needs. index.ts supplies the real
// implementations from the loaded windows.js runtime module.
export type UiaDeps = {
  // Real Win32 client rect (GetClientRect + ClientToScreen) in screen
  // coordinates - used as the window viewport fallback for ensureVisible.
  getWindowClientRectScreen: (input: { hwnd: string | number }) => Promise<{
    x: number; y: number; width: number; height: number; coordinateSpace: "screen"; source: string;
  }>;
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
  // Foreground observation + manipulation (interaction policy support).
  getForegroundWindow: () => Promise<string>;
  activateWindow: (hwnd: string) => Promise<{ activated: boolean; foregroundHwnd: string }>;
  restoreForegroundWindow: (previousForegroundHwnd?: string) => Promise<{ restored: boolean; foregroundHwnd: string; foregroundChanged: boolean }>;
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

  // Declared control search: profile_resolve uses the EXACT same search
  // semantics as profile_action (entry.search.rootControl / maxDepth /
  // depthStrategy > caller explicit params > generic default). A control that
  // profile_action resolves deep in the tree MUST resolve here too.
  const declared = resolveDeclaredControlSearch(profile, entry, input);
  const searchApplied = {
    ...(declared.rootControl !== undefined ? { rootControl: declared.rootControl } : {}),
    ...(declared.maxDepth !== undefined ? { maxDepth: declared.maxDepth } : {}),
    ...(declared.depthStrategy !== undefined ? { depthStrategy: declared.depthStrategy } : {})
  };
  const maxDepth = effectiveSearchMaxDepth(declared, input);
  const depthStrategy = effectiveSearchDepthStrategy(declared);

  const severeCodes = severeErrorCodes();

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    // Compose the declared rootControl into the selector as an ancestor -
    // identical to profile_action's scoping.
    const scopedSelector = scopeSelectorToDeclaredSearch(selector, declared);
    try {
      const result = await deps.getUiElement({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
        selector: scopedSelector,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs,
        ...(depthStrategy === "auto" ? { depthStrategy: "auto" as const } : {})
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

  // All candidates exhausted without a unique match. Surface the SAME
  // semantic failure context profile_action reports (page/component/parent/
  // group/confidence/attempts + structured diagnosticScope + suggestedDiagnostic),
  // so the model diagnoses within the nearest known scope instead of
  // enumerating the whole tree.
  const semanticDetails = semanticFailureContext(entry, {
    profile: profile.id,
    control: input.control,
    candidatesTried: candidatesTried.slice(0, 10),
    searchApplied
  });
  throw new McpUiError(
    "PROFILE_CONTROL_UNRESOLVED",
    `Profile control '${input.control}' could not be resolved to a unique element on the live UI.`,
    semanticDetails ?? {
      profile: profile.id,
      control: input.control,
      confidence,
      notes: entry.notes,
      attempts: candidatesTried.slice(0, 10),
      searchApplied
    },
    "Use scoped ui_query within the nearest known profile control (rootSelector + nameContains + maxResults). Avoid ui_inspect_tree unless scoped search also fails."
  );
}

// Resolve the pack's action contracts for a profile (for backgroundPolicy
// lookup). The profile layer stays data-driven: contracts come from the
// loaded App Pack, never from hardcoded source.
function getPackActions(profileId: string): import("../app-packs/types.js").PackActions | undefined {
  return packRegistry.getPack(profileId)?.actions;
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
  interaction: InteractionReport;
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

  // Interaction mode: explicit > pack default > auto.
  const mode = resolveInteractionMode({ explicit: input.interactionMode, packDefault: profile.interaction?.defaultMode });
  const policy = backgroundPolicyForAction(getPackActions(input.profile), input.control, input.action);

  // background mode: actions the pack declares foregroundRequired are refused
  // BEFORE any UIA work - never executed and never upgraded to foreground.
  if (mode === "background" && policy === "foregroundRequired") {
    throw foregroundRequiredError(
      `Action '${input.action}' on control '${input.control}' is declared foregroundRequired by the App Pack; it has no verified background-safe method.`,
      { requestedMode: mode, backgroundPolicy: policy }
    );
  }

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];
  let lastError: unknown = null;

  const severeCodes = severeErrorCodes();

  // Composite actions (selectByName/selectByIndex/getSelection/openMenu/
  // openSubmenu/ensureSelected) need to resolve the control first, then
  // orchestrate expand -> popup -> item -> verify across multiple UIA calls.
  // Resolve the unique element up front. `invoke` on a menu command declared
  // with menu.invokeMode="keyboard-enter" is also routed here: those rows open
  // a modal dialog whose exec() blocks InvokePattern.Invoke(), so the
  // composite path triggers them via a non-blocking focus + Enter key.
  const composite = new Set(["selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected", "ensureVisible"]);
  if (composite.has(input.action) || (input.action === "invoke" && isKeyboardInvokeControl(entry))) {
    const foregroundBefore = await readForeground(deps);
    const compositeResult = await performCompositeProfileAction(deps, profile, input, entry, windowSel, mode, policy);
    // Composite actions verify before/after state; a failed verification is a
    // step failure, not a silent success.
    const resultValue = compositeResult.result as { success?: boolean } | undefined;
    if (resultValue && resultValue.success === false) {
      throw new McpUiError("ACTION_FAILED", `Composite action '${input.action}' on '${input.control}' did not verify (before/after state check failed).`, {
        profile: profile.id, control: input.control, action: input.action, result: compositeResult.result
      });
    }
    let foregroundAfter = await readForeground(deps);
    let foregroundChanged = foregroundBefore !== undefined && foregroundAfter !== undefined && foregroundBefore !== foregroundAfter;
    let foregroundRestored: boolean | undefined;
    if (mode === "background" && foregroundChanged && foregroundBefore !== undefined) {
      foregroundRestored = await restoreIfChanged(deps, foregroundBefore);
      foregroundAfter = await readForeground(deps);
      foregroundChanged = foregroundAfter !== undefined && foregroundAfter !== foregroundBefore;
    }
    const method = (compositeResult.result as { method?: string }).method;
    return {
      ...compositeResult,
      interaction: buildActionReport(mode, policy, foregroundBefore, foregroundAfter, foregroundChanged, method, false, foregroundRestored)
    };
  }

  const foregroundBefore = await readForeground(deps);
  // Declared control search for the non-composite path (pack entry.search >
  // caller explicit params > generic default) - same helper as
  // profile_resolve, so both tools search the same depth/scope for the same
  // control.
  const declared = resolveDeclaredControlSearch(profile, entry, input);
  const maxDepth = effectiveSearchMaxDepth(declared, input);
  const depthStrategy = effectiveSearchDepthStrategy(declared);
  const searchApplied = {
    ...(declared.rootControl !== undefined ? { rootControl: declared.rootControl } : {}),
    ...(declared.maxDepth !== undefined ? { maxDepth: declared.maxDepth } : {}),
    ...(declared.depthStrategy !== undefined ? { depthStrategy: declared.depthStrategy } : {})
  };
  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      // Pack-declared LOCAL search depth (entry.search) applies to the
      // non-composite path too: deep controls (e.g. ~20 levels inside Qt
      // stacks) need a deeper walk than the global default 15. The declared
      // rootControl is composed into the selector as an ancestor so the walk
      // stays scoped to that subtree.
      const scopedSelector = scopeSelectorToDeclaredSearch(selector, declared);
      const result = await deps.performUiAction({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
        selector: scopedSelector,
        action: input.action,
        value: input.value,
        rangeValue: input.rangeValue,
        allowCoordinateFallback: input.allowCoordinateFallback,
        allowMessageClickFallback: input.allowMessageClickFallback,
        forceCoordinateClick: input.forceCoordinateClick,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs,
        ...(depthStrategy === "auto" ? { depthStrategy: "auto" as const } : {})
      });
      let foregroundAfter = await readForeground(deps);
      let foregroundChanged = foregroundBefore !== undefined && foregroundAfter !== undefined && foregroundBefore !== foregroundAfter;
      // background mode: an action must never leave the foreground changed;
      // if the target (or something else) stole it, restore the original and
      // verify the FINAL state (the app can re-steal immediately).
      let foregroundRestored: boolean | undefined;
      if (mode === "background" && foregroundChanged && foregroundBefore !== undefined) {
        foregroundRestored = await restoreIfChanged(deps, foregroundBefore);
        foregroundAfter = await readForeground(deps);
        foregroundChanged = foregroundAfter !== undefined && foregroundAfter !== foregroundBefore;
      }
      return {
        profile: profile.id,
        control: input.control,
        selectorUsed: selector,
        confidence,
        notes: entry.notes,
        result,
        interaction: buildActionReport(mode, policy, foregroundBefore, foregroundAfter, foregroundChanged, result.method, false, foregroundRestored)
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
    // Enrich an unresolved-control failure with the control's SEMANTIC
    // context (page/component/parent/group + candidatesTried + searchApplied +
    // a structured diagnostic scope), so the model diagnoses within the
    // nearest known scope instead of enumerating the whole tree or
    // re-deriving selectors.
    const semanticDetails = semanticFailureContext(entry, {
      profile: profile.id,
      control: input.control,
      candidatesTried: candidatesTried.slice(0, 10),
      searchApplied
    });
    if (lastError.code === "ELEMENT_NOT_FOUND" && semanticDetails) {
      throw new McpUiError(
        "PROFILE_CONTROL_UNRESOLVED",
        `Profile control '${input.control}' could not be resolved to a unique element on the live UI.`,
        semanticDetails,
        lastError.suggestion
      );
    }
    if (semanticDetails) {
      throw new McpUiError(
        lastError.code,
        lastError.message,
        { ...(typeof lastError.details === "object" && lastError.details !== null ? { ...(lastError.details as Record<string, unknown>) } : {}), ...semanticDetails },
        lastError.suggestion
      );
    }
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

// ── Shared declared-control-search resolution ──
//
// profile_action and profile_resolve MUST resolve the same control with the
// same search semantics: the pack-declared entry.search (rootControl /
// maxDepth / depthStrategy) scopes and deepens the walk, caller-provided
// maxDepth/depthStrategy are only a fallback, and the declared rootControl is
// composed into the selector as an ancestor so the walk stays inside that
// subtree. One helper - two callers - one invariant.
export type DeclaredControlSearch = {
  // The entry's declared search bounds, normalized.
  maxDepth?: number;
  depthStrategy?: "fixed" | "auto";
  maxResults?: number;
  // The declared rootControl resolved to its first candidate selector (the
  // ancestor used to scope the walk), when both declared and resolvable.
  rootSelector?: UiElementSelector;
  rootControl?: string;
};

export function resolveDeclaredControlSearch(
  profile: AppProfile | undefined,
  entry: Pick<ControlEntry, "selectors" | "search">,
  input?: { maxDepth?: number }
): DeclaredControlSearch {
  const search = entry.search;
  const rootControl = search?.rootControl;
  // A missing profile (or one without controls) simply cannot resolve a
  // declared rootControl - the walk stays unscoped, never a crash.
  const rootSelector = rootControl && profile?.controls ? firstSelectorOf(profile, rootControl) : undefined;
  return {
    ...(search?.maxDepth !== undefined ? { maxDepth: search.maxDepth } : {}),
    ...(search?.depthStrategy !== undefined ? { depthStrategy: search.depthStrategy } : {}),
    ...(search?.maxResults !== undefined ? { maxResults: search.maxResults } : {}),
    ...(rootSelector ? { rootSelector, rootControl } : {})
  };
}

// Apply the declared search scope to a base selector: the declared
// rootControl (when resolvable) becomes the ancestor so the walk stays scoped
// to that subtree. Identical composition in every caller.
export function scopeSelectorToDeclaredSearch(
  selector: UiElementSelector,
  search: DeclaredControlSearch
): UiElementSelector {
  return search.rootSelector ? { ...selector, ancestor: search.rootSelector } : selector;
}

// Effective maxDepth for a control resolution: pack-declared entry.search
// wins, then the caller's explicit maxDepth, then the generic default. This
// mirrors the non-composite profile_action path exactly.
export function effectiveSearchMaxDepth(
  declared: DeclaredControlSearch,
  input?: { maxDepth?: number },
  fallback = 15
): number {
  return declared.maxDepth ?? input?.maxDepth ?? fallback;
}

export function effectiveSearchDepthStrategy(
  declared: DeclaredControlSearch
): "fixed" | "auto" {
  return declared.depthStrategy ?? "fixed";
}

export function severeErrorCodes(): Set<string> {
  return new Set([
    "WINDOW_NOT_FOUND",
    "WINDOW_AMBIGUOUS",
    "UIA_ROOT_UNAVAILABLE",
    "UIA_ASSEMBLY_UNAVAILABLE",
    "TARGET_PROCESS_EXITED",
    "INVALID_SELECTOR"
  ]);
}

// Record one candidate outcome in the candidatesTried list (shared by
// profile_action and profile_resolve so both report the same attempt trace).
export function recordCandidateAttempt(
  candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }>,
  selector: UiElementSelector,
  outcome: string,
  message?: string
): void {
  candidatesTried.push(message !== undefined ? { selector, outcome, message } : { selector, outcome });
}

// Build the semantic diagnostic context for a failed control resolution:
// the control's declared page/component/parent/group, the candidates tried,
// and a machine-usable diagnosticScope pointing at the nearest RESOLVABLE
// container (the control's own search.rootControl when declared - a logical
// control that the profile can resolve - falling back to parent/group, then
// page). Never app-specific; reads only the entry's declared metadata.
export function semanticFailureContext(
  entry: ControlEntry,
  base: {
    profile: string;
    control: string;
    candidatesTried: unknown[];
    searchApplied?: { rootControl?: string; maxDepth?: number; depthStrategy?: string };
  }
): Record<string, unknown> | undefined {
  const parent = entry.parent ?? entry.group;
  // search.rootControl is the strongest diagnostic root: it is a logical
  // control id the profile can resolve to a real selector.
  const scopedRoot = entry.search?.rootControl ?? parent ?? entry.page;
  const diagnosticScope = scopedRoot
    ? { rootControl: scopedRoot, maxResults: 10 }
    : undefined;
  return {
    profile: base.profile,
    control: base.control,
    ...(entry.page ? { page: entry.page } : {}),
    ...(entry.parent ? { component: entry.parent } : {}),
    ...(entry.parent ? { parent: entry.parent } : {}),
    ...(entry.group ? { group: entry.group } : {}),
    candidatesTried: base.candidatesTried,
    ...(base.searchApplied ? { searchApplied: base.searchApplied } : {}),
    ...(diagnosticScope ? { diagnosticScope } : {}),
    suggestedDiagnostic: diagnosticScope
      ? { tool: "ui_query", withinControl: diagnosticScope.rootControl, maxResults: 10 }
      : undefined
  };
}

// Read the current foreground hwnd (best-effort; undefined when unavailable).
async function readForeground(deps: UiaDeps): Promise<string | undefined> {
  try {
    return await deps.getForegroundWindow();
  } catch {
    return undefined;
  }
}

// background mode: restore the previous foreground window and report whether
// the restore worked. Best-effort - a failed restore is reported, never
// silently presented as clean background.
async function restoreIfChanged(deps: UiaDeps, previousForegroundHwnd: string): Promise<boolean> {
  try {
    const r = await deps.restoreForegroundWindow(previousForegroundHwnd);
    return r.restored;
  } catch {
    return false;
  }
}

function buildActionReport(
  mode: InteractionMode,
  policy: import("../interaction.js").BackgroundPolicy | undefined,
  foregroundBefore: string | undefined,
  foregroundAfter: string | undefined,
  foregroundChanged: boolean,
  method: string | undefined,
  targetActivated: boolean,
  foregroundRestored?: boolean
): InteractionReport {
  return {
    requestedMode: mode,
    effectiveMode: effectiveModeFor(mode, foregroundChanged || targetActivated),
    ...(policy ? { backgroundPolicy: policy } : {}),
    ...(method ? { method } : {}),
    ...(foregroundBefore ? { foregroundBefore } : {}),
    ...(foregroundAfter ? { foregroundAfter } : {}),
    foregroundChanged,
    ...(foregroundRestored !== undefined ? { foregroundRestored } : {}),
    targetActivated,
    physicalCursorMoved: false
  };
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
  getWindowClientRectScreen: (input: { hwnd: string | number }) => Promise<{ x: number; y: number; width: number; height: number; coordinateSpace: "screen"; source: string }>;
  getUiElement: (input: never) => Promise<GetResult>;
  performUiAction: (input: never) => Promise<ActionResult>;
  queryUi: (input: never) => Promise<QueryResult>;
  inspectUiTree: (input: never) => Promise<InspectTreeResult>;
  sendKey: (input: never) => Promise<unknown>;
  getForegroundWindowHwnd: () => Promise<string>;
  activateWindow: (hwnd: string) => Promise<{ activated: boolean; foregroundHwnd: string }>;
  restoreForegroundWindow: (previousForegroundHwnd?: string) => Promise<{ restored: boolean; foregroundHwnd: string; foregroundChanged: boolean }>;
}): UiaDeps {
  return {
    getWindowClientRectScreen: windows.getWindowClientRectScreen as UiaDeps["getWindowClientRectScreen"],
    getUiElement: windows.getUiElement as UiaDeps["getUiElement"],
    performUiAction: windows.performUiAction as UiaDeps["performUiAction"],
    queryUi: windows.queryUi as UiaDeps["queryUi"],
    inspectUiTree: windows.inspectUiTree as UiaDeps["inspectUiTree"],
    sendKey: windows.sendKey as UiaDeps["sendKey"],
    getForegroundWindow: windows.getForegroundWindowHwnd as UiaDeps["getForegroundWindow"],
    activateWindow: windows.activateWindow as UiaDeps["activateWindow"],
    restoreForegroundWindow: windows.restoreForegroundWindow as UiaDeps["restoreForegroundWindow"]
  };
}

// Resolve a profile control to the first candidate selector that uniquely
// matches. Used by composite actions which need a concrete selector to drive
// sub-actions (expand/select) on the resolved control.
//
// The control's pack-declared `search` scope (rootControl / maxDepth /
// depthStrategy) is honored: LOCAL bounds for that control, never a global
// query-depth raise. The declared rootControl, if any, is composed into the
// selector as an ancestor so the walk is scoped to that subtree.
async function resolveUniqueSelector(
  deps: UiaDeps,
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  entry: { selectors: UiElementSelector[]; search?: { rootControl?: string; maxDepth?: number; depthStrategy?: "fixed" | "auto"; maxResults?: number } },
  input: { includeProcessPopups?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number },
  profile?: AppProfile
): Promise<UiElementSelector> {
  const severeCodes = severeErrorCodes();
  // The composite path resolves the control with the SAME declared search
  // semantics as profile_action/profile_resolve (entry.search.rootControl /
  // maxDepth / depthStrategy > caller params > generic default). A missing
  // profile simply cannot resolve a declared rootControl (same as the
  // non-composite path).
  const declared = resolveDeclaredControlSearch(profile as AppProfile, entry, input);
  const maxDepth = effectiveSearchMaxDepth(declared, input);
  const depthStrategy = effectiveSearchDepthStrategy(declared);
  for (const base of entry.selectors) {
    const selector = scopeSelectorToDeclaredSearch(base, declared);
    try {
      const r = await deps.getUiElement({
        hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains,
        selector, includeProcessPopups: input.includeProcessPopups,
        maxDepth,
        maxNodes: input.maxNodes, timeoutMs: input.timeoutMs,
        ...(depthStrategy === "auto" ? { depthStrategy: "auto" as const } : {})
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
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  mode: InteractionMode = "auto",
  policy?: import("../interaction.js").BackgroundPolicy
): Promise<{ profile: string; control: string; selectorUsed?: UiElementSelector; confidence?: SelectorConfidence; notes?: string; result: unknown }> {
  const selector = await resolveUniqueSelector(deps, windowSel, entry, input, profile);
  const actionTimeout = input.timeoutMs ?? 15000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const win = () => ({ hwnd: windowSel.hwnd, pid: windowSel.pid, processName: windowSel.processName, titleContains: windowSel.titleContains });
  // Pack-declared LOCAL search depth for this control: the resolved selector
  // may be deep in the tree (e.g. ~20 levels in Qt stacks). All follow-up
  // UIA calls on this control reuse the declared depth - never a global raise.
  const localMaxDepth = entry.search?.maxDepth ?? input.maxDepth ?? 15;
  const localDepthStrategy = entry.search?.depthStrategy ?? "fixed";
  const act = <T extends { selector: UiElementSelector; action: string }>(over: T): Parameters<UiaDeps["performUiAction"]>[0] => ({
    ...win(),
    includeProcessPopups: true,
    timeoutMs: actionTimeout,
    maxDepth: localMaxDepth,
    ...(localDepthStrategy === "auto" ? { depthStrategy: "auto" as const } : {}),
    ...over
  });

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

  // ── ensureVisible: scroll a control into view (generic composite). ──
  // Resolves the control, checks whether it is already fully within the
  // visible client area, then tries, in order: ScrollItemPattern on the
  // control itself; the pack-declared scroll container (RangeValuePattern
  // absolute scroll); a wheel message on the scroll container (window
  // message, never the physical mouse). After scrolling, the control is
  // re-resolved and its visibility re-verified. Success requires the control
  // to be found AND fully visible (or offscreen:false), never just "action
  // fired". The model never computes scrollbar values or coordinates - the
  // pack declares the scroll container, this composite drives it.
  if (input.action === "ensureVisible") {
    const visibility = (entry as ControlEntry & { visibility?: { scrollContainer?: string; strategies?: string[]; margin?: number } }).visibility;
    const scrollContainer = visibility?.scrollContainer;
    const strategies = visibility?.strategies ?? ["ScrollItemPattern", "RangeValueScroll", "WindowMessageWheel"];
    const margin = Math.max(0, visibility?.margin ?? 0);
    const waitSettle = (ms: number) => sleep(ms);

    const readElement = async (): Promise<UiElementState | null> => {
      const r = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth }).catch(() => null);
      return r?.element ?? null;
    };

    // Effective viewport: declared scrollContainer boundingRect (screen
    // space) first, then the page rootControl, then the top-level window's
    // client rect converted to screen. UIA boundingRect is ALWAYS screen
    // space, so all rects compare in the same space - no client/screen mix.
    const resolveViewport = async (): Promise<{ rect: RectLike | null; source: VisibilityResult["viewportSource"] }> => {
      const tryControl = async (controlId: string): Promise<RectLike | null> => {
        const entryRef = normalizeControlEntry(profile.controls[controlId]);
        if (!entryRef) return null;
        for (const s of entryRef.selectors) {
          try {
            const r = await deps.getUiElement({ ...win(), selector: s, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth });
            if (r.found) return toRect(r.element.boundingRect) ?? null;
          } catch { /* try next */ }
        }
        return null;
      };
      if (scrollContainer) {
        const r = await tryControl(scrollContainer);
        if (r) return { rect: r, source: "scrollContainer" };
      }
      const root = (entry as ControlEntry & { page?: string }).page;
      if (root) {
        const page = packRegistry.getPack(profile.id)?.pages?.pages.find((p) => p.id === root);
        if (page?.rootControl) {
          const r = await tryControl(page.rootControl);
          if (r) return { rect: r, source: "pageRoot" };
        }
      }
      // Fall back to the real Win32 client rect (GetClientRect +
      // ClientToScreen, screen space) - NEVER the UIA Window boundingRect
      // (which includes the title bar, borders and shadows and would mark
      // elements near the window edge as falsely fully visible). When the
      // client rect is unavailable, fall back to the window bounding rect but
      // label it accurately - it is NOT the client area.
      const hwnd = windowSel.hwnd;
      if (hwnd !== undefined) {
        try {
          const client = await deps.getWindowClientRectScreen({ hwnd });
          if (client && client.coordinateSpace === "screen" && client.width > 0 && client.height > 0) {
            return { rect: { x: client.x, y: client.y, width: client.width, height: client.height }, source: "windowClientRect" };
          }
        } catch { /* invalid/minimized hwnd - fall through to the explicit bounding-rect fallback */ }
      }
      try {
        const winRect = await deps.getUiElement({ ...win(), selector: { controlType: "Window" }, includeProcessPopups: true, timeoutMs: actionTimeout });
        if (winRect.found) return { rect: toRect(winRect.element.boundingRect) ?? null, source: "windowBoundingRect" };
      } catch { /* ignore */ }
      return { rect: null, source: "none" };
    };

    const checkVisible = async (e: UiElementState | null): Promise<VisibilityResult | null> => {
      if (!e) return null;
      const vp = await resolveViewport();
      if (vp.rect) lastViewportRect = vp.rect;
      return evaluateVisibility(e, vp.rect, margin, vp.source);
    };

    // Last known viewport rect (used by the direction logic so each scroll
    // step compares against the CURRENT viewport, re-resolved after every
    // scroll).
    let lastViewportRect: RectLike | null = null;

    let element = await readElement();
    if (!element) {
      throw new McpUiError("ELEMENT_NOT_FOUND", `ensureVisible: control '${input.control}' could not be resolved.`, { control: input.control });
    }
    let vis = await checkVisible(element);
    if (vis?.fullyVisible) {
      return {
        profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
        result: { success: true, method: "noop", alreadyVisible: true, scrolled: false, ...vis }
      };
    }

    const attemptedStrategies: string[] = [];
    let scrollValueChanged = false;
    let scrollDirection: import("./visibility.js").ScrollDirection = "none";
    let initialScrollValue: number | null = null;
    let finalScrollValue: number | null = null;
    let attemptCount = 0;
    const deadline = Date.now() + (input.timeoutMs ?? 15000);

    // Direction from the CURRENT element/viewport geometry (margin-aware).
    // Pure function - never derived from control names.
    const currentDirection = (): import("./visibility.js").ScrollDirection => {
      const eRect = toRect(element?.boundingRect);
      const vpRect = lastViewportRect;
      return determineScrollDirection(eRect, vpRect, margin);
    };

    // 1) ScrollItemPattern on the control itself.
    if (strategies.includes("ScrollItemPattern") && element.patterns.some((p) => p.includes("ScrollItem"))) {
      attemptedStrategies.push("ScrollItemPattern");
      try {
        await deps.performUiAction(act({ selector, action: "scrollIntoView" }));
        await waitSettle(250);
        element = await readElement();
        vis = await checkVisible(element);
        if (vis?.fullyVisible) {
          return {
            profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
            result: { success: true, method: "ScrollItemPattern", alreadyVisible: false, scrolled: true, ...vis }
          };
        }
      } catch { /* pattern not supported or scroll did not take - continue */ }
    }

    // 2) Declared scroll container: direction-aware FINITE RangeValue steps.
    //    Never jumps straight to maximum/minimum; each step is bounded by
    //    largeChange/smallChange/range proportion and re-verifies geometry.
    if (scrollContainer && strategies.includes("RangeValueScroll") && Date.now() < deadline) {
      attemptedStrategies.push("RangeValueScroll");
      const containerEntry = normalizeControlEntry(profile.controls[scrollContainer]);
      if (containerEntry) {
        for (const containerSelector of containerEntry.selectors) {
          try {
            const container = await deps.getUiElement({ ...win(), selector: containerSelector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth });
            if (container.found && container.element?.patterns.some((p) => p.includes("RangeValue"))) {
              // Mutable snapshot: EVERY round computes the next target from
              // the LATEST range metadata (rangeValue/minimum/maximum/
              // smallChange/largeChange). A fixed initial snapshot would
              // repeat the first target forever and stop after one step.
              let currentRange = container.element;
              initialScrollValue = currentRange.rangeValue;
              for (let step = 0; step < 8 && Date.now() < deadline; step++) {
                attemptCount++;
                const dir = currentDirection();
                if (dir === "none") break;
                scrollDirection = dir;
                const previousValue = currentRange.rangeValue ?? 0;
                const target = nextRangeValueStep(previousValue, dir, currentRange);
                if (target === previousValue) break; // at minimum/maximum - no progress possible
                await deps.performUiAction(act({ selector: containerSelector, action: "setRangeValue", rangeValue: target }));
                await waitSettle(200);
                // Re-resolve the scroll container for a FRESH range snapshot.
                const refreshed = await deps.getUiElement({ ...win(), selector: containerSelector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth }).catch(() => null);
                if (!refreshed?.found || !refreshed.element) break; // container vanished
                const newValue = refreshed.element.rangeValue ?? previousValue;
                // Compare against the PREVIOUS round's REAL value (not the
                // initial snapshot, not this round's target).
                if (newValue !== previousValue) {
                  scrollValueChanged = true;
                  currentRange = refreshed.element; // next round computes from the FRESH state
                } else {
                  break; // scroll value did not change - stop
                }
                // Re-resolve target element, viewport and visibility: layout
                // may have changed, and the next direction must be judged
                // from the CURRENT geometry.
                element = await readElement();
                vis = await checkVisible(element);
                if (vis?.fullyVisible) break;
              }
              finalScrollValue = currentRange.rangeValue ?? initialScrollValue;
              if (vis?.fullyVisible) {
                return {
                  profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
                  result: { success: true, method: "RangeValueScroll", alreadyVisible: false, scrolled: true, scrollContainer, ...vis, scrollDirection, attemptedStrategies, initialScrollValue, finalScrollValue, attemptCount }
                };
              }
              break;
            }
          } catch { /* try next container selector */ }
        }
      }
    }

    // 3) Step messages on the scroll container (window message, never the
    //    physical mouse). forward -> increment, backward -> decrement (the
    //    standard vertical-scrollbar mapping; the helper actions are named
    //    after the UIA RangeValue semantics). Re-resolve + re-verify after
    //    every step; stop when the scroll value stops changing, the
    //    direction reverses without improvement, or the deadline passes.
    if (scrollContainer && strategies.includes("WindowMessageWheel") && Date.now() < deadline) {
      attemptedStrategies.push("WindowMessageWheel");
      const containerEntry = normalizeControlEntry(profile.controls[scrollContainer]);
      if (containerEntry) {
        for (const containerSelector of containerEntry.selectors) {
          try {
            const container = await deps.getUiElement({ ...win(), selector: containerSelector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth });
            if (!container.found || !container.element?.nativeWindowHandle) continue;
            const containerRect = toRect(container.element.boundingRect);
            const ctrlRect = toRect((await readElement())?.boundingRect);
            if (!containerRect || !ctrlRect) continue;
            let lastValue = container.element.rangeValue;
            let lastDirection: import("./visibility.js").ScrollDirection = "none";
            for (let step = 0; step < 10 && Date.now() < deadline; step++) {
              attemptCount++;
              const dir = currentDirection();
              if (dir === "none") break;
              scrollDirection = dir;
              // Direction reversal without improvement: stop (avoids
              // oscillation loops).
              if (lastDirection !== "none" && lastDirection !== dir) {
                const improved = vis?.fullyVisible === true;
                if (!improved) break;
              }
              lastDirection = dir;
              const action = dir === "forward" ? "increment" : "decrement";
              try {
                await deps.performUiAction(act({ selector: containerSelector, action }));
              } catch { /* not a range control; nothing to step */ }
              await waitSettle(120);
              const re = await deps.getUiElement({ ...win(), selector: containerSelector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth }).catch(() => null);
              const newValue = re?.element?.rangeValue;
              if (newValue !== undefined && newValue !== null && newValue !== lastValue) {
                scrollValueChanged = true;
                lastValue = newValue;
              } else if (newValue !== undefined && newValue !== null) {
                break; // no change: stop stepping
              }
              element = await readElement();
              vis = await checkVisible(element);
              if (vis?.fullyVisible) break;
            }
            if (vis?.fullyVisible) {
              return {
                profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
                result: { success: true, method: "WindowMessageWheel", alreadyVisible: false, scrolled: true, scrollContainer, ...vis, scrollDirection, attemptedStrategies, initialScrollValue, finalScrollValue: lastValue, attemptCount }
              };
            }
          } catch { /* try next container selector */ }
        }
      }
    }

    // Failure: report the geometry truth, not just offscreen.
    const finalVis = await checkVisible(element);
    const details: Record<string, unknown> = {
      control: input.control,
      ...(finalVis?.elementRect ? { elementRect: finalVis.elementRect } : {}),
      ...(finalVis?.viewportRect ? { viewportRect: finalVis.viewportRect } : {}),
      margin,
      offscreen: finalVis?.offscreen ?? true,
      visible: finalVis?.visible ?? false,
      fullyVisible: finalVis?.fullyVisible ?? false,
      attemptedStrategies,
      scrollValueChanged,
      viewportSource: finalVis?.viewportSource ?? "none"
    };
    throw new McpUiError(
      "ELEMENT_NOT_FULLY_VISIBLE",
      `ensureVisible: control '${input.control}' is not fully visible within the viewport (margin ${margin}).`,
      details,
      "Verify the control exists, its visibility.scrollContainer is declared, and the scroll strategies are supported."
    );
  }

  // ── ensureSelected: make a checkable control selected (idempotent). ──
  // Success requires BOTH the control state (selected/toggleState On) AND the
  // declared business postconditions (pack defaultExpect + control-level
  // postconditions, unless expect:false). A control that reports selected
  // while the business state is NOT satisfied is ACTION_STATE_INCONSISTENT -
  // never a silent success. When the pack allows a window-message fallback
  // (fallbackPolicy != "disabled"), the fallback is attempted and the business
  // state re-verified. UIA toggleState alone NEVER proves content switched:
  // the business postconditions reference content markers declared in the
  // pack's semantic map.
  if (input.action === "ensureSelected") {
    const packActions = getPackActions(profile.id);
    const contract = packActions?.contracts.find((c) => c.control === input.control && c.action === "ensureSelected");
    const expect = contract?.defaultExpect;
    const expectEnabled = input.expect !== false;
    // Fallback decision: caller opt-in AND control-level policy AND
    // action-contract policy AND interactionMode, in that priority.
    const fallback = resolveFallbackPolicy({
      controlEntry: entry,
      actionContract: contract,
      callOptions: { allowMessageClickFallback: input.allowMessageClickFallback, allowCoordinateFallback: input.allowCoordinateFallback },
      interactionMode: mode
    });
    const fallbackAllowed = fallback.enabled;
    // Control-level semantic postconditions (controls.json postconditions) are
    // evaluated in ADDITION to the action contract's defaultExpect.
    const controlPostconditions = (entry as ControlEntry & { postconditions?: Array<{ profileControl: string; condition: string; timeoutMs?: number; pollIntervalMs?: number; toggleState?: string; expectedValue?: string }> }).postconditions ?? [];
    // Declared controlState requirement (authoritative when present; the
    // legacy selected/toggleState default applies only when undeclared).
    const declaredControlState = (entry as ControlEntry & { controlState?: { any?: Array<{ condition: string; expectedValue?: string; toggleState?: string }>; all?: Array<{ condition: string; expectedValue?: string; toggleState?: string }> } }).controlState;

    // controlState verification: pack-declared conditions when present, else
    // the legacy default (selected OR toggleState On).
    const evaluateState = (e: Partial<UiElementState> | null | undefined): ControlStateEvaluation =>
      evaluateControlState(snapshotFromElement(e), declaredControlState as never);

    // Evaluate one postcondition (contract defaultExpect OR control-level).
    // The referenced control's pack-declared `search` scope (maxDepth /
    // depthStrategy) is honored - deep content markers need a deeper LOCAL
    // walk, never a global raise.
    const evaluateOne = async (cond: { profileControl?: string; selector?: unknown; condition: string; timeoutMs?: number; pollIntervalMs?: number; toggleState?: string; expectedValue?: string }): Promise<{ ok: boolean; reason: string }> => {
      const refControl = cond.profileControl ? normalizeControlEntry(profile.controls[cond.profileControl]) : undefined;
      const refSearch = (refControl as ControlEntry & { search?: { maxDepth?: number; depthStrategy?: "fixed" | "auto" } }).search;
      const result = await evaluateExpect(
        { getUiElement: (i) => deps.getUiElement(i), queryUi: (i) => deps.queryUi(i) },
        {
          ...(cond as Parameters<typeof evaluateExpect>[1]),
          profile,
          hwnd: windowSel.hwnd,
          pid: windowSel.pid,
          includeProcessPopups: true,
          timeoutMs: cond.timeoutMs ?? 6000,
          pollIntervalMs: cond.pollIntervalMs ?? 150,
          maxDepth: refSearch?.maxDepth ?? 15
        }
      );
      return result.matched ? { ok: true, reason: "" } : { ok: false, reason: `postcondition '${cond.condition}' not satisfied` };
    };

    // businessState verification: ALL declared postconditions must hold.
    const verifyBusiness = async (): Promise<{ ok: boolean; reason?: string }> => {
      const checks: Array<{ profileControl?: string; selector?: unknown; condition: string; timeoutMs?: number; pollIntervalMs?: number; toggleState?: string; expectedValue?: string }> = [];
      if (expectEnabled && expect) checks.push(expect);
      checks.push(...controlPostconditions);
      if (checks.length === 0) {
        // No declared business postcondition: control state is the whole
        // story (may still be verified by the caller via expect).
        return { ok: true };
      }
      for (const check of checks) {
        const r = await evaluateOne(check);
        if (!r.ok) return { ok: false, reason: r.reason };
      }
      return { ok: true };
    };

    const readControl = async () => {
      const r = await deps.getUiElement({ ...win(), selector, includeProcessPopups: true, timeoutMs: actionTimeout, maxDepth: localMaxDepth }).catch(() => null);
      return r?.element ?? null;
    };

    // Run one activation attempt and re-read the control. Returns the method
    // actually used (or failed=true when the attempt itself failed and no
    // further attempt should be made on this path).
    // The method -> UIA action map is EXACTLY the shared fallback enum: every
    // declared method has a real mapping, and an unknown method is a hard
    // error - NEVER a silent default to invoke.
    const actionFor: Record<import("../app-packs/enums.js").FallbackMethod, string> = {
      SelectionItemPattern: "select",
      TogglePattern: "toggle",
      InvokePattern: "invoke",
      WindowMessageElementClick: "windowMessageClick"
    };
    const attemptMethod = async (m: string): Promise<{ method: string; element: Partial<UiElementState> | null; failed: boolean }> => {
      const action = actionFor[m as import("../app-packs/enums.js").FallbackMethod];
      if (!action) {
        throw new McpUiError(
          "UNSUPPORTED_FALLBACK_METHOD",
          `Fallback method '${m}' is not implemented by the executor (supported: ${Object.keys(actionFor).join(", ")}).`,
          { control: input.control, method: m }
        );
      }
      try {
        const r = await deps.performUiAction(act({ selector, action }));
        if (!r.success) throw new McpUiError("ACTION_FAILED", `${m} did not succeed.`, { control: input.control });
        return { method: r.method ?? m, element: await readControl(), failed: false };
      } catch (error) {
        if (error instanceof McpUiError && (error.code === "PATTERN_NOT_SUPPORTED" || error.code === "ACTION_FAILED")) {
          return { method: m, element: null, failed: true };
        }
        throw error;
      }
    };

    // The primary attempt is InvokePattern (or the first declared fallback
    // method when the pack declares an explicit method list); subsequent
    // declared methods are tried in order. Every attempt re-verifies control
    // state AND business postconditions; success stops immediately.
    const methods = fallback.methods.length > 0 ? fallback.methods : ["InvokePattern"];
    const attemptedMethods: string[] = [];
    let successfulMethod: string | undefined;
    let after: Partial<UiElementState> | null = null;
    const before = await readControl();

    // Idempotent shortcut: if the control already satisfies the declared
    // state AND the business postconditions, no action is needed.
    const beforeEval = evaluateState(before);
    if (beforeEval.matched && (await verifyBusiness()).ok) {
      return {
        profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
        result: {
          success: true, method: "noop", alreadySelected: true, toggleState: before?.toggleState ?? null,
          controlStateVerified: true, controlStateUsedDefault: beforeEval.usedDefault,
          controlStateEvaluation: { conditions: beforeEval.conditions },
          businessStateVerified: true,
          fallbackPolicyResolved: { enabled: fallback.enabled, methods: fallback.methods, source: fallback.source },
          attemptedMethods: [], successfulMethod: null, fallbackUsed: false, physicalCursorMoved: false
        }
      };
    }

    for (const m of methods) {
      attemptedMethods.push(m);
      const attempt = await attemptMethod(m);
      if (attempt.failed) continue;
      after = attempt.element;
      const stateEval = evaluateState(after);
      const business = await verifyBusiness();
      if (stateEval.matched && business.ok) {
        successfulMethod = attempt.method;
        break;
      }
    }

    if (!successfulMethod) {
      // Everything attempted and nothing verified: report the failing
      // conditions with the actual values.
      const stateEval = evaluateState(after);
      const business = await verifyBusiness();
      const failedConditions = stateEval.conditions.filter((c) => !c.matched).map((c) => ({ condition: c.condition, expected: c.expected, actual: c.actual }));
      const details: Record<string, unknown> = {
        profile: profile.id, control: input.control, action: input.action,
        attemptedMethods, successfulMethod: null,
        controlStateEvaluation: stateEval, businessState: business.reason,
        fallbackUsed: attemptedMethods.length > 1, physicalCursorMoved: false
      };
      if (failedConditions.length > 0) details.failedControlStateConditions = failedConditions;
      if (business.reason) details.failedPostconditions = [business.reason];
      throw new McpUiError(
        "ACTION_STATE_INCONSISTENT",
        `ensureSelected did not verify: control state and/or business postconditions not satisfied after [${attemptedMethods.join(", ")}].`,
        details,
        "Verify the actual page/content state; the control may not accept the declared methods, or the content did not switch."
      );
    }

    const stateEval = evaluateState(after);
    const business = await verifyBusiness();
    const fallbackUsed = attemptedMethods.length > 1;
    const preState = before?.toggleState ?? null;
    return {
      profile: profile.id, control: input.control, selectorUsed: selector, confidence: entry.confidence, notes: entry.notes,
      result: {
        success: true, method: successfulMethod, alreadySelected: attemptedMethods[0] === "InvokePattern" && fallback.methods.length === 0 ? false : undefined,
        before: preState, after: after?.toggleState ?? null,
        controlStateVerified: stateEval.matched,
        controlStateUsedDefault: stateEval.usedDefault,
        controlStateEvaluation: { conditions: stateEval.conditions },
        businessStateVerified: business.ok,
        fallbackPolicyResolved: { enabled: fallback.enabled, methods: fallback.methods, source: fallback.source },
        attemptedMethods,
        successfulMethod,
        fallbackUsed,
        physicalCursorMoved: false
      }
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
    // background mode: the keyboard fallback (focus + Alt+Down / arrows /
    // Enter) is keyboard interaction the background contract forbids. Refuse
    // with FOREGROUND_REQUIRED instead of executing it - never upgrade.
    if (mode === "background") {
      throw foregroundRequiredError(
        `The ComboBox '${input.control}' requires foreground keyboard interaction (no SelectionItemPattern/ValuePattern path available in background mode).`,
        { requestedMode: mode, backgroundPolicy: policy ?? "bestEffort", method: "keyboard-fallback" }
      );
    }
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
  windowsLaunch: (input: { exePath: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number; lifetime?: "independent" | "managed" }) => Promise<{ pid: number; window: { hwnd: string; title: string; pid: number; processName: string; className: string; rect: unknown } | null; processLifetime?: import("../windows.js").ProcessLifetimeReport }>,
  listWindows: (filters: { processName?: string }) => Promise<Array<{ hwnd: string; title: string; pid: number; processName: string }>>,
  input: { profile: string; exePath?: string; args?: string[]; waitForWindow?: boolean; noActivate?: boolean; startMinimized?: boolean; timeoutMs?: number; reuseIfRunning?: boolean; interactionMode?: InteractionMode; foregroundDemo?: InteractionOptions; lifetime?: "independent" | "managed" },
  getExeManifestLevel?: (exePath: string) => Promise<string>
): Promise<{ profile: string; pid: number; hwnd?: string; title?: string; startedByMcp: boolean; reused: boolean; uiaRootAvailable: boolean; manifestLevel?: string; interaction: InteractionReport; warning?: string; lifetime?: "independent" | "managed"; processLifetime?: import("../windows.js").ProcessLifetimeReport }> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  if (!profile.executableNames || profile.executableNames.length === 0) {
    throw new McpUiError("PROFILE_NOT_FOUND", `Profile '${input.profile}' has no executableNames; cannot launch.`, { profile: input.profile });
  }

  // Interaction mode: explicit > pack default > auto. Explicit mode wins over
  // the legacy noActivate/startMinimized params.
  const mode = resolveInteractionMode({ explicit: input.interactionMode, packDefault: profile.interaction?.defaultMode });
  const isBackground = mode === "background";
  const isDemo = mode === "foregroundDemo";
  const noActivate = isBackground ? true : (input.noActivate ?? profile.launch?.noActivate ?? true);
  const startMinimized = isBackground ? false : (input.startMinimized ?? false);

  // Apply pack-declared launch defaults for omitted fields.
  const launchDefaults = profile.launch ?? {};

  const foregroundBefore = await readForeground(deps);

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
        return await launchOutcome({ profile: profile.id, pid: win.pid, hwnd: win.hwnd, title: win.title, startedByMcp: false, reused: true, uiaRootAvailable: uiaOk });
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
    noActivate,
    startMinimized,
    timeoutMs: input.timeoutMs ?? launchDefaults.timeoutMs ?? 30000,
    // Desktop apps the user wants to operate must survive the MCP server's
    // own exit: independent is the profile_launch default.
    lifetime: input.lifetime ?? "independent"
  });

  // Wait for UIA root to be available (best-effort).
  let uiaRootAvailable = false;
  if (launched.window) {
    try {
      const r = await deps.getUiElement({ hwnd: launched.window.hwnd, selector: { controlType: "Window" }, includeProcessPopups: false, timeoutMs: 10000 });
      uiaRootAvailable = r.found;
    } catch { uiaRootAvailable = false; }
  }

  return await launchOutcome({
    profile: profile.id,
    pid: launched.pid,
    hwnd: launched.window?.hwnd,
    title: launched.window?.title,
    startedByMcp: true,
    reused: false,
    uiaRootAvailable,
    ...(manifestLevel !== undefined ? { manifestLevel } : {}),
    ...(launched.processLifetime ? { processLifetime: launched.processLifetime } : {}),
    ...(input.lifetime !== undefined ? { lifetime: input.lifetime } : {})
  });

  // Shared outcome path: foreground observation, foregroundDemo activation,
  // background steal recovery, and the interaction report.
  async function launchOutcome(base: { profile: string; pid: number; hwnd?: string; title?: string; startedByMcp: boolean; reused: boolean; uiaRootAvailable: boolean; manifestLevel?: string; lifetime?: "independent" | "managed"; processLifetime?: import("../windows.js").ProcessLifetimeReport }): Promise<{ profile: string; pid: number; hwnd?: string; title?: string; startedByMcp: boolean; reused: boolean; uiaRootAvailable: boolean; manifestLevel?: string; interaction: InteractionReport; warning?: string; lifetime?: "independent" | "managed"; processLifetime?: import("../windows.js").ProcessLifetimeReport }> {
    const targetHwnd = base.hwnd;
    let targetActivated = false;
    let foregroundChanged = false;
    let foregroundRestored: boolean | undefined;

    // foregroundDemo: restore + raise + activate the target window so menus,
    // popups and dialogs appear on top. The previous foreground window is
    // captured here and restored by the pipeline when the demo finishes.
    if (isDemo && targetHwnd) {
      try {
        const act = await deps.activateWindow(targetHwnd);
        targetActivated = act.activated;
      } catch {
        targetActivated = false;
      }
    }

    let foregroundAfter = await readForeground(deps);
    foregroundChanged = foregroundBefore !== undefined && foregroundAfter !== undefined && foregroundBefore !== foregroundAfter;

    // background mode: if the app (or anything else) stole the foreground,
    // attempt to restore the original window. Qt apps can self-activate
    // repeatedly during late startup, so the restore is verified against the
    // FINAL foreground state (bounded attempts), never trusted from the
    // SetForegroundWindow call alone.
    if (isBackground && foregroundChanged && foregroundBefore !== undefined) {
      for (let attempt = 0; attempt < 2; attempt++) {
        foregroundRestored = await restoreIfChanged(deps, foregroundBefore);
        foregroundAfter = await readForeground(deps);
        if (foregroundAfter === foregroundBefore) break;
      }
      foregroundChanged = foregroundAfter !== undefined && foregroundAfter !== foregroundBefore;
    }

    const interaction: InteractionReport = {
      requestedMode: mode,
      effectiveMode: effectiveModeFor(mode, foregroundChanged || targetActivated),
      ...(foregroundBefore ? { foregroundBefore } : {}),
      ...(foregroundAfter ? { foregroundAfter } : {}),
      foregroundChanged,
      ...(foregroundRestored !== undefined ? { foregroundRestored } : {}),
      targetActivated,
      physicalCursorMoved: false
    };
    const warning = isBackground && foregroundChanged && foregroundRestored === true && foregroundAfter !== foregroundBefore
      ? "The target application re-took the foreground during background launch; the previous foreground window could not be held."
      : isBackground && foregroundChanged && foregroundRestored === false
        ? "The target application took the foreground during background launch and the previous foreground window could not be restored."
        : undefined;
    return { ...base, interaction, ...(warning ? { warning } : {}) };
  }
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
