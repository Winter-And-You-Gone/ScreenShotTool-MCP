// Shared TypeScript types for the UI Automation layer.
//
// These mirror the PowerShell helper's JSON return shapes and the Zod schemas
// in src/schemas.ts. The PowerShell helper is the single source of truth for
// what is actually returned at runtime; these types describe the contract the
// TS wrappers and MCP clients can rely on.

export type WindowSelector = {
  hwnd?: string | number;
  pid?: number;
  processName?: string;
  titleContains?: string;
};

export type MatchMode = "exact" | "contains" | "regex";

export type UiElementSelector = {
  automationId?: string;
  name?: string;
  controlType?: string;
  className?: string;
  frameworkId?: string;
  match?: MatchMode;
  caseSensitive?: boolean;
  index?: number;
  visibleOnly?: boolean;
  enabledOnly?: boolean;
  ancestor?: UiElementSelector;
  path?: UiElementSelector[];
};

// A single UIA element's reported state. Optional value/pattern fields are
// `null` when the property is unsupported (not an error).
export type UiElementState = {
  automationId: string;
  name: string;
  controlType: string;
  className: string;
  frameworkId: string;
  processId: number;
  nativeWindowHandle: string;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  hasKeyboardFocus: boolean;
  isPassword: boolean;
  // True when the element is a password field and the value was deliberately
  // withheld. Callers MUST NOT attempt to read the value via any other path.
  valueProtected: boolean;
  isReadOnly: boolean | null;
  // Screen-space rectangle in physical pixels (coordinateSpace:"screen").
  // Never subtract window offsets manually - coordinate tools accept
  // client-area coordinates and convert server-side.
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
    coordinateSpace: "screen";
  } | null;
  runtimeId: number[];
  patterns: string[];
  // Value-pattern state (null when unsupported OR when isPassword is true)
  value: string | null;
  // Range-value-pattern state (null when unsupported)
  rangeValue: number | null;
  minimum: number | null;
  maximum: number | null;
  smallChange: number | null;
  largeChange: number | null;
  // Toggle-pattern state (null when unsupported)
  toggleState: "On" | "Off" | "Indeterminate" | null;
  // Selection-item-pattern state (null when unsupported)
  selected: boolean | null;
  // Best-effort original selection info. Providers rarely expose an index
  // directly; when present it is the REAL position among the provider's
  // items (0-based), NOT derived from any action argument. selectedName is
  // the selected item's display text (equals `value` on ValuePattern
  // controls). Both are optional because support varies per provider.
  selectedName?: string | null;
  selectedIndex?: number | null;
  // Expand-collapse-pattern state (null when unsupported)
  expandCollapseState: "Expanded" | "Collapsed" | "LeafNode" | "PartiallyExpanded" | null;
};

export type UiTreeNode = {
  nodeId: number;
  parentNodeId: number | null;
  depth: number;
  rootHwnd: string;
  rootIndex: number;
  automationId: string;
  name: string;
  controlType: string;
  className: string;
  frameworkId: string;
  processId: number;
  nativeWindowHandle: string;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  hasKeyboardFocus: boolean;
  boundingRect: {
    x: number;
    y: number;
    width: number;
    height: number;
    coordinateSpace: "screen";
  } | null;
  patterns: string[];
};

export type InspectTreeResult = {
  roots: Array<{
    hwnd: string;
    title: string;
    className: string;
    processId: number;
    isMain: boolean;
    isPopup: boolean;
    rootIndex: number;
  }>;
  nodes: UiTreeNode[];
  visitedNodes: number;
  returnedNodes: number;
  truncated: boolean;
  maxDepth: number;
  maxNodes: number;
  elapsedMs: number;
};

export type QueryResult = {
  found: boolean;
  count: number;
  elements: UiElementState[];
  truncated: boolean;
  visitedNodes: number;
  elapsedMs: number;
};

export type GetResult =
  | { found: false; element: null; elapsedMs: number }
  | { found: true; element: UiElementState; elapsedMs: number };

export type UiAction =
  | "invoke"
  | "toggle"
  | "select"
  | "addToSelection"
  | "removeFromSelection"
  | "expand"
  | "collapse"
  | "setValue"
  | "setRangeValue"
  | "scrollIntoView"
  | "focus"
  | "legacyDefaultAction"
  | "click"
  | "appendText"
  | "clear"
  | "selectAll"
  | "getValue"
  | "setChecked"
  | "increment"
  | "decrement"
  | "windowMessageClick";

export type ActionResult = {
  success: boolean;
  method: string;
  coordinateFallbackUsed: boolean;
  // Always false: the no-mouse fallback path posts window messages and never
  // calls SetCursorPos or real-mouse SendInput.
  physicalCursorMoved: boolean;
  fallbackReason?: string;
  rootHwnd?: string;
  before: Partial<UiElementState> | null;
  after: Partial<UiElementState> | null;
  elapsedMs: number;
};

export type WaitCondition =
  | "exists"
  | "notExists"
  | "visible"
  | "hidden"
  | "enabled"
  | "disabled"
  | "valueEquals"
  | "valueContains"
  | "toggleStateEquals"
  | "selected"
  | "notSelected"
  | "expanded"
  | "collapsed"
  | "countEquals";

export type WaitResult = {
  matched: boolean;
  condition: WaitCondition;
  lastObservation: Partial<UiElementState> | { count: number } | null;
  elapsedMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
  // True when the wait ended by reaching the timeout (normal, not an error).
  // False when the condition matched, or when an execution error short-circuited.
  timedOut: boolean;
};

// Structured error codes returned by the UIA layer. The PowerShell helper
// emits these as { ok:false, code, message, details } so callers can branch
// on machine-readable codes instead of parsing English text.
export type UiErrorCode =
  | "WINDOW_NOT_FOUND"
  | "WINDOW_AMBIGUOUS"
  | "UIA_ROOT_UNAVAILABLE"
  | "ELEMENT_NOT_FOUND"
  | "ELEMENT_AMBIGUOUS"
  | "PATTERN_NOT_SUPPORTED"
  | "ACTION_FAILED"
  | "ELEMENT_NOT_AVAILABLE"
  | "QUERY_TRUNCATED"
  | "TIMEOUT"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_CONTROL_NOT_FOUND"
  | "COORDINATE_FALLBACK_DISABLED"
  | "INVALID_BOUNDING_RECT"
  | "TARGET_PROCESS_EXITED"
  | "UIA_ASSEMBLY_UNAVAILABLE"
  | "INVALID_SELECTOR"
  | "ELEVATED_MANIFEST_REJECTED";

export type UiErrorDetails = {
  selector?: unknown;
  window?: unknown;
  candidates?: unknown;
  stage?: string;
  [key: string]: unknown;
};

export type UiError = {
  ok: false;
  code: UiErrorCode | string;
  message: string;
  details?: UiErrorDetails;
};
