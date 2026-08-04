import { z } from "zod";
import {
  MAX_REGEX_LEN,
  MAX_SELECTOR_STR_LEN,
  hasLocator,
  normalizeControlType,
  validateRegex
} from "./uia/selectors.js";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const optionalTimeout = z.number().int().min(100).max(120000).optional();
const maxTypeTextLength = 1000;
const maxTypeTextEstimatedMs = 55000;
const maxCaptureRegionDimension = 16_384;
const maxCaptureRegionArea = 67_108_864;
// Clipboard writes go through GlobalAlloc + Marshal.Copy with no chunking,
// so cap the payload to bound memory use. 1M chars (2 MiB UTF-16) is far
// above any realistic paste target while preventing accidental abuse.
const maxClipboardTextLength = 1_000_000;
const namedSendKeys = [
  "esc",
  "escape",
  "tab",
  "enter",
  "return",
  "space",
  "left",
  "up",
  "right",
  "down",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "backspace",
  "bs",
  "delete",
  "del",
  "home",
  "end",
  "pageup",
  "pagedown"
] as const;
const supportedSendKeyNames = new Set<string>(namedSendKeys);
const printableAsciiChar = /^[\x20-\x7E]$/u;
const sendKeyValue = z.string().min(1).refine(
  (key) => supportedSendKeyNames.has(key.toLowerCase()) || printableAsciiChar.test(key),
  "key must be a supported named key or a single printable ASCII character."
);

export const regionSchema = z.object({
  x: nonNegativeInt,
  y: nonNegativeInt,
  width: positiveInt.max(maxCaptureRegionDimension),
  height: positiveInt.max(maxCaptureRegionDimension)
}).strict().refine(
  (value) => value.width * value.height <= maxCaptureRegionArea,
  `Capture region area must be at most ${maxCaptureRegionArea} pixels.`
);

export const launchAppSchema = z.object({
  exePath: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().min(1).optional(),
  waitForWindow: z.boolean().optional().default(true),
  timeoutMs: optionalTimeout.default(10000),
  startMinimized: z.boolean().optional().default(false),
  noActivate: z.boolean().optional().default(false)
}).strict();

export const listWindowsSchema = z.object({
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional()
}).strict();

export const captureWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  region: regionSchema.optional(),
  focus: z.boolean().optional().default(true),
  captureMethod: z.enum(["screen", "print"]).optional().default("print"),
  noActivate: z.boolean().optional().default(false),
  outputPath: z.string().min(1).optional()
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const captureScreenRegionSchema = z.object({
  region: regionSchema,
  outputPath: z.string().min(1).optional()
}).strict();

export const clickWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  x: nonNegativeInt,
  y: nonNegativeInt,
  button: z.enum(["left", "right", "middle"]).optional().default("left"),
  doubleClick: z.boolean().optional().default(false),
  delayMs: z.number().int().min(0).max(10000).optional().default(200)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const moveMouseWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  x: nonNegativeInt,
  y: nonNegativeInt,
  delayMs: z.number().int().min(0).max(10000).optional().default(200)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const clickMenuItemSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  path: z.array(z.string().min(1)).min(1),
  delayMs: z.number().int().min(0).max(10000).optional().default(500)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const closeAppSchema = z.object({
  pid: z.number().int().positive()
}).strict();

export const typeTextSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  text: z.string().min(1).max(maxTypeTextLength),
  delayMs: z.number().int().min(0).max(10000).optional().default(50),
  pressMs: z.number().int().min(0).max(5000).optional().default(30),
  noActivate: z.boolean().optional().default(false)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
).refine(
  (value) => value.text.length * (value.delayMs + value.pressMs) <= maxTypeTextEstimatedMs,
  "Estimated type_text duration is too long; reduce text length, delayMs, or pressMs, or send the text in smaller chunks."
);

export const sendKeySchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  key: sendKeyValue,
  modifiers: z.array(z.enum(["alt", "ctrl", "shift", "win"])).optional().default([]),
  delayMs: z.number().int().min(0).max(10000).optional().default(50),
  pressMs: z.number().int().min(0).max(5000).optional().default(30),
  noActivate: z.boolean().optional().default(false)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const readClipboardSchema = z.object({}).strict();

export const writeClipboardSchema = z.object({
  text: z.string().max(maxClipboardTextLength)
}).strict();

