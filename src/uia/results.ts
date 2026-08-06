// Result/error construction helpers for the UIA layer.
//
// The PowerShell helper returns structured { ok:false, code, message, details }
// errors. These helpers let the TS wrappers (and profile layer) produce the
// same shape when the failure is detected on the TS side (e.g. ambiguity
// before invoking PowerShell, or a missing profile).

import type { UiElementState, UiError, UiErrorDetails, UiErrorCode } from "./types.js";
import { MAX_CANDIDATES, selectorSummary } from "./selectors.js";
import type { UiElementSelector } from "./types.js";

// The single structured error type used across windows.ts, the profile layer,
// and index.ts. It carries a machine-readable `code` and optional `details`.
// Throwing this (instead of a plain object that stringifies to "[object Object]"
// or a generic Error with no code) lets every layer preserve code/message/
// details end to end. index.ts catches it once and serializes it to the MCP
// response as { success:false, code, message, details, suggestion?, retryable? }.
export class McpUiError extends Error {
  readonly code: UiErrorCode | string;
  readonly details: unknown;
  // Optional actionable next step for the model. When absent, the structured
  // error serializer falls back to the code's entry in the SUGGESTIONS map.
  readonly suggestion: string | undefined;
  constructor(code: UiErrorCode | string, message: string, details?: unknown, suggestion?: string) {
    super(message);
    this.name = "McpUiError";
    this.code = code;
    this.details = details;
    this.suggestion = suggestion;
  }
}

// Per-code default suggestions so every structured error tells the model what
// to do next instead of leaving it to guess. Code-specific suggestions (set
// at throw time) win over these defaults.
export const ERROR_SUGGESTIONS: Record<string, string> = {
  TARGET_REQUIRED: "Use profile_launch first and pass its targetRef (or pid/hwnd) to profile_action.",
  WINDOW_NOT_FOUND: "No window matched the target. Re-check the target (targetRef/pid/hwnd/title), or relaunch with profile_launch and use the returned targetRef.",
  WINDOW_NOT_FOUND_FOR_PROCESS: "The process is alive, but no matching window is currently available. The window may be starting, hidden, or recreated - this does not prove the process crashed. Wait for the main window or call profile_resolve with the same targetRef.",
  STALE_WINDOW_HANDLE: "The saved window handle no longer exists (the window was recreated). Pass the targetRef returned by profile_launch - it refreshes the binding automatically - or re-resolve via profile_resolve.",
  PROCESS_EXITED: "The target process has exited. Relaunch it with profile_launch and use the new targetRef.",
  ELEMENT_NOT_FOUND: "Use scoped ui_query within the nearest known profile control (rootSelector + nameContains + maxResults). Avoid ui_inspect_tree unless scoped search also fails.",
  ELEMENT_AMBIGUOUS: "The selector matched multiple elements. Add an index, a more specific controlType/name, or scope the query under rootSelector/ancestorSelector.",
  FOREGROUND_REQUIRED: "This operation has no verified background-safe method and was NOT upgraded to foreground. Re-run with interactionMode=foregroundDemo, or use a background-safe alternative (e.g. targeted window-message actions).",
  MAX_DEPTH_EXCEEDED: "The default search depth was not enough. Pass depthStrategy=auto or a larger maxDepth to ui_query.",
  ACTION_STATE_INCONSISTENT: "The control reports the requested state, but the declared business postcondition is not satisfied. Verify the actual page/content state; the control may have toggled without switching the underlying view.",
  BACKGROUND_CAPTURE_UNAVAILABLE: "The window does not render via PrintWindow in the background. Re-run with interactionMode=foregroundDemo if a foreground capture is acceptable.",
  TREE_OUTPUT_TOO_LARGE: "Use ui_query with rootSelector, nameContains, fields, and maxResults instead of enumerating the whole tree.",
  TARGET_AMBIGUOUS: "Multiple instances of this profile are running. Pass an explicit targetRef (from profile_launch), pid, or hwnd to disambiguate - the server never picks one for you.",
  PROFILE_CONTROL_NOT_FOUND: "Check app_pack_describe for the exact control name, or use scoped ui_query to find the element and its automationId.",
  PACK_NOT_FOUND: "Run app_pack_list to see which App Packs are loaded, then use an id from the list."
};

export function suggestionFor(code: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  return ERROR_SUGGESTIONS[code];
}

export function uiError(
  code: UiError["code"],
  message: string,
  details?: UiErrorDetails
): UiError {
  return { ok: false, code, message, details };
}

// Build a candidate-summary list for ambiguity errors. Capped at
// MAX_CANDIDATES so a selector matching thousands of elements can't produce a
// multi-megabyte error payload. Values are redacted for password fields.
export function buildCandidateSummary(
  elements: UiElementState[]
): Array<Partial<UiElementState>> {
  return elements.slice(0, MAX_CANDIDATES).map((element) => redactElementState(element)).map((element) => ({
    automationId: element.automationId,
    name: element.name,
    controlType: element.controlType,
    className: element.className,
    frameworkId: element.frameworkId,
    boundingRect: element.boundingRect,
    runtimeId: element.runtimeId,
    isPassword: element.isPassword,
    valueProtected: element.valueProtected
  }));
}

// Redact the value of a password field before returning/serializing state.
// Returns a shallow copy with value=null and valueProtected=true when the
// element reports IsPassword. This is the single chokepoint: every code path
// that returns an element state to the MCP client must funnel through here.
export function redactElementState<T extends Partial<UiElementState>>(element: T): T {
  if (element && element.isPassword) {
    const copy = { ...element };
    copy.value = null;
    (copy as Partial<UiElementState> & { valueProtected?: boolean }).valueProtected = true;
    return copy;
  }
  // Ensure valueProtected is present even for non-password fields so the
  // contract is uniform.
  if (element && (element as T & { valueProtected?: boolean }).valueProtected === undefined) {
    (element as T & { valueProtected?: boolean }).valueProtected = false;
  }
  return element;
}

// Construct the structured ambiguity error for "selector matched N elements".
export function ambiguityError(
  selector: UiElementSelector | undefined,
  elements: UiElementState[]
): UiError {
  return uiError(
    "ELEMENT_AMBIGUOUS",
    `Selector matched ${elements.length} elements; provide an index or a more specific selector.`,
    {
      selector,
      candidateCount: elements.length,
      candidates: buildCandidateSummary(elements)
    }
  );
}

export function notFoundError(
  selector: UiElementSelector | undefined,
  stage = "query"
): UiError {
  return uiError(
    "ELEMENT_NOT_FOUND",
    `No element matched selector: ${selectorSummary(selector)}`,
    { selector, stage }
  );
}

export function isUiError(value: unknown): value is UiError {
  return (
    typeof value === "object"
    && value !== null
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { code?: unknown }).code === "string"
  );
}
