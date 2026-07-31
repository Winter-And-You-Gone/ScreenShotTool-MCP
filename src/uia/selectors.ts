// Pure selector helpers shared by schemas and the profile layer.
//
// The PowerShell helper performs the actual UIA matching at runtime; these TS
// helpers enforce structural validity (at least one locator field, regex
// length, control-type normalization) so bad selectors are rejected before
// they ever reach a PowerShell process.

import type { MatchMode, UiElementSelector } from "./types.js";

export const MAX_SELECTOR_STR_LEN = 256;
export const MAX_REGEX_LEN = 256;
export const MAX_PATH_DEPTH = 12;
export const MAX_CANDIDATES = 10;
export const MAX_RETURN_ELEMENTS = 100;

// Control-type aliases a caller may use, normalized to the UIA programmatic
// name (without the "ControlType." prefix) that the PowerShell helper emits.
// The helper accepts both the short and full forms.
const CONTROL_TYPE_ALIASES: Record<string, string> = {
  button: "Button",
  checkbox: "CheckBox",
  combobox: "ComboBox",
  comboboxitem: "ComboBoxItem",
  custom: "Custom",
  datapitem: "DataItem",
  document: "Document",
  edit: "Edit",
  group: "Group",
  header: "Header",
  headeritem: "HeaderItem",
  hyperlink: "Hyperlink",
  image: "Image",
  list: "List",
  listitem: "ListItem",
  menu: "Menu",
  menubar: "MenuBar",
  menuitem: "MenuItem",
  pane: "Pane",
  progressbar: "ProgressBar",
  radiobutton: "RadioButton",
  scrollbar: "ScrollBar",
  separator: "Separator",
  slider: "Slider",
  spinner: "Spinner",
  splitbutton: "SplitButton",
  statusbar: "StatusBar",
  tab: "Tab",
  tabitem: "TabItem",
  table: "Table",
  text: "Text",
  thumb: "Thumb",
  titlebar: "TitleBar",
  toolbar: "ToolBar",
  tooltip: "ToolTip",
  tree: "Tree",
  treeitem: "TreeItem",
  window: "Window"
};

export function normalizeControlType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Accept "ControlType.Button" / "Button" / "button" uniformly.
  const withoutPrefix = trimmed.replace(/^ControlType\./i, "");
  const lower = withoutPrefix.toLowerCase();
  const alias = CONTROL_TYPE_ALIASES[lower];
  if (alias) {
    return alias;
  }
  // Preserve the caller's casing for types we don't explicitly alias (so a
  // provider-specific type name isn't silently lowercased).
  return withoutPrefix;
}

// True when a selector has at least one locator field that can identify an
// element. `visibleOnly`/`enabledOnly`/`index` alone are filters, not locators.
export function hasLocator(selector: UiElementSelector | undefined): boolean {
  if (!selector) {
    return false;
  }
  return Boolean(
    selector.automationId
    || selector.name
    || selector.controlType
    || selector.className
    || selector.frameworkId
    || (Array.isArray(selector.path) && selector.path.length > 0)
    || hasLocator(selector.ancestor)
  );
}

export function defaultMatchMode(selector: UiElementSelector | undefined): MatchMode {
  return selector?.match ?? "exact";
}

// Validate a regex selector. Returns an error message string when invalid,
// null when acceptable. Used by the Zod schema refinements.
export function validateRegex(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LEN) {
    return `regex pattern exceeds ${MAX_REGEX_LEN} characters`;
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return null;
  } catch (error) {
    return `invalid regex: ${(error as Error).message}`;
  }
}

export function selectorSummary(selector: UiElementSelector | undefined): string {
  if (!selector) {
    return "<empty>";
  }
  const parts: string[] = [];
  if (selector.automationId) parts.push(`automationId=${selector.automationId}`);
  if (selector.name) parts.push(`name=${JSON.stringify(selector.name)}`);
  if (selector.controlType) parts.push(`controlType=${selector.controlType}`);
  if (selector.className) parts.push(`className=${selector.className}`);
  if (selector.frameworkId) parts.push(`frameworkId=${selector.frameworkId}`);
  if (selector.index !== undefined) parts.push(`index=${selector.index}`);
  if (selector.match) parts.push(`match=${selector.match}`);
  if (selector.visibleOnly) parts.push("visibleOnly");
  if (selector.enabledOnly) parts.push("enabledOnly");
  if (selector.ancestor) parts.push(`ancestor=[${selectorSummary(selector.ancestor)}]`);
  if (selector.path && selector.path.length > 0) parts.push(`path[${selector.path.length}]`);
  return parts.length > 0 ? parts.join(" ") : "<no-locator>";
}