export const getWindowStateSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional()
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const waitForWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  mode: z.enum(["appear", "disappear"]).optional().default("appear"),
  timeoutMs: z.number().int().min(100).max(300_000).optional().default(30_000),
  pollIntervalMs: z.number().int().min(50).max(10_000).optional().default(100)
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export type LaunchAppInput = z.infer<typeof launchAppSchema>;
export type ListWindowsInput = z.infer<typeof listWindowsSchema>;
export type CaptureWindowInput = z.infer<typeof captureWindowSchema>;
export type CaptureScreenRegionInput = z.infer<typeof captureScreenRegionSchema>;
export type ClickWindowInput = z.infer<typeof clickWindowSchema>;
export type MoveMouseWindowInput = z.infer<typeof moveMouseWindowSchema>;
export type ClickMenuItemInput = z.infer<typeof clickMenuItemSchema>;
export type CloseAppInput = z.infer<typeof closeAppSchema>;
export type TypeTextInput = z.infer<typeof typeTextSchema>;
export type SendKeyInput = z.infer<typeof sendKeySchema>;
export type ReadClipboardInput = z.infer<typeof readClipboardSchema>;
export type WriteClipboardInput = z.infer<typeof writeClipboardSchema>;
export type GetWindowStateInput = z.infer<typeof getWindowStateSchema>;
export type WaitForWindowInput = z.infer<typeof waitForWindowSchema>;

// ═══════════════════════════════════════════════════════════════════════
// UI Automation schemas
// ═══════════════════════════════════════════════════════════════════════
const uiaMaxDepth = z.number().int().min(1).max(30);
const uiaMaxNodes = z.number().int().min(1).max(5000);
const uiaQueryTimeout = z.number().int().min(500).max(120_000);
const uiaActionTimeout = z.number().int().min(500).max(120_000);
const uiaWaitTimeout = z.number().int().min(500).max(120_000);
const uiaPollInterval = z.number().int().min(50).max(10_000);
const uiaValueMaxLen = 4000;
const uiaMaxReturnElements = 100;

const uiElementSelectorSchema: z.ZodType<import("./uia/types.js").UiElementSelector> = z.object({
  automationId: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  name: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  controlType: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  className: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  frameworkId: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  match: z.enum(["exact", "contains", "regex"]).optional(),
  caseSensitive: z.boolean().optional(),
  index: z.number().int().min(0).optional(),
  visibleOnly: z.boolean().optional(),
  enabledOnly: z.boolean().optional(),
  ancestor: z.lazy(() => uiElementSelectorSchema).optional(),
  path: z.array(z.lazy(() => uiElementSelectorSchema)).max(12).optional()
}).strict().refine(
  (value) => hasLocator(value),
  "Selector must provide at least one locator field (automationId, name, controlType, className, frameworkId, ancestor, or path)."
).refine(
  (value) => {
    if (value.match === "regex") {
      const candidate = value.automationId ?? value.name ?? value.className ?? "";
      if (candidate.length === 0) return true;
      return validateRegex(candidate) === null;
    }
    return true;
  },
  "Invalid regex in selector."
).refine(
  // Normalize controlType so the PowerShell helper always receives a clean
  // short name (e.g. "Button" rather than "ControlType.Button").
  (value) => {
    if (value.controlType !== undefined) {
      const normalized = normalizeControlType(value.controlType);
      if (!normalized) return false;
      (value as { controlType?: string }).controlType = normalized;
    }
    return true;
  },
  "Invalid controlType."
);

const windowSelectorFields = {
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  titleContains: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional()
} as const;

const windowSelectorRefine = (value: Record<string, unknown>) =>
  value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined;

