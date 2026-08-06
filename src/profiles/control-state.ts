// Declarative control-state evaluation.
//
// App Packs may declare a `controlState` requirement on a control
// (controls.json). ensureSelected (and any composite that verifies a
// control's state) evaluates it through this module. When a pack DECLARES
// controlState, the declared conditions are authoritative - the default
// selected/toggleState shortcut is NOT applied on top. When nothing is
// declared, the legacy default (selected===true OR toggleState==="On")
// keeps working unchanged.
//
// Pure functions - no UIA access, fully unit-testable.

import type { UiElementState } from "../uia/types.js";

// The conditions accepted by the controlState schema (src/app-packs/schemas.ts
// packControlStateConditionSchema). Single source of truth - the validator
// and this evaluator both read from here conceptually; keep in sync.
export const CONTROL_STATE_CONDITIONS = [
  "selected",
  "notSelected",
  "toggleStateEquals",
  "expanded",
  "collapsed",
  "exists",
  "notExists",
  "visible",
  "hidden",
  "enabled",
  "disabled",
  "valueEquals",
  "valueContains"
] as const;

export type ControlStateCondition = (typeof CONTROL_STATE_CONDITIONS)[number];

export type ControlStateDefinition = {
  any?: Array<{ condition: ControlStateCondition; expectedValue?: string; toggleState?: "On" | "Off" | "Indeterminate" }>;
  all?: Array<{ condition: ControlStateCondition; expectedValue?: string; toggleState?: "On" | "Off" | "Indeterminate" }>;
};

export type ControlStateConditionResult = {
  condition: string;
  expected?: unknown;
  actual?: unknown;
  matched: boolean;
};

export type ControlStateEvaluation = {
  matched: boolean;
  usedDefault: boolean;
  conditions: ControlStateConditionResult[];
};

// A snapshot of everything the evaluator can read from a UIA element.
export type ControlSnapshot = {
  exists: boolean;
  selected?: boolean | null;
  toggleState?: "On" | "Off" | "Indeterminate" | null;
  expandCollapseState?: string | null;
  offscreen?: boolean | null;
  enabled?: boolean | null;
  value?: string | null;
  name?: string | null;
};

export function snapshotFromElement(element: Partial<UiElementState> | null | undefined): ControlSnapshot {
  if (!element) return { exists: false };
  return {
    exists: true,
    selected: element.selected,
    toggleState: element.toggleState,
    expandCollapseState: element.expandCollapseState,
    offscreen: element.offscreen,
    enabled: element.enabled,
    value: element.value,
    name: element.name
  };
}

// Evaluate a single declared condition against a snapshot.
export function evaluateControlStateCondition(
  snapshot: ControlSnapshot,
  condition: { condition: ControlStateCondition; expectedValue?: string; toggleState?: "On" | "Off" | "Indeterminate" }
): ControlStateConditionResult {
  const c = condition.condition;
  const result: ControlStateConditionResult = { condition: c, matched: false };

  switch (c) {
    case "selected":
      result.expected = true;
      result.actual = snapshot.selected;
      result.matched = snapshot.selected === true;
      break;
    case "notSelected":
      result.expected = false;
      result.actual = snapshot.selected;
      result.matched = snapshot.selected === false;
      break;
    case "toggleStateEquals":
      result.expected = condition.toggleState;
      result.actual = snapshot.toggleState;
      result.matched = snapshot.toggleState === condition.toggleState;
      break;
    case "expanded":
      result.expected = "Expanded";
      result.actual = snapshot.expandCollapseState;
      result.matched = snapshot.expandCollapseState === "Expanded";
      break;
    case "collapsed":
      result.expected = "Collapsed/LeafNode";
      result.actual = snapshot.expandCollapseState;
      result.matched = snapshot.expandCollapseState === "Collapsed" || snapshot.expandCollapseState === "LeafNode";
      break;
    case "exists":
      result.expected = true;
      result.actual = snapshot.exists;
      result.matched = snapshot.exists === true;
      break;
    case "notExists":
      result.expected = false;
      result.actual = snapshot.exists;
      result.matched = snapshot.exists === false;
      break;
    case "visible":
      result.expected = true;
      result.actual = snapshot.offscreen;
      result.matched = snapshot.exists === true && snapshot.offscreen === false;
      break;
    case "hidden":
      result.expected = false;
      result.actual = snapshot.offscreen;
      result.matched = snapshot.exists === true && snapshot.offscreen === true;
      break;
    case "enabled":
      result.expected = true;
      result.actual = snapshot.enabled;
      result.matched = snapshot.enabled === true;
      break;
    case "disabled":
      result.expected = false;
      result.actual = snapshot.enabled;
      result.matched = snapshot.enabled === false;
      break;
    case "valueEquals":
      result.expected = condition.expectedValue;
      result.actual = snapshot.value;
      result.matched = snapshot.value === condition.expectedValue;
      break;
    case "valueContains":
      result.expected = condition.expectedValue;
      result.actual = snapshot.value;
      result.matched = snapshot.value !== null && snapshot.value !== undefined &&
        condition.expectedValue !== undefined && snapshot.value.includes(condition.expectedValue);
      break;
  }
  return result;
}

// Evaluate a declared controlState definition against a snapshot.
//   all: every condition must match
//   any: at least one condition must match
//   both present: all matches AND at least one any matches
//   empty/undefined definition: legacy default (selected OR toggleState On)
export function evaluateControlState(
  snapshot: ControlSnapshot,
  state: ControlStateDefinition | undefined
): ControlStateEvaluation {
  const conditions: ControlStateConditionResult[] = [];

  if (!state || (state.any === undefined && state.all === undefined)) {
    // Legacy default: selected OR toggleState On.
    const matched = snapshot.selected === true || snapshot.toggleState === "On";
    return {
      matched,
      usedDefault: true,
      conditions: [
        { condition: "selected", expected: true, actual: snapshot.selected, matched: snapshot.selected === true },
        { condition: "toggleStateEquals", expected: "On", actual: snapshot.toggleState, matched: snapshot.toggleState === "On" }
      ]
    };
  }

  const allOk = state.all === undefined || state.all.length === 0 || state.all.every((cond) => {
    const r = evaluateControlStateCondition(snapshot, cond);
    conditions.push(r);
    return r.matched;
  });
  const anyOk = state.any === undefined || state.any.length === 0 || state.any.some((cond) => {
    const r = evaluateControlStateCondition(snapshot, cond);
    conditions.push(r);
    return r.matched;
  });

  return { matched: allOk && anyOk, usedDefault: false, conditions };
}
