// Unified interaction modes + background policy.
//
// Every high-level tool (profile_launch, profile_action, profile_run_steps,
// run_workflow, run_steps, capture_window) resolves a single interaction mode
// with this priority:
//
//   1. caller-explicit interactionMode argument
//   2. workflow-level interactionMode (workflows.json)
//   3. App Pack profile interaction.defaultMode (profile.json)
//   4. "auto" (legacy behavior)
//
// Mode semantics:
//   auto           - legacy behavior; nothing is forced, nothing is promised.
//   background     - strict background: no foreground steal, no topmost, no
//                    physical cursor, no global keyboard input, capture must
//                    not require top-level visibility. Background failures are
//                    NEVER silently upgraded to foreground; when no verified
//                    background method exists the tool fails with
//                    FOREGROUND_REQUIRED (suggestedMode: foregroundDemo).
//   foregroundDemo - caller-requested foreground presentation: the target may
//                    be restored/activated/raised, and the previous foreground
//                    window is restored afterwards by default.
//
// The core knows NO specific application: packs declare their defaults
// (profile.json interaction / actions.json backgroundPolicy) as data.

import type { PackActions } from "./app-packs/types.js";
import { McpUiError } from "./uia/results.js";

export const INTERACTION_MODES = ["auto", "background", "foregroundDemo"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export const BACKGROUND_POLICIES = ["safe", "bestEffort", "foregroundRequired"] as const;
export type BackgroundPolicy = (typeof BACKGROUND_POLICIES)[number];

// Pack-declared interaction defaults (profile.json "interaction").
export type PackInteractionConfig = {
  defaultMode?: InteractionMode;
  // Whether the core may auto-upgrade a background failure to the foreground
  // path. MUST default to false: the core never upgrades silently.
  allowForegroundFallback?: boolean;
  // How the app should be presented in background mode: "behind" (normal but
  // behind the current foreground window, the recommended default),
  // "minimized", or "normal".
  backgroundPresentation?: "behind" | "minimized" | "normal";
  // foregroundDemo: restore the previous foreground window when the demo
  // (pipeline / workflow) finishes.
  restorePreviousForeground?: boolean;
};

// Caller-supplied foregroundDemo options.
export type InteractionOptions = {
  restorePreviousForeground?: boolean;
  stepDelayMs?: number;
};

// Unified interaction-impact metadata returned by high-level tools (and the
// aggregate pipeline result). Never exposes anything beyond hwnd values and
// booleans - no titles, no process info.
export type InteractionReport = {
  requestedMode: InteractionMode;
  effectiveMode: "background" | "foregroundDemo";
  backgroundPolicy?: BackgroundPolicy;
  method?: string;
  foregroundBefore?: string;
  foregroundAfter?: string;
  foregroundChanged: boolean;
  foregroundRestored?: boolean;
  targetActivated: boolean;
  physicalCursorMoved: boolean;
};

export function isInteractionMode(value: unknown): value is InteractionMode {
  return typeof value === "string" && (INTERACTION_MODES as readonly string[]).includes(value);
}

// Mode resolution priority: explicit > workflow > pack default > auto.
export function resolveInteractionMode(opts: {
  explicit?: InteractionMode;
  workflow?: InteractionMode;
  packDefault?: InteractionMode;
}): InteractionMode {
  return opts.explicit ?? opts.workflow ?? opts.packDefault ?? "auto";
}

// In auto mode the effective mode reflects what ACTUALLY happened (the window
// was activated/foreground changed or not); in the strict modes it is the
// requested mode itself.
export function effectiveModeFor(mode: InteractionMode, foregroundChanged: boolean): "background" | "foregroundDemo" {
  if (mode === "foregroundDemo") return "foregroundDemo";
  if (mode === "background") return "background";
  return foregroundChanged ? "foregroundDemo" : "background";
}

export function emptyInteractionReport(requestedMode: InteractionMode, foregroundChanged = false): InteractionReport {
  return {
    requestedMode,
    effectiveMode: effectiveModeFor(requestedMode, foregroundChanged),
    foregroundChanged,
    targetActivated: false,
    physicalCursorMoved: false
  };
}

// ── Background policy helpers ──

// Look up the pack action contract's backgroundPolicy. Undefined means the
// pack made no claim (treated as "no verified constraint": allowed in
// background, failures surface normally).
export function backgroundPolicyForAction(
  actions: PackActions | undefined,
  control: string | undefined,
  action: string | undefined
): BackgroundPolicy | undefined {
  if (!actions || !control || !action) return undefined;
  const contract = actions.contracts.find((c) => c.control === control && c.action === action);
  return contract?.backgroundPolicy;
}

// A pipeline step's background policy: the action contract's declared policy
// wins; global-input steps (send_key / type_text without noActivate) are
// treated as foregroundRequired - they depend on the current foreground
// window's input focus.
export function stepBackgroundPolicy(
  actions: PackActions | undefined,
  step: { tool: string; args?: Record<string, unknown> }
): BackgroundPolicy | undefined {
  const args = step.args ?? {};
  if ((step.tool === "send_key" || step.tool === "type_text") && args.noActivate !== true) {
    return "foregroundRequired";
  }
  return backgroundPolicyForAction(actions, args.control as string | undefined, args.action as string | undefined);
}

export type UnsafeStep = {
  stepId?: string;
  index?: number;
  backgroundPolicy: BackgroundPolicy;
  suggestedMode: "foregroundDemo";
  tool: string;
  reason: string;
};

// Background preflight: which steps of a pipeline cannot run in background?
// Returns the unsafe steps (empty = background-safe). Only steps with a
// declared foregroundRequired policy (or global keyboard input) are flagged;
// bestEffort steps are allowed to run and surface their own failure.
export function backgroundUnsafeSteps(
  steps: Array<{ id?: string; tool: string; args?: Record<string, unknown> }>,
  getActions: (profileId: string) => PackActions | undefined,
  packActions?: PackActions
): UnsafeStep[] {
  const unsafe: UnsafeStep[] = [];
  steps.forEach((step, index) => {
    const args = step.args ?? {};
    const actions = step.tool === "profile_action" && typeof args.profile === "string"
      ? getActions(args.profile) ?? packActions
      : packActions;
    const policy = stepBackgroundPolicy(actions, step);
    if (policy === "foregroundRequired") {
      const control = args.control as string | undefined;
      const action = args.action as string | undefined;
      unsafe.push({
        ...(step.id ? { stepId: step.id } : {}),
        index,
        backgroundPolicy: "foregroundRequired",
        suggestedMode: "foregroundDemo",
        tool: step.tool,
        reason: control && action
          ? `Action '${action}' on control '${control}' is declared foregroundRequired by the App Pack.`
          : `${step.tool} without noActivate uses global keyboard input.`
      });
    }
  });
  return unsafe;
}

// ── Structured errors ──

// background mode has no verified background-safe method for this operation.
export function foregroundRequiredError(
  reason: string,
  opts: { requestedMode: InteractionMode; backgroundPolicy?: BackgroundPolicy; method?: string }
): McpUiError {
  return new McpUiError("FOREGROUND_REQUIRED", reason, {
    requestedMode: opts.requestedMode,
    effectiveMode: "background",
    ...(opts.backgroundPolicy ? { backgroundPolicy: opts.backgroundPolicy } : {}),
    ...(opts.method ? { method: opts.method } : {}),
    foregroundChanged: false,
    reason,
    suggestedMode: "foregroundDemo"
  });
}

// A pipeline contains foregroundRequired steps while running in background
// mode: refused BEFORE any step executes (never mid-run foreground steal).
export function pipelineNotBackgroundSafeError(
  requestedMode: InteractionMode,
  unsafeSteps: UnsafeStep[]
): McpUiError {
  return new McpUiError("PIPELINE_NOT_BACKGROUND_SAFE", "The pipeline contains steps that cannot run in background mode; no step was executed.", {
    requestedMode,
    effectiveMode: "background",
    reason: "Refused before execution: the pipeline contains foregroundRequired steps.",
    suggestedMode: "foregroundDemo",
    unsafeSteps: unsafeSteps.map((s) => ({
      ...(s.stepId ? { stepId: s.stepId } : { index: s.index }),
      backgroundPolicy: s.backgroundPolicy,
      suggestedMode: s.suggestedMode
    }))
  });
}

// Aggregate pipeline-level interaction report for the result.
export function pipelineInteractionReport(mode: InteractionMode, opts: {
  foregroundBefore?: string;
  foregroundAfter?: string;
  foregroundChanged: boolean;
  foregroundRestored?: boolean;
  targetActivated: boolean;
}): InteractionReport {
  return {
    requestedMode: mode,
    effectiveMode: effectiveModeFor(mode, opts.foregroundChanged),
    ...(opts.foregroundBefore ? { foregroundBefore: opts.foregroundBefore } : {}),
    ...(opts.foregroundAfter ? { foregroundAfter: opts.foregroundAfter } : {}),
    foregroundChanged: opts.foregroundChanged,
    ...(opts.foregroundRestored !== undefined ? { foregroundRestored: opts.foregroundRestored } : {}),
    targetActivated: opts.targetActivated,
    physicalCursorMoved: false
  };
}

// Capture-specific interaction report (capture_window). In background mode the
// capture never activates the target and never changes the foreground;
// foregroundDemo may activate for a 'screen' grab.
export function captureInteractionReport(mode: InteractionMode, opts: {
  foregroundBefore?: string;
  foregroundAfter?: string;
  foregroundChanged: boolean;
  captureMethod: string;
  targetActivated: boolean;
}): InteractionReport {
  return {
    requestedMode: mode,
    effectiveMode: effectiveModeFor(mode, opts.foregroundChanged || opts.targetActivated),
    method: opts.captureMethod,
    ...(opts.foregroundBefore ? { foregroundBefore: opts.foregroundBefore } : {}),
    ...(opts.foregroundAfter ? { foregroundAfter: opts.foregroundAfter } : {}),
    foregroundChanged: opts.foregroundChanged,
    targetActivated: opts.targetActivated,
    physicalCursorMoved: false
  };
}