export const uiInspectTreeSchema = z.object({
  ...windowSelectorFields,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(10),
  maxNodes: uiaMaxNodes.optional().default(1500),
  interactiveOnly: z.boolean().optional().default(false),
  automationIdOnly: z.boolean().optional().default(false),
  includePatterns: z.boolean().optional().default(true),
  includeOffscreen: z.boolean().optional().default(true),
  controlTypes: z.array(z.string().min(1).max(MAX_SELECTOR_STR_LEN)).max(50).optional(),
  timeoutMs: uiaQueryTimeout.optional().default(20000)
}).strict().refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const uiQuerySchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  includePatterns: z.boolean().optional().default(true),
  maxResults: z.number().int().min(1).max(uiaMaxReturnElements).optional().default(uiaMaxReturnElements),
  timeoutMs: uiaQueryTimeout.optional().default(20000)
}).strict().refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const uiGetSchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaQueryTimeout.optional().default(10000)
}).strict().refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const uiActionSchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  action: z.enum([
    "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
    "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
    "focus", "legacyDefaultAction", "click",
    "appendText", "clear", "selectAll", "getValue", "setChecked",
    "increment", "decrement"
  ]),
  value: z.string().max(uiaValueMaxLen).optional(),
  rangeValue: z.number().optional(),
  allowCoordinateFallback: z.boolean().optional().default(false),
  allowMessageClickFallback: z.boolean().optional().default(false),
  forceCoordinateClick: z.boolean().optional().default(false),
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaActionTimeout.optional().default(10000)
}).strict().refine(
  (value) => value.action === "setValue" || value.action === "appendText" ? value.value !== undefined : true,
  "setValue/appendText require a 'value' string."
).refine(
  (value) => value.action === "setRangeValue" ? value.rangeValue !== undefined : true,
  "setRangeValue requires a 'rangeValue' number."
).refine(
  (value) => value.action === "setChecked" ? value.value !== undefined : true,
  "setChecked requires a 'value' boolean (\"true\"/\"false\")."
).refine(
  (value) => value.forceCoordinateClick ? value.allowCoordinateFallback === true : true,
  "forceCoordinateClick requires allowCoordinateFallback=true."
).refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const uiWaitSchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  condition: z.enum([
    "exists", "notExists", "visible", "hidden", "enabled", "disabled",
    "valueEquals", "valueContains", "toggleStateEquals", "selected",
    "notSelected", "expanded", "collapsed", "countEquals"
  ]),
  expectedValue: z.string().max(uiaValueMaxLen).optional(),
  expectedBoolean: z.boolean().optional(),
  expectedCount: z.number().int().min(0).max(uiaMaxReturnElements).optional(),
  toggleState: z.enum(["On", "Off", "Indeterminate"]).optional(),
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaWaitTimeout.optional().default(10_000),
  pollIntervalMs: uiaPollInterval.optional().default(200)
}).strict().refine(
  (value) => ["valueEquals", "valueContains"].includes(value.condition) ? value.expectedValue !== undefined : true,
  "valueEquals/valueContains require 'expectedValue'."
).refine(
  (value) => value.condition === "toggleStateEquals" ? value.toggleState !== undefined : true,
  "toggleStateEquals requires 'toggleState'."
).refine(
  (value) => value.condition === "countEquals" ? value.expectedCount !== undefined : true,
  "countEquals requires 'expectedCount'."
).refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const profileListSchema = z.object({}).strict();

export const profileResolveSchema = z.object({
  profile: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  control: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  ...windowSelectorFields,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaQueryTimeout.optional().default(10000)
}).strict().refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export const profileActionSchema = z.object({
  profile: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  control: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  action: z.enum([
    "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
    "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
    "focus", "legacyDefaultAction", "click",
    "appendText", "clear", "selectAll", "getValue", "setChecked",
    "increment", "decrement",
    "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu"
  ]),
  ...windowSelectorFields,
  value: z.string().max(uiaValueMaxLen).optional(),
  index: z.number().int().min(0).optional(),
  rangeValue: z.number().optional(),
  allowCoordinateFallback: z.boolean().optional().default(false),
  allowMessageClickFallback: z.boolean().optional().default(false),
  forceCoordinateClick: z.boolean().optional().default(false),
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaActionTimeout.optional().default(15000)
}).strict().refine(
  (value) => value.action === "setValue" || value.action === "appendText" ? value.value !== undefined : true,
  "setValue/appendText require a 'value' string."
).refine(
  (value) => value.action === "setRangeValue" ? value.rangeValue !== undefined : true,
  "setRangeValue requires a 'rangeValue' number."
).refine(
  (value) => value.action === "setChecked" ? value.value !== undefined : true,
  "setChecked requires a 'value' boolean (\"true\"/\"false\")."
).refine(
  (value) => value.action === "selectByName" ? value.value !== undefined : true,
  "selectByName requires a 'value' name string."
).refine(
  (value) => value.action === "selectByIndex" ? value.index !== undefined : true,
  "selectByIndex requires an 'index' number."
).refine(
  (value) => value.forceCoordinateClick ? value.allowCoordinateFallback === true : true,
  "forceCoordinateClick requires allowCoordinateFallback=true."
).refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");

