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
// response as { success:false, code, message, details }.
export class McpUiError extends Error {
  readonly code: UiErrorCode | string;
  readonly details: unknown;
  constructor(code: UiErrorCode | string, message: string, details?: unknown) {
    super(message);
    this.name = "McpUiError";
    this.code = code;
    this.details = details;
  }
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
