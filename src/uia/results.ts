// Result/error construction helpers for the UIA layer.
//
// The PowerShell helper returns structured { ok:false, code, message, details }
// errors. These helpers let the TS wrappers (and profile layer) produce the
// same shape when the failure is detected on the TS side (e.g. ambiguity
// before invoking PowerShell, or a missing profile).

import type { UiElementState, UiError, UiErrorDetails } from "./types.js";
import { MAX_CANDIDATES, selectorSummary } from "./selectors.js";
import type { UiElementSelector } from "./types.js";

export function uiError(
  code: UiError["code"],
  message: string,
  details?: UiErrorDetails
): UiError {
  return { ok: false, code, message, details };
}

// Build a candidate-summary list for ambiguity errors. Capped at
// MAX_CANDIDATES so a selector matching thousands of elements can't produce a
// multi-megabyte error payload.
export function buildCandidateSummary(
  elements: UiElementState[]
): Array<Partial<UiElementState>> {
  return elements.slice(0, MAX_CANDIDATES).map((element) => ({
    automationId: element.automationId,
    name: element.name,
    controlType: element.controlType,
    className: element.className,
    frameworkId: element.frameworkId,
    boundingRect: element.boundingRect,
    runtimeId: element.runtimeId
  }));
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