export type UiInspectTreeInput = z.infer<typeof uiInspectTreeSchema>;
export type UiQueryInput = z.infer<typeof uiQuerySchema>;
export type UiGetInput = z.infer<typeof uiGetSchema>;
export type UiActionInput = z.infer<typeof uiActionSchema>;
export type UiWaitInput = z.infer<typeof uiWaitSchema>;
export type ProfileListInput = z.infer<typeof profileListSchema>;
export type ProfileResolveInput = z.infer<typeof profileResolveSchema>;
export type ProfileActionInput = z.infer<typeof profileActionSchema>;

export const profileLaunchSchema = z.object({
  profile: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  exePath: z.string().min(1).max(1024).optional(),
  args: z.array(z.string().max(1024)).max(64).optional(),
  waitForWindow: z.boolean().optional().default(true),
  noActivate: z.boolean().optional().default(true),
  startMinimized: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(100).max(120000).optional().default(30000),
  reuseIfRunning: z.boolean().optional().default(true)
}).strict();
export type ProfileLaunchInput = z.infer<typeof profileLaunchSchema>;

export const uiCatalogSchema = z.object({
  ...windowSelectorFields,
  includeProcessPopups: z.boolean().optional().default(true),
  visibleOnly: z.boolean().optional().default(true),
  enabledOnly: z.boolean().optional().default(false),
  maxDepth: uiaMaxDepth.optional().default(20),
  maxNodes: uiaMaxNodes.optional().default(5000),
  timeoutMs: uiaQueryTimeout.optional().default(30000)
}).strict().refine(windowSelectorRefine, "Provide at least one of hwnd, pid, processName, or titleContains.");
export type UiCatalogInput = z.infer<typeof uiCatalogSchema>;

export type UiElementSelectorInput = import("./uia/types.js").UiElementSelector;

// Tools that may appear as a step inside run_steps. run_steps itself is
// intentionally excluded to prevent unbounded nesting.
export const chainableToolNames = [
  "launch_app", "list_windows", "capture_window", "capture_screen_region",
  "click_window", "click_menu_item", "move_mouse_window", "close_app",
  "type_text", "send_key", "read_clipboard", "write_clipboard",
  "get_window_state", "wait_for_window",
  "ui_inspect_tree", "ui_query", "ui_get", "ui_action", "ui_wait", "ui_catalog",
  "profile_list", "profile_resolve", "profile_action", "profile_launch"
] as const;

const runStepsStepSchema = z.object({
  tool: z.enum(chainableToolNames),
  args: z.record(z.string(), z.unknown()).optional().default({})
}).strict();

export const runStepsSchema = z.object({
  steps: z.array(runStepsStepSchema).min(1).max(20)
}).strict();
export type RunStepsInput = z.infer<typeof runStepsSchema>;

const hwndSchemaProperty = {
  anyOf: [
    { type: "string" },
    { type: "integer", minimum: 1 }
  ],
  description: "Window handle from list_windows or launch_app. Numbers are accepted at runtime, but strings are safest for Codex."
} as const;

const atLeastOneSelectorAnyOf = [
  { required: ["hwnd"] },
  { required: ["pid"] },
  { required: ["processName"] },
  { required: ["titleContains"] }
] as const;

// JSON Schema for a UI element selector. Mirrors uiElementSelectorSchema in
// Zod. Recursive (ancestor / path) via a $defs reference.
const uiElementSelectorJsonSchema = {
  type: "object",
  properties: {
    automationId: { type: "string" },
    name: { type: "string" },
    controlType: { type: "string", description: "Short name (Button), full name (ControlType.Button), or lowercase (button) - all accepted." },
    className: { type: "string" },
    frameworkId: { type: "string", description: "e.g. Win32, Qt, WPF, WinForm." },
    match: { type: "string", enum: ["exact", "contains", "regex"], default: "exact" },
    caseSensitive: { type: "boolean", default: false },
    index: { type: "integer", minimum: 0, description: "0-based index into the match list. Required when a selector matches multiple elements." },
    visibleOnly: { type: "boolean" },
    enabledOnly: { type: "boolean" },
    ancestor: { $ref: "#/$defs/uiElementSelector" },
    path: { type: "array", items: { $ref: "#/$defs/uiElementSelector" }, description: "Hierarchical path of selectors matched from root downward." }
  },
  additionalProperties: false,
  description: "At least one locator field (automationId/name/controlType/className/frameworkId/ancestor/path) is required."
} as const;

