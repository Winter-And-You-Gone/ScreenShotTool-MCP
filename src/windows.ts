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
  WaitForWindowInput,
  UiInspectTreeInput,
  UiQueryInput,
  UiGetInput,
  UiActionInput,
  UiWaitInput
} from "./schemas.js";
import { MAX_SELECTOR_STR_LEN } from "./uia/selectors.js";
import type {
  InspectTreeResult,
  QueryResult,
  GetResult,
  ActionResult,
  WaitResult,
  UiError
} from "./uia/types.js";
import { McpUiError } from "./uia/results.js";
import { captureInteractionReport, type InteractionMode, type InteractionReport } from "./interaction.js";

export type WaitAndSuppressInput = {
  pid: number;
  processName?: string;
  existingHwnds?: string[];
  timeoutMs?: number;
  previousForegroundHwnd?: string;
};

// Error carrying a structured UIA error code (e.g. ELEMENT_AMBIGUOUS,
// PATTERN_NOT_SUPPORTED). Thrown by runHelper/runStandaloneHelper when the
// PowerShell helper emits { ok:false, code, message, details }, and by the
// profile layer for PROFILE_NOT_FOUND etc.
//
// This extends McpUiError so that a single `instanceof McpUiError` check in
// index.ts catches every structured UIA/profile error regardless of which
// layer produced it. `instanceof HelperError` is kept for backwards compat
// with existing call sites. `String(error)` on a structured error no longer
// degrades to "[object Object]" because Error provides a useful toString.
export class HelperError extends McpUiError {
  constructor(message: string, code: string, details?: unknown) {
    super(code, message, details);
    this.name = "HelperError";
  }
}

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
  // True when the captured frame is blank/fully-transparent (uniform grid
  // sample). Present only on the PrintWindow path.
  blankFrame?: boolean;
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

