import { z } from "zod";
import {
  MAX_REGEX_LEN,
  MAX_SELECTOR_STR_LEN,
  hasLocator,
  normalizeControlType,
  validateRegex
} from "./uia/selectors.js";
import { packExpectSchema } from "./app-packs/schemas.js";
import { INTERACTION_MODES } from "./interaction.js";

const interactionModeSchema = z.enum(INTERACTION_MODES);
// Caller-supplied foregroundDemo options (all optional; pack/profile defaults
// apply otherwise).
const foregroundDemoOptionsSchema = z.object({
  restorePreviousForeground: z.boolean().optional(),
  stepDelayMs: z.number().int().min(0).max(5000).optional()
}).strict();

// Shared interaction params added to the high-level tools that must respect
// the interaction policy. Explicit interactionMode always wins over the old
// noActivate/focus/activate params.
const interactionParams = {
  interactionMode: interactionModeSchema.optional(),
  foregroundDemo: foregroundDemoOptionsSchema.optional()
} as const;

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
  noActivate: z.boolean().optional().default(false),
  ...interactionParams
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
  targetRef: z.string().min(1).max(128).regex(/^target_[A-Za-z0-9_.-]+$/, "targetRef must match ^target_[A-Za-z0-9_.-]+$").optional(),
  region: regionSchema.optional(),
  focus: z.boolean().optional().default(true),
  captureMethod: z.enum(["screen", "print"]).optional().default("print"),
  noActivate: z.boolean().optional().default(false),
  outputPath: z.string().min(1).optional(),
  ...interactionParams
}).strict().refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined || value.targetRef !== undefined,
  "Provide at least one of targetRef, hwnd, pid, processName, or titleContains."
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
  // Client-area-relative (window-relative) coordinates. NOT screen
  // coordinates. See click_window description.
  coordinateSpace: z.enum(["client", "window"]).optional().default("client"),
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
  // Client-area-relative (window-relative) coordinates. NOT screen
  // coordinates. See move_mouse_window description.
  coordinateSpace: z.enum(["client", "window"]).optional().default("client"),
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
  noActivate: z.boolean().optional().default(false),
  ...interactionParams
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
  noActivate: z.boolean().optional().default(false),
  ...interactionParams
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
  titleContains: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  // Stable target binding returned by profile_launch. Preferred over pid/
  // hwnd: survives window recreation and refreshes the binding automatically.
  targetRef: z.string().min(1).max(128).regex(/^target_[A-Za-z0-9_.-]+$/, "targetRef must match ^target_[A-Za-z0-9_.-]+$").optional()
} as const;

const windowSelectorRefine = (value: Record<string, unknown>) =>
  value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined || value.targetRef !== undefined;

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
  // Scoped fallback options for large trees: restrict the walk to the
  // subtree under rootSelector and project only the requested fields.
  rootSelector: uiElementSelectorSchema.optional(),
  fields: z.array(z.string().min(1).max(64)).max(32).optional(),
  timeoutMs: uiaQueryTimeout.optional().default(20000)
}).strict().refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

export const uiQuerySchema = z.object({
  ...windowSelectorFields,
  // Optional: with rootSelector/ancestorSelector the selector may be omitted
  // (the scoped search then matches within the scoped subtree).
  selector: uiElementSelectorSchema.optional(),
  // Scoped search: restrict the walk to the subtree under rootSelector
  // (combined with ancestorSelector for deeper scoping). Keeps results small
  // instead of enumerating the whole tree.
  rootSelector: uiElementSelectorSchema.optional(),
  ancestorSelector: uiElementSelectorSchema.optional(),
  // Case-insensitive substring filter on the element name (applied after the
  // walk; cheap projection instead of a big result).
  nameContains: z.string().min(1).max(MAX_SELECTOR_STR_LEN).optional(),
  // Projection: only these fields are returned per element. Unknown fields
  // are ignored; missing fields are omitted.
  fields: z.array(z.string().min(1).max(64)).max(32).optional(),
  // "auto": start at the default depth and escalate (8/16/24) until matches
  // are found or the limit is reached.
  depthStrategy: z.enum(["fixed", "auto"]).optional().default("fixed"),
  maxDepthAutoLimit: uiaMaxDepth.optional().default(24),
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  includePatterns: z.boolean().optional().default(true),
  maxResults: z.number().int().min(1).max(uiaMaxReturnElements).optional().default(uiaMaxReturnElements),
  timeoutMs: uiaQueryTimeout.optional().default(20000)
}).strict().refine(
  (value) => value.rootSelector !== undefined || value.selector !== undefined || value.ancestorSelector !== undefined,
  "Provide a selector, rootSelector, or ancestorSelector."
).refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