export const toolInputSchemas = {
  launch_app: {
    type: "object",
    properties: {
      exePath: { type: "string", description: "Absolute path to the .exe to launch." },
      args: { type: "array", items: { type: "string" }, description: "Process arguments as an array." },
      cwd: { type: "string", description: "Optional working directory for the process." },
      waitForWindow: { type: "boolean", default: true, description: "Wait for the first visible window for the process." },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 10000 },
      startMinimized: { type: "boolean", default: false, description: "After the first window is found, request minimized/background presentation. Some apps may briefly show during startup." },
      noActivate: { type: "boolean", default: false, description: "Best-effort background launch: restore the previous foreground window and push the new window to the bottom of the z-order without activation when possible." }
    },
    required: ["exePath"],
    additionalProperties: false
  },
  list_windows: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string", description: "Process name with or without .exe." },
      titleContains: { type: "string", description: "Case-insensitive title substring." }
    },
    additionalProperties: false
  },
  capture_window: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      region: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1, maximum: maxCaptureRegionDimension },
          height: { type: "integer", minimum: 1, maximum: maxCaptureRegionDimension }
        },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
        description: `Optional rectangle relative to the target window top-left corner. Width and height are capped at ${maxCaptureRegionDimension}px, with total area capped at ${maxCaptureRegionArea} pixels.`
      },
      focus: { type: "boolean", default: true, description: "Bring the window to the foreground before capturing. Set false to preserve open menus, popups, or transient UI." },
      captureMethod: { type: "string", enum: ["screen", "print"], default: "print", description: "Capture method: 'print' uses PrintWindow API (captures window content even behind other windows, default). 'screen' uses CopyFromScreen (needs visible area, only use when print fails or you need to capture separate popup/tooltip windows)." },
      noActivate: { type: "boolean", default: false, description: "When true, prefer non-activating capture. With captureMethod 'screen', the helper falls back to PrintWindow to avoid changing foreground/z-order." },
      outputPath: { type: "string", description: "Optional absolute PNG output path." }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  capture_screen_region: {
    type: "object",
    properties: {
      region: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1, maximum: maxCaptureRegionDimension },
          height: { type: "integer", minimum: 1, maximum: maxCaptureRegionDimension }
        },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
        description: `Screen-space rectangle in physical pixels. Width and height are capped at ${maxCaptureRegionDimension}px, with total area capped at ${maxCaptureRegionArea} pixels.`
      },
      outputPath: { type: "string", description: "Optional absolute PNG output path." }
    },
    required: ["region"],
    additionalProperties: false
  },
  click_window: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      x: { type: "integer", minimum: 0, description: "X coordinate relative to the target window top-left corner." },
      y: { type: "integer", minimum: 0, description: "Y coordinate relative to the target window top-left corner." },
      button: { type: "string", enum: ["left", "right", "middle"], default: "left", description: "Mouse button: left, right, or middle." },
      doubleClick: { type: "boolean", default: false },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 200, description: "Delay after posting mouse messages, useful before taking the next screenshot." },
    },
    required: ["x", "y"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  move_mouse_window: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      x: { type: "integer", minimum: 0, description: "X coordinate relative to the target window top-left corner." },
      y: { type: "integer", minimum: 0, description: "Y coordinate relative to the target window top-left corner." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 200, description: "Delay after posting WM_MOUSEMOVE, useful before taking the next screenshot." }
    },
    required: ["x", "y"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  click_menu_item: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      path: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "Native menu path, for example [\"帮助\", \"关于\"]. Matching ignores accelerator markers and is case-insensitive."
      },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 500, description: "Delay after invoking the menu command." }
    },
    required: ["path"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  close_app: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1, description: "Process ID. taskkill /T /F is used, which terminates the entire process tree (the target plus any child processes it spawned)." }
    },
    required: ["pid"],
    additionalProperties: false
  },
  type_text: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty, description: "Window handle from list_windows or launch_app." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      text: { type: "string", minLength: 1, maxLength: maxTypeTextLength, description: "Text to type into the target window. Sent via SendInput Unicode, so any Unicode character including CJK is supported. For standard Edit/RichEdit controls the helper may use EM_REPLACESEL, which replaces the current selection (if any) rather than appending at the caret; send an empty selection-clearing keystroke first if you need a pure insert." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 50, description: "Delay between keystrokes in milliseconds." },
      pressMs: { type: "integer", minimum: 0, maximum: 5000, default: 30, description: "Duration of each key press in milliseconds." },
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_CHAR messages via PostMessage instead of SendInput, so the target window never needs focus. Some applications may not respond to posted messages." }
    },
    required: ["text"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  send_key: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty, description: "Window handle from list_windows or launch_app." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      key: {
        anyOf: [
          { type: "string", enum: namedSendKeys },
          { type: "string", pattern: "^[ -~]$" }
        ],
        description: "Key name to send. Supports single printable ASCII characters and named keys: esc, tab, enter, space, arrows, f1-f12, backspace, delete, home, end, pageup, pagedown."
      },
      modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "shift", "win"] }, description: "Modifier keys to hold during the keypress." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 50 },
      pressMs: { type: "integer", minimum: 0, maximum: 5000, default: 30 },
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_KEYDOWN/WM_KEYUP via PostMessage instead of keybd_event, so the target window never needs focus. Some applications may not respond to posted messages." }
    },
    required: ["key"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  read_clipboard: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  write_clipboard: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: maxClipboardTextLength, description: "UTF-16 text to place on the clipboard. Pass an empty string to clear text content. Newlines and CJK characters are supported. Capped at 1,000,000 characters." }
    },
    required: ["text"],
    additionalProperties: false
  },
  get_window_state: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  wait_for_window: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty, description: "Window handle to wait for. Useful with mode=disappear to wait until a specific window closes." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      mode: { type: "string", enum: ["appear", "disappear"], default: "appear", description: "appear: return when any matching window exists. disappear: return when no matching window exists." },
      timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 30000, description: "Maximum time to wait. On timeout, the call returns found=false instead of throwing." },
      pollIntervalMs: { type: "integer", minimum: 50, maximum: 10000, default: 100, description: "Polling interval. Lower = faster response, higher CPU." }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  // ── UI Automation tools ──
  ui_inspect_tree: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      includeProcessPopups: { type: "boolean", default: true, description: "Also search top-level windows of the same PID (popups, dialogs, tool windows, Qt menus)." },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 1500 },
      interactiveOnly: { type: "boolean", default: false, description: "Only return elements that can receive input (enabled, onscreen, non-Pane)." },
      automationIdOnly: { type: "boolean", default: false, description: "Only return elements with a non-empty AutomationId." },
      includePatterns: { type: "boolean", default: true },
      includeOffscreen: { type: "boolean", default: true },
      controlTypes: { type: "array", items: { type: "string" }, description: "Optional allow-list of control types (e.g. [\"Button\",\"Edit\"])." },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 20000 }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  ui_query: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      selector: uiElementSelectorJsonSchema,
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      includePatterns: { type: "boolean", default: true },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 20000 }
    },
    required: ["selector"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  ui_get: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      selector: uiElementSelectorJsonSchema,
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000 }
    },
    required: ["selector"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  ui_action: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      selector: uiElementSelectorJsonSchema,
      action: { type: "string", enum: ["invoke", "toggle", "select", "addToSelection", "removeFromSelection", "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView", "focus", "legacyDefaultAction", "click", "appendText", "clear", "selectAll", "getValue", "setChecked", "increment", "decrement"] },
      value: { type: "string", maxLength: 4000, description: "Text for setValue/appendText; \"true\"/\"false\" for setChecked; item name for selectByName." },
      rangeValue: { type: "number", description: "Target value for setRangeValue (clamped to [minimum, maximum])." },
      allowCoordinateFallback: { type: "boolean", default: false, description: "Allow keyboard then coordinate-message click fallback ONLY when all UIA patterns are unavailable. Off by default. Never moves the physical cursor." },
      allowMessageClickFallback: { type: "boolean", default: false, description: "Alias for allowCoordinateFallback (spec name). Enables the no-mouse window-message fallback chain." },
      forceCoordinateClick: { type: "boolean", default: false, description: "Force a coordinate message click (requires allowCoordinateFallback=true). Bypasses patterns." },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000 }
    },
    required: ["selector", "action"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  ui_wait: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      selector: uiElementSelectorJsonSchema,
      condition: { type: "string", enum: ["exists", "notExists", "visible", "hidden", "enabled", "disabled", "valueEquals", "valueContains", "toggleStateEquals", "selected", "notSelected", "expanded", "collapsed", "countEquals"] },
      expectedValue: { type: "string", maxLength: 4000 },
      expectedBoolean: { type: "boolean" },
      expectedCount: { type: "integer", minimum: 0, maximum: 100 },
      toggleState: { type: "string", enum: ["On", "Off", "Indeterminate"] },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000, description: "Returns matched=false on timeout (not an error)." },
      pollIntervalMs: { type: "integer", minimum: 50, maximum: 10000, default: 200 }
    },
    required: ["selector", "condition"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  profile_list: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  profile_resolve: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1 },
      control: { type: "string", minLength: 1 },
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000 }
    },
    required: ["profile", "control"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  profile_action: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1 },
      control: { type: "string", minLength: 1 },
      action: { type: "string", enum: ["invoke", "toggle", "select", "addToSelection", "removeFromSelection", "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView", "focus", "legacyDefaultAction", "click", "appendText", "clear", "selectAll", "getValue", "setChecked", "increment", "decrement", "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu"], description: "Primitive UIA actions plus composite actions: selectByName/selectByIndex/getSelection (combobox/list), openMenu (title menu), openSubmenu (title-menu section). Composite actions handle same-PID popups automatically and verify before/after state. Menu commands that open a modal dialog use a non-blocking focus+Enter trigger." },
      value: { type: "string", maxLength: 4000, description: "Text for setValue/appendText; \"true\"/\"false\" for setChecked; item name for selectByName." },
      index: { type: "integer", minimum: 0, description: "0-based index for selectByIndex." },
      rangeValue: { type: "number" },
      allowCoordinateFallback: { type: "boolean", default: false },
      allowMessageClickFallback: { type: "boolean", default: false, description: "Alias for allowCoordinateFallback (spec name)." },
      forceCoordinateClick: { type: "boolean", default: false },
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 15000 }
    },
    required: ["profile", "control", "action"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  profile_launch: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1, description: "Profile id, e.g. \"vaporview\"." },
      exePath: { type: "string", description: "Optional explicit path to the executable. Overrides all other resolution." },
      args: { type: "array", items: { type: "string" }, description: "Process arguments." },
      waitForWindow: { type: "boolean", default: true },
      noActivate: { type: "boolean", default: true, description: "Best-effort background launch (recommended)." },
      startMinimized: { type: "boolean", default: false },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
      reuseIfRunning: { type: "boolean", default: true, description: "If a process with a matching name is already running, attach to it instead of launching a new one." }
    },
    required: ["profile"],
    additionalProperties: false
  },
  ui_catalog: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      includeProcessPopups: { type: "boolean", default: true },
      visibleOnly: { type: "boolean", default: true, description: "Only catalog onscreen controls." },
      enabledOnly: { type: "boolean", default: false },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 20 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 5000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 30000 }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOf
  },
  run_steps: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: [...chainableToolNames],
              description: "Name of a tool to execute as a step. run_steps itself cannot be used as a step (no nesting)."
            },
            args: {
              type: "object",
              description: "Arguments for the tool, exactly as you would pass them to a direct tools/call. Validated against that tool's own input schema at execution time. Omit for tools that take no arguments (e.g. read_clipboard, profile_list). Values may contain ${N.path} placeholders that are resolved against earlier steps' results before dispatch (e.g. \"${0.pid}\", \"${0.window.hwnd}\", \"${0.0.hwnd}\" for an array index); a whole-value placeholder preserves the referenced type, an embedded one is stringified."
            }
          },
          required: ["tool"],
          additionalProperties: false
        },
        description: "Ordered list of tool invocations. Executed sequentially; the chain stops on the first step that errors and all later steps are skipped. A step may reference earlier steps' results via ${N.path} placeholders in its args - a step may only reference steps with a smaller index than its own."
      }
    },
    required: ["steps"],
    additionalProperties: false
  }
} as const;