type ForegroundWindowResult = {
  hwnd: string;
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
  | { action: "launch-process"; target: { exePath: string; args?: string[]; cwd?: string } }
  | { action: "capture-screen-region"; region: CaptureScreenRegionInput["region"]; outputPath: string }
  | { action: "click-window"; target: ClickWindowInput }
  | { action: "move-mouse-window"; target: MoveMouseWindowInput }
  | { action: "click-menu-item"; target: ClickMenuItemInput }
  | { action: "type-text"; target: TypeTextInput }
  | { action: "send-key"; target: SendKeyInput }
  | { action: "minimize-window"; target: { hwnd: string } }
  | { action: "noactivate-minimize"; target: { hwnd: string; previousForegroundHwnd?: string } }
  | { action: "wait-and-suppress"; target: WaitAndSuppressInput }
  | { action: "get-foreground-window"; target?: Record<string, unknown> }
  | { action: "activate-window"; target: { hwnd: string } }
  | { action: "restore-foreground-window"; target: { previousForegroundHwnd?: string } }
  | { action: "read-clipboard"; target?: Record<string, unknown> }
  | { action: "write-clipboard"; target: WriteClipboardInput }
  | { action: "get-window-state"; target: GetWindowStateInput }
  | { action: "get-client-rect-screen"; target: { hwnd: string | number } }
  | { action: "wait-for-window"; target: Omit<WaitForWindowInput, "timeoutMs" | "pollIntervalMs"> & { timeoutMs?: number; pollIntervalMs?: number } }
  | { action: "ui-inspect-tree"; target: UiInspectTreeInput }
  | { action: "ui-query"; target: UiQueryInput }
  | { action: "ui-get"; target: UiGetInput }
  | { action: "ui-action"; target: UiActionInput }
  | { action: "ui-wait"; target: Omit<UiWaitInput, "timeoutMs" | "pollIntervalMs"> & { timeoutMs?: number; pollIntervalMs?: number } }
  | { action: "get-exe-manifest-level"; exePath: string }
  | { action: "get-exe-identity"; exePath: string }
  | { action: "check-process-alive"; target: { pid?: number; hwnd?: string } }

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

// Real Win32 client area of a window in SCREEN coordinates. Unlike a UIA
// Window boundingRect (which includes the title bar, borders and shadows),
// this is the true client rect: GetClientRect + ClientToScreen. Returns the
// rect with an explicit coordinateSpace:"screen" and the Win32 source label.
export type ClientRectScreenResult = {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSpace: "screen";
  source: string;
};

export async function getWindowClientRectScreen(input: { hwnd: string | number }): Promise<ClientRectScreenResult> {
  return runHelper<ClientRectScreenResult>({ action: "get-client-rect-screen", target: { hwnd: String(input.hwnd) } });
}

export type ProcessAliveResult = {
  pid: number;
  processAlive: boolean;
  windowAlive: boolean;
  // Best-effort exit code when the process is dead (null when the platform
  // cannot obtain it after exit - e.g. the pid was reused or the handle is
  // gone). A missing exit code is NOT evidence of anything.
  exitCode?: number | null;
};

// REAL process liveness (OpenProcess/GetExitCodeProcess in the helper) plus
// window validity (IsWindow). A process is NOT considered alive just because
// a top-level window exists - and a window is NOT considered valid just
// because a pid is alive. Pass pid and/or hwnd; each reported separately.
export async function checkProcessAlive(input: { pid?: number; hwnd?: string | number }): Promise<ProcessAliveResult> {
  return runHelper<ProcessAliveResult>({
    action: "check-process-alive",
    target: {
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.hwnd !== undefined ? { hwnd: String(input.hwnd) } : {})
    }
  });
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

// ── UI Automation wrappers ──
//
// Query/get/inspect/action run on the shared worker (fast, bounded by their
// own timeoutMs). ui_wait runs standalone so a long poll can't stall the
// shared worker's serial queue - mirroring the wait_for_window design.

export async function inspectUiTree(input: UiInspectTreeInput): Promise<InspectTreeResult> {
  const raw = await runHelper<InspectTreeResult>({ action: "ui-inspect-tree", target: input });
  if (input.fields && input.fields.length > 0) {
    raw.nodes = raw.nodes.map((n) => projectElementFields(n as unknown as Record<string, unknown>, input.fields) as unknown as InspectTreeResult["nodes"][number]);
  }
  return raw;
}

// ── ui_catalog ──
//
// Returns a catalog of actionable controls with a recommendedSelector the
// caller can pass verbatim to ui_action, plus supportedActions and a
// selector-stability confidence. Implemented in the TS layer on top of
// inspectUiTree (one tree walk) so it reuses the proven UIA path and needs
// no new PowerShell action. Selector stability:
//   stable               - unique AutomationId, or unique Name+ControlType
//   conditionally-stable - AutomationId/Name present but not unique alone
//   fragile              - only ControlType+index
//   unsupported          - no locator fields at all
const PATTERN_TO_ACTIONS: Array<[string, string[]]> = [
  ["Invoke", ["invoke"]],
  ["Toggle", ["toggle", "setChecked"]],
  ["Value", ["getValue", "setValue", "appendText", "clear", "selectAll"]],
  ["RangeValue", ["setRangeValue", "increment", "decrement"]],
  ["SelectionItem", ["select", "addToSelection", "removeFromSelection"]],
  ["ExpandCollapse", ["expand", "collapse"]],
  ["ScrollItem", ["scrollIntoView"]]
];

function patternToActions(patterns: string[]): string[] {
  const actions = new Set<string>();
  for (const [needle, acts] of PATTERN_TO_ACTIONS) {
    if (patterns.some((p) => p.includes(needle))) {
      for (const a of acts) actions.add(a);
    }
  }
  return [...actions];
}

export async function catalogUi(input: {
  hwnd?: string | number;
  pid?: number;
  processName?: string;
  titleContains?: string;
  includeProcessPopups?: boolean;
  visibleOnly?: boolean;
  enabledOnly?: boolean;
  maxDepth?: number;
  maxNodes?: number;
  timeoutMs?: number;
  // Scoped catalog: restrict the walk to the subtree under rootSelector.
  rootSelector?: import("./uia/types.js").UiElementSelector;
  // Projection: only these control fields are returned per entry.
  fields?: string[];
}): Promise<{
  totalNodes: number;
  actionableNodes: number;
  stableAutomationIdNodes: number;
  nameOnlyNodes: number;
  unsupportedNodes: number;
  controlTypes: Record<string, number>;
  patterns: Record<string, number>;
  unmappedActionableControls: Array<{ automationId: string; name: string; controlType: string }>;
  controls: Array<{
    controlType: string;
    automationId: string;
    name: string;
    className: string;
    frameworkId: string;
    enabled: boolean;
    visible: boolean;
    offscreen: boolean;
    rootHwnd: string;
    recommendedSelector: Record<string, unknown>;
    selectorConfidence: "stable" | "conditionally-stable" | "fragile" | "unsupported";
    selectorVerified: boolean;
    selectorMatchCount: number;
    supportedActions: string[];
    patterns: string[];
    profileControl?: string;
  }>;
  truncated: boolean;
  elapsedMs: number;
}> {
  const tree = await inspectUiTree({
    hwnd: input.hwnd,
    pid: input.pid,
    processName: input.processName,
    titleContains: input.titleContains,
    includeProcessPopups: input.includeProcessPopups ?? true,
    maxDepth: input.maxDepth ?? 20,
    maxNodes: input.maxNodes ?? 5000,
    includePatterns: true,
    includeOffscreen: !(input.visibleOnly ?? true),
    interactiveOnly: false,
    automationIdOnly: false,
    rootSelector: input.rootSelector,
    timeoutMs: input.timeoutMs ?? 30000
  });

  const nodes = tree.nodes;
  // Frequency maps for uniqueness checking. The inspect tree is the same data
  // the UIA resolver (queryUi/ui_get) walks with the same scope, so a count of
  // 1 here means the recommendedSelector re-resolves to exactly 1 element via
  // the resolver (after cross-root dedup). When the tree is truncated, counts
  // may be under-reported, so verification is disabled in that case.
  const aidCounts = new Map<string, number>();
  const nameTypeCounts = new Map<string, number>();
  const aidNameCounts = new Map<string, number>();
  for (const n of nodes) {
    if (n.automationId) aidCounts.set(n.automationId, (aidCounts.get(n.automationId) ?? 0) + 1);
    const nk = `${n.controlType} ${n.name}`;
    nameTypeCounts.set(nk, (nameTypeCounts.get(nk) ?? 0) + 1);
    if (n.automationId && n.name) {
      const ank = `${n.automationId} ${n.name}`;
      aidNameCounts.set(ank, (aidNameCounts.get(ank) ?? 0) + 1);
    }
  }
  // selectorVerified is only meaningful when the tree is not truncated: a
  // truncated tree under-reports counts, so a count of 1 is not a guarantee.
  const canVerify = !tree.truncated;

  const controlTypes: Record<string, number> = {};
  const patternCounts: Record<string, number> = {};
  for (const n of nodes) {
    const ct = n.controlType || "(none)";
    controlTypes[ct] = (controlTypes[ct] ?? 0) + 1;
    for (const p of n.patterns) {
      patternCounts[p] = (patternCounts[p] ?? 0) + 1;
    }
  }

  const controls: Array<{
    controlType: string; automationId: string; name: string; className: string; frameworkId: string;
    enabled: boolean; visible: boolean; offscreen: boolean; rootHwnd: string;
    recommendedSelector: Record<string, unknown>;
    selectorConfidence: "stable" | "conditionally-stable" | "fragile" | "unsupported";
    selectorVerified: boolean;
    selectorMatchCount: number;
    supportedActions: string[]; patterns: string[];
    // rawAutomationId: the FULL provider AutomationId (diagnostic only - may
    // exceed the selector input length limit and is NOT re-inputtable).
    rawAutomationId?: string;
    // replaySelector: a SHORT, schema-valid selector that re-resolves this
    // element. Guaranteed to pass the selector input schema (≤256 chars per
    // locator field, match mode included). Present when automationId would
    // otherwise be too long to feed back in.
    replaySelector?: Record<string, unknown>;
  }> = [];
  let stableAutomationIdNodes = 0;
  let nameOnlyNodes = 0;
  let unsupportedNodes = 0;
  const unmappedActionableControls: Array<{ automationId: string; name: string; controlType: string }> = [];

  // Build a SHORT replay locator from a long hierarchical Qt automationId:
  // the last dot-separated segment (the objectName) with match:"contains".
  // Short enough to pass the selector schema (≤MAX_SELECTOR_STR_LEN) and
  // stable because Qt objectNames are source-declared. Falls back to
  // name+controlType when the last segment is still too long.
  function buildReplaySelector(aid: string, controlType: string, name: string): Record<string, unknown> | undefined {
    const lastSegment = aid.split(".").pop() ?? "";
    if (lastSegment.length > 0 && lastSegment.length <= MAX_SELECTOR_STR_LEN) {
      return { automationId: lastSegment, match: "contains" };
    }
    if (name.length > 0 && name.length <= MAX_SELECTOR_STR_LEN) {
      return { name, controlType, match: "contains" };
    }
    return undefined;
  }

  for (const n of nodes) {
    const actionable = n.patterns.length > 0 || (n.enabled && n.focusable);
    if (!actionable) continue;
    if ((input.enabledOnly ?? false) && !n.enabled) continue;
    if ((input.visibleOnly ?? true) && n.offscreen) continue;

    const aid = n.automationId || "";
    const aidCount = aidCounts.get(aid) ?? 0;
    const aidUnique = aid !== "" && aidCount === 1;
    const nameTypeKey = `${n.controlType} ${n.name}`;
    const nameTypeCount = nameTypeCounts.get(nameTypeKey) ?? 0;
    const nameTypeUnique = n.name !== "" && nameTypeCount === 1;
    const aidNameCount = aid !== "" && n.name !== "" ? (aidNameCounts.get(`${aid} ${n.name}`) ?? 0) : 0;
    const aidNameUnique = aidNameCount === 1;

    let recommendedSelector: Record<string, unknown>;
    let selectorConfidence: "stable" | "conditionally-stable" | "fragile" | "unsupported";
    // selectorVerified = the recommendedSelector re-resolves to exactly 1
    // element via the UIA resolver (same scope as this tree). Computed from the
    // within-tree count (the resolver's data source); disabled when truncated.
    let selectorVerified = false;
    let selectorMatchCount = 0;
    // Replay contract: any selector this tool recommends MUST be acceptable
    // by the selector input schema (≤MAX_SELECTOR_STR_LEN per locator field).
    // A Qt hierarchical automationId can exceed that; when it does, the full
    // id is reported as rawAutomationId (diagnostic) and a short
    // replaySelector is emitted instead - the tool never recommends a value
    // it cannot accept back.
    const aidTooLong = aid.length > MAX_SELECTOR_STR_LEN;
    const aidUniqueReplayable = aidUnique && !aidTooLong;
    let replaySelector: Record<string, unknown> | undefined;

    if (aidUniqueReplayable) {
      // Unique AutomationId, no index, not localized -> stable & directly executable.
      recommendedSelector = { automationId: aid };
      selectorConfidence = "stable";
      selectorVerified = canVerify;
      selectorMatchCount = aidCount;
      stableAutomationIdNodes++;
    } else if (aidUnique && aidTooLong) {
      // Unique AutomationId but too long to feed back in. The raw id is kept
      // for diagnostics; the replay selector is a short contains-match on the
      // trailing objectName segment (Qt objectNames are source-declared and
      // stable), scoped by controlType when available.
      replaySelector = buildReplaySelector(aid, n.controlType, n.name);
      if (replaySelector) {
        recommendedSelector = replaySelector;
        selectorConfidence = "stable";
        selectorVerified = canVerify;
        selectorMatchCount = aidCount;
        stableAutomationIdNodes++;
      } else {
        recommendedSelector = { controlType: n.controlType };
        selectorConfidence = "fragile";
        selectorVerified = false;
        selectorMatchCount = aidCount;
      }
    } else if (aidNameUnique) {
      // AutomationId shared but unique together with Name (e.g. the shared
      // 'appSidebarButton' / 'titleBarButton' disambiguated by accessibleName).
      // Depends on the localized Name -> conditionally-stable.
      recommendedSelector = { automationId: aid, name: n.name, controlType: n.controlType };
      selectorConfidence = "conditionally-stable";
      selectorVerified = canVerify;
      selectorMatchCount = aidNameCount;
      nameOnlyNodes++;
    } else if (nameTypeUnique) {
      // Unique Name+ControlType, but Name is localized -> conditionally-stable.
      recommendedSelector = { name: n.name, controlType: n.controlType };
      selectorConfidence = "conditionally-stable";
      selectorVerified = canVerify;
      selectorMatchCount = nameTypeCount;
      nameOnlyNodes++;
    } else if (aid !== "") {
      // AutomationId present but not unique without an index/ancestor. The
      // recommendedSelector would trigger ELEMENT_AMBIGUOUS, so it is NOT
      // directly executable -> fragile, not verified.
      recommendedSelector = { automationId: aid, controlType: n.controlType };
      selectorConfidence = "fragile";
      selectorVerified = false;
      selectorMatchCount = aidCount;
    } else if (n.name !== "") {
      recommendedSelector = { name: n.name, controlType: n.controlType };
      selectorConfidence = "fragile";
      selectorVerified = false;
      selectorMatchCount = nameTypeCount;
      nameOnlyNodes++;
    } else if (n.controlType) {
      recommendedSelector = { controlType: n.controlType };
      selectorConfidence = "fragile";
      selectorVerified = false;
      selectorMatchCount = 0;
    } else {
      recommendedSelector = {};
      selectorConfidence = "unsupported";
      selectorVerified = false;
      selectorMatchCount = 0;
      unsupportedNodes++;
    }

    const supportedActions = patternToActions(n.patterns);
    if (supportedActions.length === 0) {
      unmappedActionableControls.push({ automationId: aid, name: n.name, controlType: n.controlType });
    }

    controls.push({
      controlType: n.controlType,
      automationId: aid,
      name: n.name,
      className: n.className,
      frameworkId: n.frameworkId,
      enabled: n.enabled,
      visible: !n.offscreen,
      offscreen: n.offscreen,
      rootHwnd: n.rootHwnd,
      recommendedSelector,
      selectorConfidence,
      selectorVerified,
      selectorMatchCount,
      supportedActions,
      patterns: n.patterns,
      ...(aidTooLong ? { rawAutomationId: aid } : {}),
      ...(replaySelector ? { replaySelector } : {})
    });
  }

  const controlsOut: Array<Record<string, unknown>> = (input.fields && input.fields.length > 0
    ? controls.map((c) => projectElementFields(c as unknown as Record<string, unknown>, input.fields))
    : controls) as unknown as Array<Record<string, unknown>>;
  return {
    totalNodes: nodes.length,
    actionableNodes: controls.length,
    stableAutomationIdNodes,
    nameOnlyNodes,
    unsupportedNodes,
    controlTypes,
    patterns: patternCounts,
    unmappedActionableControls,
    controls: controlsOut as unknown as Array<{
      controlType: string;
      automationId: string;
      name: string;
      className: string;
      frameworkId: string;
      enabled: boolean;
      visible: boolean;
      offscreen: boolean;
      rootHwnd: string;
      recommendedSelector: Record<string, unknown>;
      selectorConfidence: "stable" | "conditionally-stable" | "fragile" | "unsupported";
      selectorVerified: boolean;
      selectorMatchCount: number;
      supportedActions: string[];
      patterns: string[];
      profileControl?: string;
      rawAutomationId?: string;
      replaySelector?: Record<string, unknown>;
    }>,
    truncated: tree.truncated,
    elapsedMs: tree.elapsedMs
  };
}

// ── Scoped UI search (ui_query) ──
//
// Scoped queries keep output small instead of enumerating the whole tree:
//   - rootSelector / ancestorSelector restrict the walk (composed into the
//     PowerShell resolver's selector.ancestor),
//   - nameContains filters matches by element name (case-insensitive),
//   - fields projects each element to a small subset,
//   - depthStrategy=auto escalates depth (8/16/24) until matches are found,
//   - maxResults caps the result list.
// All of this happens server-side - the model never parses large trees.

export type ScopedQueryOptions = {
  rootSelector?: import("./uia/types.js").UiElementSelector;
  ancestorSelector?: import("./uia/types.js").UiElementSelector;
  nameContains?: string;
  fields?: string[];
  depthStrategy?: "fixed" | "auto";
  maxDepthAutoLimit?: number;
};

const AUTO_DEPTH_STEPS = [8, 16, 24] as const;

// Selector field allow-list for the projection (mirrors UiElementState's
// stable public fields; values are safe to surface).
const ELEMENT_FIELD_KEYS = [
  "automationId", "name", "controlType", "className", "frameworkId",
  "processId", "nativeWindowHandle", "enabled", "offscreen", "focusable",
  "hasKeyboardFocus", "isPassword", "valueProtected", "isReadOnly",
  "boundingRect", "patterns", "value", "rangeValue", "minimum", "maximum",
  "smallChange", "largeChange", "toggleState", "selected", "selectedName",
  "selectedIndex", "expandCollapseState"
] as const;

// Project an element state to the requested field subset. boundingRect is
// always screen-space; the projection keeps it (with coordinateSpace) so the
// model never has to guess.
export function projectElementFields(element: Record<string, unknown>, fields?: string[]): Record<string, unknown> {
  if (!fields || fields.length === 0) return element;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = (ELEMENT_FIELD_KEYS as readonly string[]).includes(f) ? f : undefined;
    if (key && element[key] !== undefined) out[key] = element[key];
  }
  return out;
}