export const uiGetSchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaQueryTimeout.optional().default(10000)
}).strict().refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

export const uiActionSchema = z.object({
  ...windowSelectorFields,
  selector: uiElementSelectorSchema,
  action: z.enum([
    "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
    "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
    "focus", "legacyDefaultAction", "click",
    "appendText", "clear", "selectAll", "getValue", "setChecked",
    "increment", "decrement",
    "windowMessageClick"
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
).refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

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
).refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

export const profileListSchema = z.object({}).strict();

export const profileResolveSchema = z.object({
  profile: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  control: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  ...windowSelectorFields,
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaQueryTimeout.optional().default(10000)
}).strict().refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

export const profileActionSchema = z.object({
  profile: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  control: z.string().min(1).max(MAX_SELECTOR_STR_LEN),
  action: z.enum([
    "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
    "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
    "focus", "legacyDefaultAction", "click",
    "appendText", "clear", "selectAll", "getValue", "setChecked",
    "increment", "decrement",
    "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected"
  ]),
  ...windowSelectorFields,
  value: z.string().max(uiaValueMaxLen).optional(),
  index: z.number().int().min(0).optional(),
  rangeValue: z.number().optional(),
  allowCoordinateFallback: z.boolean().optional().default(false),
  allowMessageClickFallback: z.boolean().optional().default(false),
  forceCoordinateClick: z.boolean().optional().default(false),
  // Set false to disable the pack's defaultExpect for this control+action
  // (only honored by the composite ensureSelected verification; other
  // actions keep pack-default verification through the pipeline).
  expect: z.union([z.literal(false), z.boolean().optional()]).optional(),
  includeProcessPopups: z.boolean().optional().default(true),
  maxDepth: uiaMaxDepth.optional().default(15),
  maxNodes: uiaMaxNodes.optional().default(2000),
  timeoutMs: uiaActionTimeout.optional().default(15000),
  ...interactionParams
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
).refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");

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
  reuseIfRunning: z.boolean().optional().default(true),
  ...interactionParams
}).strict();
export type ProfileLaunchInput = z.infer<typeof profileLaunchSchema>;

export const uiCatalogSchema = z.object({
  ...windowSelectorFields,
  includeProcessPopups: z.boolean().optional().default(true),
  visibleOnly: z.boolean().optional().default(true),
  enabledOnly: z.boolean().optional().default(false),
  maxDepth: uiaMaxDepth.optional().default(20),
  maxNodes: uiaMaxNodes.optional().default(5000),
  // Scoped fallback options for large trees.
  rootSelector: uiElementSelectorSchema.optional(),
  fields: z.array(z.string().min(1).max(64)).max(32).optional(),
  summaryOnly: z.boolean().optional().default(false),
  timeoutMs: uiaQueryTimeout.optional().default(30000)
}).strict().refine(windowSelectorRefine, "Provide at least one of targetRef, hwnd, pid, processName, or titleContains.");
export type UiCatalogInput = z.infer<typeof uiCatalogSchema>;

export type UiElementSelectorInput = import("./uia/types.js").UiElementSelector;

// Tools that may appear as a step inside a pipeline (run_steps /
// profile_run_steps / run_workflow). Pipeline-orchestration tools and
// validate_steps are intentionally excluded (no nesting).
export const chainableToolNames = [
  "launch_app", "list_windows", "capture_window", "capture_screen_region",
  "click_window", "click_menu_item", "move_mouse_window", "close_app",
  "type_text", "send_key", "read_clipboard", "write_clipboard",
  "get_window_state", "wait_for_window",
  "ui_inspect_tree", "ui_query", "ui_get", "ui_action", "ui_wait", "ui_catalog",
  "profile_list", "profile_resolve", "profile_action", "profile_launch",
  "app_pack_list", "app_pack_describe", "app_pack_validate", "app_pack_reload", "app_pack_probe",
  "workflow_catalog", "tool_contract_list", "tool_contract_describe"
] as const;

const stepIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "step id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$");
const exportsSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(256)).refine((v) => Object.keys(v).length <= 32, "at most 32 exports per step");
const retrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(5).optional().default(3),
  delayMs: z.number().int().min(0).max(60000).optional().default(200),
  backoffMultiplier: z.number().min(1).max(10).optional().default(1.5),
  onlyCodes: z.array(z.string().min(1).max(64)).max(16).optional()
}).strict();
const captureBeforeSchema = z.object({
  saveAs: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  read: z.object({
    tool: z.string().min(1).max(64).optional().default("ui_get"),
    args: z.record(z.string(), z.unknown()).optional().default({})
  }).strict().optional()
}).strict();

