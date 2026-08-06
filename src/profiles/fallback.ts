// Fallback-policy resolution for composite actions.
//
// A composite action (ensureSelected / ensureVisible) may retry through
// alternate UIA methods after the primary pattern path fails or leaves the
// declared state unverified. Whether any fallback runs at all - and which
// methods in which order - is decided here from FIVE sources, most
// restrictive first:
//
//   1. caller explicit opt-in (allowMessageClickFallback /
//      allowCoordinateFallback)
//   2. control-level fallbackPolicy.enabled (false -> no fallback, even if
//      the action contract allows it)
//   3. control-level fallbackPolicy.methods (declared order; only these)
//   4. action-contract fallbackPolicy (default: enabled)
//   5. interactionMode (background forbids methods that activate the window
//      or move the physical cursor)
//
// Forbidden methods (PhysicalMouse / GlobalKeyboard / SetCursorPos) are
// rejected at schema/validator time; this module refuses them again at
// runtime as defense in depth.

import type { ControlEntry } from "./types.js";
import type { PackActionContract, PackFallbackMethod } from "../app-packs/types.js";
import type { InteractionMode } from "../interaction.js";

// The methods the executor REALLY supports for pattern-free activation.
export const EXECUTABLE_FALLBACK_METHODS: PackFallbackMethod[] = [
  "SelectionItemPattern",
  "TogglePattern",
  "InvokePattern",
  "WindowMessageElementClick"
];

// Never executable - even if a pack (erroneously) declares them.
export const ALWAYS_FORBIDDEN_FALLBACK_METHODS = ["PhysicalMouse", "GlobalKeyboard", "SetCursorPos"] as const;

export type FallbackDecision = {
  enabled: boolean;
  // Methods to try, in declared order (control-level methods win over the
  // action-contract default set).
  methods: PackFallbackMethod[];
  // Why fallback is disabled (for diagnostics).
  disabledReason?: string;
  // Which source supplied the method list.
  source: "control" | "contract" | "default";
};

export type ResolveFallbackInput = {
  controlEntry?: ControlEntry;
  actionContract?: PackActionContract;
  callOptions?: { allowMessageClickFallback?: boolean; allowCoordinateFallback?: boolean };
  interactionMode?: InteractionMode;
};

export function resolveFallbackPolicy(input: ResolveFallbackInput): FallbackDecision {
  const { controlEntry, actionContract, callOptions, interactionMode } = input;

  // 1) Caller opt-in is the outer safety gate: without it, no fallback.
  const callerAllows = (callOptions?.allowMessageClickFallback ?? false) ||
    (callOptions?.allowCoordinateFallback ?? false);
  if (!callerAllows) {
    return { enabled: false, methods: [], source: "default", disabledReason: "caller did not opt in (allowMessageClickFallback/allowCoordinateFallback)" };
  }

  // 2) Control-level enabled=false overrides everything (including the
  //    action contract's default policy).
  const controlFb = controlEntry?.fallbackPolicy;
  if (controlFb?.enabled === false) {
    return { enabled: false, methods: [], source: "control", disabledReason: "control-level fallbackPolicy.enabled=false" };
  }

  // 3) Control-level method list (declared order). Methods are validated at
  //    pack-load; ALWAYS_FORBIDDEN entries are dropped here as defense in depth.
  let methods: PackFallbackMethod[] = [];
  let source: FallbackDecision["source"] = "default";
  if (controlFb?.methods && controlFb.methods.length > 0) {
    methods = controlFb.methods.filter((m): m is PackFallbackMethod =>
      !(ALWAYS_FORBIDDEN_FALLBACK_METHODS as readonly string[]).includes(m)
    );
    source = "control";
  } else {
    // 4) Action-contract default policy (legacy: fallbackPolicy !== "disabled").
    if (actionContract?.fallbackPolicy === "disabled") {
      return { enabled: false, methods: [], source: "contract", disabledReason: "action contract fallbackPolicy=disabled" };
    }
    methods = [...EXECUTABLE_FALLBACK_METHODS];
    source = "contract";
  }

  // 5) interactionMode: background never activates the window or moves the
  //    cursor. All executable fallback methods are window-message/pattern
  //    based and do not move the physical cursor, so background is safe for
  //    the allowed set. (Foreground-only modes would gate here if ever
  //    introduced.)
  void interactionMode;

  if (methods.length === 0) {
    return { enabled: false, methods: [], source, disabledReason: "no executable fallback methods remain after filtering" };
  }
  return { enabled: true, methods, source };
}