export type ScopedQueryResult = import("./uia/types.js").QueryResult & {
  scoped?: boolean;
  maxDepth?: number;
  depthExpanded?: boolean;
  requestedMaxDepth?: number | null;
  projected?: boolean;
};

function applyScopedQuery(
  result: import("./uia/types.js").QueryResult,
  input: { nameContains?: string; fields?: string[] },
  scoped: boolean
): ScopedQueryResult {
  let elements = result.elements;
  if (input.nameContains) {
    const needle = input.nameContains.toLowerCase();
    elements = elements.filter((e) => e.name.toLowerCase().includes(needle));
  }
  return {
    ...result,
    count: elements.length,
    elements: (input.fields && input.fields.length > 0
      ? elements.map((e) => projectElementFields(e as unknown as Record<string, unknown>, input.fields))
      : elements) as import("./uia/types.js").UiElementState[],
    scoped
  };
}

export async function queryUi(input: UiQueryInput): Promise<ScopedQueryResult> {
  const scoped = input.rootSelector !== undefined || input.ancestorSelector !== undefined || input.nameContains !== undefined || input.fields !== undefined || input.depthStrategy === "auto";

  if (!scoped) {
    return runHelper<import("./uia/types.js").QueryResult>({ action: "ui-query", target: input });
  }

  // Compose ancestor constraints for the PS resolver. The PS resolver
  // supports BOTH a single selector.ancestor AND an `ancestors` array (AND
  // semantics) - scoped queries pass rootSelector + ancestorSelector as the
  // array so both constraints apply.
  const baseSelector = input.selector ?? {};
  const ancestorList: import("./uia/types.js").UiElementSelector[] = [];
  if (input.rootSelector) ancestorList.push(input.rootSelector);
  if (input.ancestorSelector) ancestorList.push(input.ancestorSelector);
  const selectorWithAncestor = ancestorList.length > 0
    ? { ...baseSelector, ancestors: ancestorList }
    : baseSelector;

  const target = { ...input, selector: selectorWithAncestor };

  const depthAuto = input.depthStrategy === "auto";
  const maxDepth = input.maxDepth ?? 15;
  const limit = input.maxDepthAutoLimit ?? 24;

  // Depth escalation: run at increasing depths until matches appear (or the
  // limit is reached). Shallow-first keeps deep searches cheap when the
  // element is near the root.
  let result: import("./uia/types.js").QueryResult | null = null;
  let usedDepth = maxDepth;
  let depthExpanded = false;
  if (depthAuto) {
    const depths = [...AUTO_DEPTH_STEPS.filter((d) => d >= maxDepth && d <= limit)];
    for (const d of depths) {
      const r = await runHelper<import("./uia/types.js").QueryResult>({ action: "ui-query", target: { ...target, maxDepth: d } });
      if (r.count > 0) {
        result = r;
        usedDepth = d;
        break;
      }
      depthExpanded = true;
      usedDepth = d;
    }
    if (!result) {
      result = await runHelper<import("./uia/types.js").QueryResult>({ action: "ui-query", target: { ...target, maxDepth: limit } });
      usedDepth = limit;
    }
  } else {
    result = await runHelper<import("./uia/types.js").QueryResult>({ action: "ui-query", target });
    usedDepth = maxDepth;
  }

  const projected = applyScopedQuery(result, input, true);
  return {
    ...projected,
    // Report the search metadata so the model can reason about depth.
    maxDepth: usedDepth,
    depthExpanded,
    requestedMaxDepth: depthAuto ? null : maxDepth,
    ...(input.fields && input.fields.length > 0 ? { projected: true } : {})
  };
}

