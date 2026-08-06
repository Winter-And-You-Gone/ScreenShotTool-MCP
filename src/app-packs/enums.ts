// Shared enums for the App Pack semantic/runtime contracts.
//
// Single source of truth so the schema (zod), the validator and the
// executors never drift: a condition or fallback method the schema accepts
// is guaranteed to have an executor implementation, and vice versa.

// Control-state conditions the executor (src/profiles/control-state.ts)
// implements. Must match packControlStateConditionSchema in schemas.ts.
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

// Fallback methods the executor can actually perform (profile composite
// actions map each method to a UIA action). Packs may declare any subset in
// any order; the executor honors the declared order.
export const FALLBACK_METHODS = [
  "SelectionItemPattern",
  "TogglePattern",
  "InvokePattern",
  "WindowMessageElementClick",
  "KeyboardNavigation"
] as const;

export type FallbackMethod = (typeof FALLBACK_METHODS)[number];

// Never executable, even if a pack declares them.
export const FORBIDDEN_FALLBACK_METHODS = ["PhysicalMouse", "GlobalKeyboard", "SetCursorPos"] as const;