const runStepsStepSchema = z.object({
  id: stepIdSchema.optional(),
  tool: z.enum(chainableToolNames),
  args: z.record(z.string(), z.unknown()).optional().default({}),
  exports: exportsSchema.optional(),
  expect: z.union([packExpectSchema, z.literal(false)]).optional(),
  retry: retrySchema.optional(),
  captureBefore: captureBeforeSchema.optional(),
  ignoreCodes: z.array(z.string().min(1).max(64)).max(16).optional()
}).strict();

export const runStepsSchema = z.object({
  steps: z.array(runStepsStepSchema).min(1).max(50),
  finally: z.array(runStepsStepSchema).max(20).optional(),
  captureBefore: z.array(captureBeforeSchema).max(32).optional(),
  restore: z.enum(["always", "never", "onFailure"]).optional().default("never"),
  maxTotalMs: z.number().int().min(1000).max(600_000).optional().default(120_000),
  ...interactionParams
}).strict();
export type RunStepsInput = z.infer<typeof runStepsSchema>;
export type RunStepsStepInput = z.infer<typeof runStepsStepSchema>;

// ── App Pack tools ──

export const appPackListSchema = z.object({}).strict();
export const appPackDescribeSchema = z.object({
  pack: z.string().min(1).max(128)
}).strict();
export const appPackValidateSchema = z.object({
  pack: z.string().min(1).max(128).optional(),
  packPath: z.string().min(1).max(1024).optional()
}).strict().refine(
  (v) => v.pack !== undefined || v.packPath !== undefined,
  "Provide 'pack' (a loaded pack id) or 'packPath' (a local pack directory)."
);
export const appPackReloadSchema = z.object({}).strict();
export const appPackProbeSchema = z.object({
  pid: z.number().int().positive(),
  includeProcessPopups: z.boolean().optional().default(true),
  writeDraftToTemp: z.boolean().optional().default(false)
}).strict();

// ── Pipeline / workflow tools ──

export const validateStepsSchema = z.object({
  steps: z.array(runStepsStepSchema).min(1).max(50),
  pack: z.string().min(1).max(128).optional(),
  finally: z.array(runStepsStepSchema).max(20).optional()
}).strict();

const profileRunStepSchema = z.object({
  id: stepIdSchema.optional(),
  // Logical control + action form (the server injects profile/pid).
  control: z.string().min(1).max(256),
  action: z.string().min(1).max(64),
  value: z.string().max(4000).optional(),
  index: z.number().int().min(0).optional(),
  rangeValue: z.number().optional(),
  allowCoordinateFallback: z.boolean().optional(),
  allowMessageClickFallback: z.boolean().optional(),
  forceCoordinateClick: z.boolean().optional(),
  exports: exportsSchema.optional(),
  expect: z.union([packExpectSchema, z.literal(false)]).optional(),
  retry: retrySchema.optional()
}).strict();

export const profileRunStepsSchema = z.object({
  profile: z.string().min(1).max(128),
  launch: z.object({
    exePath: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(1024)).max(64).optional(),
    reuseIfRunning: z.boolean().optional().default(true),
    waitForWindow: z.boolean().optional(),
    noActivate: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional()
  }).strict().optional(),
  steps: z.array(profileRunStepSchema).min(1).max(50),
  finally: z.array(profileRunStepSchema).max(20).optional(),
  restore: z.enum(["always", "never", "onFailure"]).optional().default("never"),
  captureBefore: z.array(captureBeforeSchema).max(32).optional(),
  maxTotalMs: z.number().int().min(1000).max(600_000).optional().default(120_000),
  ...interactionParams
}).strict();

export const workflowCatalogSchema = z.object({
  pack: z.string().min(1).max(128)
}).strict();