export async function getUiElement(input: UiGetInput): Promise<GetResult> {
  return runHelper<GetResult>({ action: "ui-get", target: input });
}

export async function performUiAction(input: UiActionInput): Promise<ActionResult> {
  return runHelper<ActionResult>({ action: "ui-action", target: input });
}

export async function waitForUi(input: UiWaitInput): Promise<WaitResult> {
  const timeoutMs = (input.timeoutMs ?? 10_000) + 5000;
  return runStandaloneHelper<WaitResult>(
    { action: "ui-wait", target: input },
    timeoutMs,
    "ui_wait"
  );
}

// Read an executable's embedded Win32 manifest (RT_MANIFEST) and return its
// requestedExecutionLevel ("asInvoker" / "requireAdministrator" /
// "highestAvailable") or "unknown". Loads the PE as a data file only - never
// runs it. Used by profile_launch to reject an elevated build before spawning
// it (ELEVATED_MANIFEST_REJECTED) for profiles with requiresAsInvoker.
export async function getExeManifestLevel(exePath: string): Promise<string> {
  const r = await runHelper<{ exePath: string; executionLevel: string }>(
    { action: "get-exe-manifest-level", exePath }
  );
  return r.executionLevel ?? "unknown";
}

export type ExeIdentity = {
  exePath?: string;
  sha256?: string;
  fileVersion?: string;
  productVersion?: string;
  error?: string;
};