export const runWorkflowSchema = z.object({
  pack: z.string().min(1).max(128),
  workflow: z.string().min(1).max(128),
  inputs: z.record(z.string(), z.unknown()).optional().default({}),
  ...interactionParams
}).strict();

export const continueRunSchema = z.object({
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,64}$/, "runId must match ^run_[A-Za-z0-9_-]{1,64}$"),
  continueFrom: z.union([stepIdSchema, z.number().int().min(0)])
}).strict();

export const toolContractListSchema = z.object({}).strict();
export const toolContractDescribeSchema = z.object({
  tool: z.string().min(1).max(128)
}).strict();

export type ToolContractListInput = z.infer<typeof toolContractListSchema>;
export type ToolContractDescribeInput = z.infer<typeof toolContractDescribeSchema>;
export type AppPackListInput = z.infer<typeof appPackListSchema>;
export type AppPackDescribeInput = z.infer<typeof appPackDescribeSchema>;
export type AppPackValidateInput = z.infer<typeof appPackValidateSchema>;
export type AppPackProbeInput = z.infer<typeof appPackProbeSchema>;
export type ValidateStepsInput = z.infer<typeof validateStepsSchema>;
export type ProfileRunStepsInput = z.infer<typeof profileRunStepsSchema>;
export type WorkflowCatalogInput = z.infer<typeof workflowCatalogSchema>;
export type RunWorkflowInput = z.infer<typeof runWorkflowSchema>;
export type ContinueRunInput = z.infer<typeof continueRunSchema>;

// Tool name -> Zod input schema. Used by validate_steps for static argument
// checking and by pipeline dispatch.
export const toolZodSchemas: Record<string, z.ZodTypeAny> = {
  launch_app: launchAppSchema,
  list_windows: listWindowsSchema,
  capture_window: captureWindowSchema,
  capture_screen_region: captureScreenRegionSchema,
  click_window: clickWindowSchema,
  click_menu_item: clickMenuItemSchema,
  move_mouse_window: moveMouseWindowSchema,
  close_app: closeAppSchema,
  type_text: typeTextSchema,
  send_key: sendKeySchema,
  read_clipboard: readClipboardSchema,
  write_clipboard: writeClipboardSchema,
  get_window_state: getWindowStateSchema,
  wait_for_window: waitForWindowSchema,
  ui_inspect_tree: uiInspectTreeSchema,
  ui_query: uiQuerySchema,
  ui_get: uiGetSchema,
  ui_action: uiActionSchema,
  ui_wait: uiWaitSchema,
  ui_catalog: uiCatalogSchema,
  profile_list: profileListSchema,
  profile_resolve: profileResolveSchema,
  profile_action: profileActionSchema,
  profile_launch: profileLaunchSchema,
  app_pack_list: appPackListSchema,
  app_pack_describe: appPackDescribeSchema,
  app_pack_validate: appPackValidateSchema,
  app_pack_reload: appPackReloadSchema,
  app_pack_probe: appPackProbeSchema,
  workflow_catalog: workflowCatalogSchema,
  tool_contract_list: toolContractListSchema,
  tool_contract_describe: toolContractDescribeSchema
};

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

// anyOf for tools that ALSO accept the stable targetRef binding.
const atLeastOneSelectorAnyOfWithTargetRef = [
  { required: ["targetRef"] },
  ...atLeastOneSelectorAnyOf
] as const;

// Shared JSON Schema entry for targetRef.
const targetRefJson = {
  type: "string",
  pattern: "^target_[A-Za-z0-9_.-]+$",
  description: "Stable target binding returned by profile_launch. Preferred over pid/hwnd: it survives window recreation and refreshes the binding automatically. Priority: explicit hwnd > targetRef > pid/processName/titleContains."
} as const;

// Shared JSON Schema for the interactionMode + foregroundDemo params.
const interactionParamsJson = {
  interactionMode: {
    type: "string",
    enum: ["auto", "background", "foregroundDemo"],
    description: "Interaction policy. auto (default): legacy behavior. background: strict background - no foreground steal, no topmost, no physical cursor, no global keyboard input, capture must not require top-level visibility; failures never auto-upgrade to foreground (FOREGROUND_REQUIRED). foregroundDemo: explicit foreground presentation; the target may be restored/activated and the previous foreground window is restored afterwards by default."
  },
  foregroundDemo: {
    type: "object",
    properties: {
      restorePreviousForeground: { type: "boolean", default: true, description: "Restore the previous foreground window when the demo (pipeline/workflow) finishes." },
      stepDelayMs: { type: "integer", minimum: 0, maximum: 5000, description: "Pause between pipeline steps to let the UI stabilize." }
    },
    additionalProperties: false,
    description: "foregroundDemo options (only honored when interactionMode=foregroundDemo)."
  }
} as const;

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
      noActivate: { type: "boolean", default: false, description: "Best-effort background launch: restore the previous foreground window and push the new window to the bottom of the z-order without activation when possible." },
      ...interactionParamsJson
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
      targetRef: { ...targetRefJson },
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
      noActivate: { type: "boolean", default: false, description: "When true, prefer non-activating capture. With captureMethod 'screen', the helper falls back to PrintWindow to avoid changing foreground/z-order. Superseded by interactionMode=background, which forces the non-activating path." },
      outputPath: { type: "string", description: "Optional absolute PNG output path." },
      ...interactionParamsJson
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
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
      x: { type: "integer", minimum: 0, description: "Client-area-relative X coordinate. Coordinates are client-area-relative (window-relative), NOT screen coordinates - never subtract window offsets manually." },
      y: { type: "integer", minimum: 0, description: "Client-area-relative Y coordinate. Coordinates are client-area-relative (window-relative), NOT screen coordinates - never subtract window offsets manually." },
      coordinateSpace: { type: "string", enum: ["client", "window"], default: "client", description: "Coordinate space of x/y. This tool only supports client-area (window-relative) coordinates; screen coordinates are never accepted." },
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
      x: { type: "integer", minimum: 0, description: "Client-area-relative X coordinate. Coordinates are client-area-relative (window-relative), NOT screen coordinates." },
      y: { type: "integer", minimum: 0, description: "Client-area-relative Y coordinate. Coordinates are client-area-relative (window-relative), NOT screen coordinates." },
      coordinateSpace: { type: "string", enum: ["client", "window"], default: "client", description: "Coordinate space of x/y. This tool only supports client-area (window-relative) coordinates; screen coordinates are never accepted." },
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
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_CHAR messages via PostMessage instead of SendInput, so the target window never needs focus. Some applications may not respond to posted messages." },
      ...interactionParamsJson
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
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_KEYDOWN/WM_KEYUP via PostMessage instead of keybd_event, so the target window never needs focus. Some applications may not respond to posted messages." },
      ...interactionParamsJson
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
      targetRef: { ...targetRefJson },
      includeProcessPopups: { type: "boolean", default: true, description: "Also search top-level windows of the same PID (popups, dialogs, tool windows, Qt menus)." },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 1500 },
      interactiveOnly: { type: "boolean", default: false, description: "Only return elements that can receive input (enabled, onscreen, non-Pane)." },
      automationIdOnly: { type: "boolean", default: false, description: "Only return elements with a non-empty AutomationId." },
      includePatterns: { type: "boolean", default: true },
      includeOffscreen: { type: "boolean", default: true },
      controlTypes: { type: "array", items: { type: "string" }, description: "Optional allow-list of control types (e.g. [\"Button\",\"Edit\"])." },
      rootSelector: { ...uiElementSelectorJsonSchema, description: "Restrict the inspection to the subtree under this element (scoped; keeps output small)." },
      fields: { type: "array", items: { type: "string" }, maxItems: 32, description: "Projection: only these element fields are returned per node." },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 20000 }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  ui_query: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      targetRef: { ...targetRefJson },
      selector: uiElementSelectorJsonSchema,
      rootSelector: { ...uiElementSelectorJsonSchema, description: "Restrict the search to the subtree under this element (scoped query; keeps output small)." },
      ancestorSelector: { ...uiElementSelectorJsonSchema, description: "Only return elements that have a matching ancestor." },
      nameContains: { type: "string", description: "Case-insensitive substring filter on the element name." },
      fields: { type: "array", items: { type: "string" }, maxItems: 32, description: "Projection: only these element fields are returned (e.g. [\"name\",\"automationId\",\"controlType\",\"toggleState\",\"selected\",\"boundingRect\"])." },
      depthStrategy: { type: "string", enum: ["fixed", "auto"], default: "fixed", description: "fixed: use maxDepth as-is. auto: start at the default depth and escalate (8/16/24) until matches are found or maxDepthAutoLimit is reached." },
      maxDepthAutoLimit: { type: "integer", minimum: 1, maximum: 30, default: 24 },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      includePatterns: { type: "boolean", default: true },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 20000 }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  ui_get: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      targetRef: { ...targetRefJson },
      selector: uiElementSelectorJsonSchema,
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000 }
    },
    required: ["selector"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  ui_action: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      targetRef: { ...targetRefJson },
      selector: uiElementSelectorJsonSchema,
      action: { type: "string", enum: ["invoke", "toggle", "select", "addToSelection", "removeFromSelection", "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView", "focus", "legacyDefaultAction", "click", "appendText", "clear", "selectAll", "getValue", "setChecked", "increment", "decrement", "windowMessageClick"], description: "windowMessageClick resolves the element by selector and posts a targeted window message (WM_LBUTTONDOWN/UP) at the element center. It does NOT move or click the physical mouse and does NOT activate the window." },
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
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  ui_wait: {
    type: "object",
    properties: {
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      targetRef: { ...targetRefJson },
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
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
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
      targetRef: { ...targetRefJson },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 10000 }
    },
    required: ["profile", "control"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  profile_action: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1 },
      control: { type: "string", minLength: 1 },
      action: { type: "string", enum: ["invoke", "toggle", "select", "addToSelection", "removeFromSelection", "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView", "focus", "legacyDefaultAction", "click", "appendText", "clear", "selectAll", "getValue", "setChecked", "increment", "decrement", "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected"], description: "Primitive UIA actions plus composite actions: selectByName/selectByIndex/getSelection (combobox/list), openMenu (title menu), openSubmenu (title-menu section), ensureSelected (idempotent checkable-nav selection). Composite actions handle same-PID popups automatically and verify before/after state. Menu commands that open a modal dialog use a non-blocking focus+Enter trigger." },
      value: { type: "string", maxLength: 4000, description: "Text for setValue/appendText; \"true\"/\"false\" for setChecked; item name for selectByName." },
      index: { type: "integer", minimum: 0, description: "0-based index for selectByIndex." },
      rangeValue: { type: "number" },
      allowCoordinateFallback: { type: "boolean", default: false },
      allowMessageClickFallback: { type: "boolean", default: false, description: "Alias for allowCoordinateFallback (spec name)." },
      forceCoordinateClick: { type: "boolean", default: false },
      expect: { type: "boolean", enum: [false], description: "Set false to disable the pack's defaultExpect business-state verification for this action (ensureSelected composite)." },
      hwnd: { ...hwndSchemaProperty },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      targetRef: { ...targetRefJson },
      includeProcessPopups: { type: "boolean", default: true },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 15 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 2000 },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 15000 },
      ...interactionParamsJson
    },
    required: ["profile", "control", "action"],
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  profile_launch: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1, description: "App Pack id, e.g. \"notepad\" (from app_pack_list)." },
      exePath: { type: "string", description: "Optional explicit path to the executable. Overrides all other resolution." },
      args: { type: "array", items: { type: "string" }, description: "Process arguments." },
      waitForWindow: { type: "boolean", default: true },
      noActivate: { type: "boolean", default: true, description: "Best-effort background launch (recommended)." },
      startMinimized: { type: "boolean", default: false, description: "Superseded by interactionMode=background, which keeps the window normal-but-behind (never minimized by default)." },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
      reuseIfRunning: { type: "boolean", default: true, description: "If a process with a matching name is already running, attach to it instead of launching a new one." },
      ...interactionParamsJson
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
      targetRef: { ...targetRefJson },
      includeProcessPopups: { type: "boolean", default: true },
      visibleOnly: { type: "boolean", default: true, description: "Only catalog onscreen controls." },
      enabledOnly: { type: "boolean", default: false },
      maxDepth: { type: "integer", minimum: 1, maximum: 30, default: 20 },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 5000 },
      rootSelector: { ...uiElementSelectorJsonSchema, description: "Restrict the catalog to the subtree under this element (scoped; keeps output small)." },
      fields: { type: "array", items: { type: "string" }, maxItems: 32, description: "Projection: only these control fields are returned." },
      summaryOnly: { type: "boolean", default: false, description: "Return counts and control-type distribution only, with no per-control entries (compact)." },
      timeoutMs: { type: "integer", minimum: 500, maximum: 120000, default: 30000 }
    },
    additionalProperties: false,
    anyOf: atLeastOneSelectorAnyOfWithTargetRef
  },
  run_steps: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$", description: "Optional unique step id. Named references use ${id.path}." },
            tool: {
              type: "string",
              enum: [...chainableToolNames],
              description: "Name of a tool to execute as a step. Pipeline tools (run_steps, profile_run_steps, run_workflow, continue_run) cannot be steps."
            },
            args: {
              type: "object",
              description: "Arguments for the tool, exactly as you would pass them to a direct tools/call. Validated against that tool's own input schema at execution time. Values may contain ${id.path} or ${N.path} placeholders resolved against earlier steps' results (e.g. \"${app.pid}\", \"${0.window.hwnd}\"); a whole-value placeholder preserves the referenced type, an embedded one is stringified."
            },
            exports: {
              type: "object",
              additionalProperties: { type: "string" },
              maxProperties: 32,
              description: "Export result fields for later steps / the run result: {name: \"path.in.result\"}. Sensitive field names (password/token/credential/secret/authorization/cookie) are blocked."
            },
            expect: {
              type: "object",
              properties: {
                profileControl: { type: "string", description: "Logical control name (from the App Pack) to wait on." },
                selector: { type: "object", description: "Or a raw UIA selector to wait on." },
                condition: { type: "string", enum: ["exists", "notExists", "visible", "hidden", "enabled", "disabled", "valueEquals", "valueContains", "toggleStateEquals", "selected", "notSelected", "expanded", "collapsed", "countEquals"] },
                timeoutMs: { type: "integer", minimum: 100, maximum: 300000, default: 5000 },
                pollIntervalMs: { type: "integer", minimum: 50, maximum: 10000, default: 150 },
                expectedValue: { type: "string" },
                toggleState: { type: "string", enum: ["On", "Off", "Indeterminate"] },
                expectedCount: { type: "integer", minimum: 0 }
              },
              required: ["condition"],
              description: "Postcondition verified after the tool succeeds. Step success = tool OK AND condition matched. Set to false to disable the pack's defaultExpect. Timeout fails the step with STEP_POSTCONDITION_TIMEOUT."
            },
            retry: {
              type: "object",
              properties: {
                maxAttempts: { type: "integer", minimum: 1, maximum: 5, default: 3 },
                delayMs: { type: "integer", minimum: 0, maximum: 60000, default: 200 },
                backoffMultiplier: { type: "number", minimum: 1, maximum: 10, default: 1.5 },
                onlyCodes: { type: "array", items: { type: "string" }, description: "Restrict retries to these error codes. Default retryable: ELEMENT_NOT_AVAILABLE, UIA_ROOT_UNAVAILABLE, TARGET_WINDOW_NOT_READY, POPUP_NOT_READY, PROVIDER_BUSY. Never retried by default: ELEMENT_AMBIGUOUS, WINDOW_AMBIGUOUS, INVALID_SELECTOR, INVALID_PARAMS, PATTERN_NOT_SUPPORTED, PASSWORD_VALUE_PROTECTED, TOOL_OUTPUT_SCHEMA_MISMATCH." }
              },
              description: "Retry policy. Non-idempotent actions must not rely on automatic retry (validate_steps flags UNSAFE_RETRY)."
            },
            captureBefore: {
              type: "object",
              properties: {
                saveAs: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
                read: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } } }
              },
              description: "Capture a control's value before this step runs (for state restore). Password fields are never captured."
            }
          },
          required: ["tool"],
          additionalProperties: false
        },
        description: "Ordered list of tool invocations. Executed sequentially; the chain stops on the first step that errors and later steps are skipped. A step may reference earlier steps' results via ${id.path} / ${N.path} placeholders - forward references are rejected before any step runs."
      },
      finally: {
        type: "array",
        maxItems: 20,
        items: { type: "object" },
        description: "Steps that run after the main flow succeeds OR fails (cleanup). Failures are recorded separately and do not override the main error. ignoreCodes in args skips listed error codes."
      },
      captureBefore: {
        type: "array",
        maxItems: 32,
        items: { type: "object" },
        description: "Capture control values before the main steps (key -> ui_get args), restored in finally when restore is enabled."
      },
      restore: { type: "string", enum: ["always", "never", "onFailure"], default: "never", description: "Restore captured values in finally: always / never / onFailure." },
      maxTotalMs: { type: "integer", minimum: 1000, maximum: 600000, default: 120000, description: "Overall pipeline time budget." },
      ...interactionParamsJson
    },
    required: ["steps"],
    additionalProperties: false
  },
  // ── App Pack tools ──
  app_pack_list: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  app_pack_describe: {
    type: "object",
    properties: {
      pack: { type: "string", minLength: 1, description: "Pack id from app_pack_list." }
    },
    required: ["pack"],
    additionalProperties: false
  },
  app_pack_validate: {
    type: "object",
    properties: {
      pack: { type: "string", minLength: 1, description: "A loaded pack id to validate." },
      packPath: { type: "string", description: "A local pack directory to validate without loading (admin/local use)." }
    },
    additionalProperties: false,
    anyOf: [{ required: ["pack"] }, { required: ["packPath"] }]
  },
  app_pack_reload: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  app_pack_probe: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1, description: "PID of the running app to probe." },
      includeProcessPopups: { type: "boolean", default: true },
      writeDraftToTemp: { type: "boolean", default: false, description: "Also write the draft profile.json/controls.json to a temp directory." }
    },
    required: ["pid"],
    additionalProperties: false
  },
  validate_steps: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: { type: "object", description: "Same step shape as run_steps." }
      },
      pack: { type: "string", description: "Optional pack id: enables defaultExpect-aware checks." },
      finally: { type: "array", maxItems: 20, items: { type: "object" } }
    },
    required: ["steps"],
    additionalProperties: false
  },
  profile_run_steps: {
    type: "object",
    properties: {
      profile: { type: "string", minLength: 1, description: "App Pack id (from app_pack_list)." },
      launch: {
        type: "object",
        properties: {
          exePath: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          reuseIfRunning: { type: "boolean", default: true },
          waitForWindow: { type: "boolean" },
          noActivate: { type: "boolean" },
          timeoutMs: { type: "integer", minimum: 100, maximum: 120000 }
        },
        description: "Launch options. Omit to attach to a running instance."
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
            control: { type: "string", description: "Logical control name from the pack (app_pack_describe)." },
            action: { type: "string", description: "Action: invoke/toggle/select/setValue/selectByName/selectByIndex/openMenu/openSubmenu/..." },
            value: { type: "string" },
            index: { type: "integer", minimum: 0 },
            exports: { type: "object", additionalProperties: { type: "string" }, maxProperties: 32 },
            expect: { type: "object", description: "Postcondition; defaults to the pack's defaultExpect for control+action." },
            retry: { type: "object" }
          },
          required: ["control", "action"],
          additionalProperties: false
        },
        description: "Steps as {control, action, ...}. The server injects profile/pid, resolves selectors from the pack, and applies defaultExpect."
      },
      finally: { type: "array", maxItems: 20, items: { type: "object" } },
      restore: { type: "string", enum: ["always", "never", "onFailure"], default: "never" },
      captureBefore: { type: "array", maxItems: 32, items: { type: "object" } },
      maxTotalMs: { type: "integer", minimum: 1000, maximum: 600000, default: 120000 },
      ...interactionParamsJson
    },
    required: ["profile", "steps"],
    additionalProperties: false
  },
  workflow_catalog: {
    type: "object",
    properties: {
      pack: { type: "string", minLength: 1, description: "Pack id from app_pack_list." }
    },
    required: ["pack"],
    additionalProperties: false
  },
  run_workflow: {
    type: "object",
    properties: {
      pack: { type: "string", minLength: 1, description: "Pack id from app_pack_list." },
      workflow: { type: "string", minLength: 1, description: "Workflow id from workflow_catalog." },
      inputs: { type: "object", description: "Workflow inputs validated against the workflow's inputSchema." },
      ...interactionParamsJson
    },
    required: ["pack", "workflow"],
    additionalProperties: false
  },
  continue_run: {
    type: "object",
    properties: {
      runId: { type: "string", pattern: "^run_[A-Za-z0-9_-]{1,64}$", description: "runId returned by run_steps / profile_run_steps / run_workflow." },
      continueFrom: { type: "string", description: "Step id (or numeric index) of the failed step to continue from." }
    },
    required: ["runId", "continueFrom"],
    additionalProperties: false
  },
  tool_contract_list: {
    type: "object",
    properties: {},
    additionalProperties: false
  },
  tool_contract_describe: {
    type: "object",
    properties: {
      tool: { type: "string", minLength: 1, description: "Tool name from tools/list." }
    },
    required: ["tool"],
    additionalProperties: false
  }
} as const;