// Read an executable's build identity (SHA-256 + version resources) WITHOUT
// executing it. Used for the OPTIONAL App Pack compatibility check - the
// result feeds a warning, never a launch block.
export async function getExeIdentity(exePath: string): Promise<ExeIdentity> {
  return runHelper<ExeIdentity>({ action: "get-exe-identity", exePath });
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

// ── Process lifetime (decoupling launched apps from the MCP server) ──
//
// `independent` launches must survive the MCP server's own exit (normal exit,
// crash, client kill, hot reload). The server's host may run inside a Windows
// Job Object that terminates all descendants when it closes, so `detached:
// true` alone is NOT enough: the child must ESCAPE the host job.
//
// Independent launch isolates the target from the MCP server process lifetime
// when supported. On Windows the implementation first attempts verified Job
// breakaway (CreateProcessW with CREATE_BREAKAWAY_FROM_JOB + DETACHED_PROCESS
// + CREATE_NEW_PROCESS_GROUP, verified via IsProcessInJob). If the host Job
// disallows breakaway, it falls back to detached spawning, which is verified
// for MCP server-process exit but may still be subject to an outer host Job
// lifecycle. The ACTUAL method, what the verification proves
// (verificationScope) and any residual outer Job coupling (outerJobCoupling)
// are always reported - never assumed.
export type ProcessLifetime = "independent" | "managed";

// What `verified` actually proves. Never over-claims:
//   job-breakaway            - the child escaped the host job (IsProcessInJob
//                              verified it is NOT in the caller's job).
//   mcp-server-process-exit  - the launch method is known (by construction
//                              and platform integration test) to survive the
//                              MCP server process's own exit; an OUTER host
//                              job lifecycle may still apply.
//   none                     - launched, but no lifetime isolation was
//                              verified.
export type VerificationScope = "job-breakaway" | "mcp-server-process-exit" | "none";

// Residual coupling to an OUTER host job (a job that is not the MCP server
// process's own). Honest, never assumed:
//   none-observed - the child is not in any job we can observe.
//   possible      - an outer host job may still terminate the child when the
//                   whole host session ends (detached spawn does not escape
//                   outer jobs).
//   unknown       - no verification was performed.
export type OuterJobCoupling = "none-observed" | "possible" | "unknown";

export type ProcessLifetimeReport = {
  requested: ProcessLifetime;
  effective: "independent" | "best-effort" | "managed";
  isolationMethod?: "windows-breakaway" | "detached-spawn" | "spawn-managed";
  verified: boolean;
  // What the verification actually proves (absent = "none").
  verificationScope?: VerificationScope;
  // Whether an outer host job lifecycle may still apply.
  outerJobCoupling?: OuterJobCoupling;
};

export type LaunchResult = {
  pid: number;
  window: WindowInfo | null;
  processLifetime?: ProcessLifetimeReport;
};

const INDEPENDENT_LAUNCH_TIMEOUT_MS = 20000;

async function launchIndependent(exePath: string, args: string[], cwd?: string): Promise<{ pid: number; report: ProcessLifetimeReport }> {
  // 1. Attempt a breakaway launch through the shared worker. The worker runs
  // in the same process/job environment as the MCP server, so the job
  // observed by IsProcessInJob is the REAL host environment.
  try {
    const request: HelperRequest = {
      action: "launch-process",
      target: { exePath, args, ...(cwd ? { cwd } : {}) }
    };
    const result = await runHelper<{ pid: number; started: boolean; verified?: boolean | null; isolationMethod?: string }>(request);
    if (result.started && typeof result.pid === "number") {
      if (result.verified === true) {
        // Breakaway succeeded: IsProcessInJob verified the child is NOT in
        // the caller's job (strongest observable isolation).
        return {
          pid: result.pid,
          report: {
            requested: "independent",
            effective: "independent",
            isolationMethod: "windows-breakaway",
            verified: true,
            verificationScope: "job-breakaway",
            outerJobCoupling: "none-observed"
          }
        };
      }
      // Breakaway was requested but the child is still inside the host job
      // (the job does not allow breakaway). This child would die with the
      // server - clean it up and fall back to the detached-spawn path.
      try {
        await closeApp(result.pid);
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // Helper unavailable/failed - fall through to the detached spawn path.
  }

  // 2. Detached spawn: Node.js does NOT place a detached child in its
  // KILL_ON_JOB_CLOSE job, which is the primary server-exit cascade
  // mechanism. The child may still share any OUTER host job (breakaway was
  // not honored) - that residual coupling is reported honestly via
  // outerJobCoupling and cannot be removed from inside the server.
  const child = await spawnDetached(exePath, args, cwd);
  if (typeof child.pid !== "number") {
    throw new Error("Failed to start process.");
  }
  return {
    pid: child.pid,
    report: {
      requested: "independent",
      effective: "independent",
      isolationMethod: "detached-spawn",
      // Verified for MCP server-process exit survival (by construction:
      // Node creates no KILL_ON_JOB_CLOSE job for detached children, and the
      // platform integration test proves parent-exit survival). This is NOT
      // a claim of full isolation from every outer host job.
      verified: true,
      verificationScope: "mcp-server-process-exit",
      outerJobCoupling: "possible"
    }
  };
}

async function spawnDetached(exePath: string, args: string[], cwd?: string): Promise<ReturnType<typeof spawn>> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exePath, args, {
      cwd,
      detached: true,
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
  // Detached children keep running when this process exits; never keep the
  // server alive because of the child.
  child.unref();
  return child;
}

async function spawnManaged(input: LaunchAppInput, cwd?: string): Promise<ReturnType<typeof spawn>> {
  return spawnApp(input, cwd);
}

export async function launchApp(input: LaunchAppInput): Promise<LaunchResult> {
  await ensureExecutablePath(input.exePath);
  const cwd = await ensureWorkingDirectory(input.cwd);
  const processName = path.basename(input.exePath, path.extname(input.exePath));
  const existingProcessWindows = input.waitForWindow ? await listWindows({ processName }) : [];
  const existingHwnds = new Set(existingProcessWindows.map((window) => window.hwnd));
  const previousForegroundHwnd = input.noActivate ? await getForegroundWindowHwnd().catch(() => undefined) : undefined;

  const lifetime = input.lifetime ?? "independent";

  // independent: breakaway launch when the host job allows it, otherwise a
  // detached spawn (Node then creates no KILL_ON_JOB_CLOSE job for the child
  // - the primary server-exit cascade mechanism). managed: the historical
  // spawn path (the process may be tied to the server's own lifetime - that
  // is the point).
  let child: { pid: number };
  let spawnedProcess: ReturnType<typeof spawn> | undefined;
  let processLifetime: ProcessLifetimeReport;
  if (lifetime === "independent") {
    const launched = await launchIndependent(input.exePath, input.args ?? [], cwd);
    child = { pid: launched.pid };
    processLifetime = launched.report;
  } else {
    spawnedProcess = await spawnManaged(input, cwd);
    // spawnApp already verified a numeric pid (it throws otherwise); keep the
    // ChildProcess so the exit listener works on the managed path.
    child = spawnedProcess as unknown as { pid: number };
    // managed: the process is deliberately tied to the server's lifetime
    // (no independence verification applies; verified means the managed
    // contract itself - the historical spawn path - was used as designed).
    processLifetime = { requested: "managed", effective: "managed", isolationMethod: "spawn-managed", verified: true, verificationScope: "none", outerJobCoupling: "unknown" };
  }

  if (typeof child.pid !== "number") {
    throw new Error("Failed to start process.");
  }

  const exitState: { exited: boolean; code: number | null; signal: NodeJS.Signals | null } = {
    exited: false,
    code: null,
    signal: null
  };
  // The independent child has no ChildProcess handle (the helper owns it); an
  // exit listener is only meaningful on the managed spawn path.
  if (spawnedProcess) {
    spawnedProcess.on("exit", (code, signal) => {
      exitState.exited = true;
      exitState.code = code;
      exitState.signal = signal;
    });
  }

  if (!input.waitForWindow) {
    return { pid: child.pid, window: null, processLifetime };
  }

  let window: WindowInfo | null = null;
  let suppressRan = false;
  const launchStart = Date.now();

  if (input.noActivate) {
    try {
      const suppressResult = await runHelper<WaitAndSuppressResult>(
        {
          action: "wait-and-suppress",
          target: {
            pid: child.pid,
            processName,
            existingHwnds: [...existingHwnds],
            timeoutMs: input.timeoutMs,
            previousForegroundHwnd
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
    const elapsed = Date.now() - launchStart;
    const remaining = Math.max(2000, input.timeoutMs - elapsed);
    window = await pollForWindow(child.pid, processName, existingHwnds, remaining, exitState);
  }

  if (input.noActivate && window && !suppressRan) {
    try {
      await runHelper<WaitAndSuppressResult>(
        {
          action: "wait-and-suppress",
          target: {
            pid: child.pid,
            processName,
            existingHwnds: [...existingHwnds],
            timeoutMs: 8000,
            previousForegroundHwnd
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

  return { pid: child.pid, window, processLifetime };
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

export async function captureWindow(input: CaptureWindowInput, resolvedMode?: InteractionMode): Promise<CaptureResult & { interaction?: InteractionReport }> {
  const outputPath = await ensureOutputPath(input.outputPath);
  const { outputPath: _outputPath, ...target } = input;
  const mode = resolvedMode ?? "auto";

  // Interaction policy for the capture:
  //  - background: force the non-activating PrintWindow path (never activate,
  //    never change z-order); a blank frame fails with
  //    BACKGROUND_CAPTURE_UNAVAILABLE - NEVER silently upgraded to a
  //    foreground screen grab.
  //  - foregroundDemo: the window MAY be activated for a 'screen' capture
  //    (allowed; the helper restores the previous foreground afterwards).
  //  - auto: legacy behavior untouched.
  const isBackground = mode === "background";
  const captureTarget = {
    ...target,
    ...(isBackground ? { focus: false, noActivate: true, captureMethod: "print" as const } : {})
  };

  // Foreground observation around the capture (honest reporting; the capture
  // itself runs standalone, these reads go through the shared worker).
  const foregroundBefore = await getForegroundWindowHwnd().catch(() => undefined);

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
  let result: CaptureResult;
  try {
    result = await runStandaloneHelper<CaptureResult>(
      { action: "capture-window", target: captureTarget, outputPath },
      CAPTURE_TIMEOUT_MS,
      "capture_window"
    );
  } catch (error) {
    // Structured capture errors (e.g. blank frame) surface with their code;
    // enrich the BACKGROUND_CAPTURE_UNAVAILABLE failure with the interaction
    // context required by the background contract.
    if (error instanceof HelperError && error.code === "BACKGROUND_CAPTURE_UNAVAILABLE") {
      const foregroundAfter = await getForegroundWindowHwnd().catch(() => undefined);
      throw new HelperError(error.message, "BACKGROUND_CAPTURE_UNAVAILABLE", {
        ...(typeof error.details === "object" && error.details !== null ? { ...(error.details as Record<string, unknown>) } : {}),
        requestedMode: mode,
        effectiveMode: "background",
        captureMethod: "PrintWindow",
        foregroundChanged: foregroundBefore !== undefined && foregroundAfter !== undefined && foregroundBefore !== foregroundAfter,
        suggestedMode: "foregroundDemo"
      });
    }
    throw error;
  }

  const foregroundAfter = await getForegroundWindowHwnd().catch(() => undefined);
  const foregroundChanged = foregroundBefore !== undefined && foregroundAfter !== undefined && foregroundBefore !== foregroundAfter;

  // background mode: a blank/fully-transparent frame is a failed background
  // capture - refuse with BACKGROUND_CAPTURE_UNAVAILABLE instead of saving it.
  if (isBackground && result.blankFrame === true) {
    throw new HelperError(
      "PrintWindow produced a blank/fully-transparent frame; the window does not render in the background.",
      "BACKGROUND_CAPTURE_UNAVAILABLE",
      {
        requestedMode: mode,
        effectiveMode: "background",
        captureMethod: "PrintWindow",
        foregroundChanged,
        suggestedMode: "foregroundDemo"
      }
    );
  }

  const interaction: InteractionReport = captureInteractionReport(mode, {
    ...(foregroundBefore !== undefined ? { foregroundBefore } : {}),
    ...(foregroundAfter !== undefined ? { foregroundAfter } : {}),
    foregroundChanged,
    captureMethod: "PrintWindow",
    targetActivated: mode === "foregroundDemo" && (target.captureMethod ?? "print") === "screen"
  });

  return { ...result, interaction };
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

    await delay(200);
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
type WorkerResponseErr = { ok: false; error: string; code?: string; message?: string; details?: unknown };
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

// Diagnostic: how many times the shared worker has been (re)started in this
// process. Tests assert this stays at 1 across mixed UIA + profile calls so
// the hot-reload / dependency-injection change didn't regress into spawning a
// second worker.
export let workerStartCount = 0;

function getWorkerStartCount(): number {
  return workerStartCount;
}

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
          } else if (response.code) {
            // Structured UIA error: { ok:false, code, message, details }.
            pending.reject(new HelperError(response.message ?? response.error ?? `UIA error (code=${response.code}).`, response.code, response.details));
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
    workerStartCount++;
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
  const timeoutMs = helperTimeoutMs(request);

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
      killWorker(worker, `action=${request.action} exceeded ${timeoutMs}ms`);
      reject(new Error(`PowerShell helper timed out after ${timeoutMs}ms (action=${request.action}).`));
    }, timeoutMs);

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

function helperTimeoutMs(request: HelperRequest): number {
  if (request.action === "type-text") {
    return 90000;
  }

  // CreateProcessW + IsProcessInJob verification; a slow AV scanner on the
  // target exe can delay the call. Bounded, never indefinite.
  if (request.action === "launch-process") {
    return INDEPENDENT_LAUNCH_TIMEOUT_MS;
  }

  if (request.action === "wait-and-suppress") {
    const timeoutMs = request.target.timeoutMs ?? 10000;
    return timeoutMs + Math.max(8000, timeoutMs) + 5000;
  }

  if (
    request.action === "click-window"
    || request.action === "move-mouse-window"
    || request.action === "click-menu-item"
  ) {
    return 12000;
  }

  // UIA query/inspect/get/action carry their own timeoutMs; give the worker a
  // generous ceiling above that so a bounded walk completes but a genuine
  // hang is still killed. Qt UIA providers can block briefly while pumping.
  if (
    request.action === "ui-inspect-tree"
    || request.action === "ui-query"
    || request.action === "ui-get"
    || request.action === "ui-action"
  ) {
    const t = request.target.timeoutMs ?? 20000;
    return t + 10000;
  }

  return 5000;
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
          const parsed = JSON.parse(out) as unknown;
          // Standalone UIA errors emit { ok:false, code, message, details }
          // as the top-level JSON. Surface them as HelperError so callers can
          // branch on the structured code.
          if (parsed && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false && typeof (parsed as { code?: unknown }).code === "string") {
            const err = parsed as { code: string; message?: string; details?: unknown };
            reject(new HelperError(err.message ?? `${label} UIA error (code=${err.code}).`, err.code, err.details));
            return;
          }
          resolve(parsed as T);
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

// Test/diagnostic accessor: how many shared workers have been started in
// this process lifetime. Health check for the single-worker invariant.
export function getWorkerStartCountValue(): number {
  return workerStartCount;
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
  const target = previousForegroundHwnd ? { hwnd, previousForegroundHwnd } : { hwnd };
  return runHelper({ action, target });
}

// ── Foreground helpers (interaction policy support) ──

export type ActivateWindowResult = {
  activated: boolean;
  foregroundHwnd: string;
};

export type RestoreForegroundResult = {
  restored: boolean;
  foregroundHwnd: string;
  foregroundChanged: boolean;
};

// foregroundDemo presentation: restore + raise + activate the target window.
// Never moves the physical cursor.
export async function activateWindow(hwnd: string): Promise<ActivateWindowResult> {
  return runHelper<ActivateWindowResult>({ action: "activate-window", target: { hwnd } });
}

// Restore a previous foreground window (best-effort). Used after a
// foregroundDemo session and to recover from an app that self-activates
// during a background launch.
export async function restoreForegroundWindow(previousForegroundHwnd?: string): Promise<RestoreForegroundResult> {
  return runHelper<RestoreForegroundResult>({ action: "restore-foreground-window", target: { previousForegroundHwnd } });
}

export async function getForegroundWindowHwnd(): Promise<string> {
  const result = await runHelper<ForegroundWindowResult>({ action: "get-foreground-window", target: {} });
  return result.hwnd;
}
