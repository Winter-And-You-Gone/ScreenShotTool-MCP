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

// ── Interaction-context injection into pipeline steps ──
//
// High-level entries (run_workflow / profile_run_steps / run_steps) resolve a
// SINGLE interaction context for the whole pipeline. Individual steps must
// inherit that resolved context instead of re-deriving a mode from pack
// defaults (e.g. a foregroundDemo workflow whose profile_action steps would
// otherwise fall back to the pack's background default).
//
// Injection priority per step:
//   1. the step's OWN explicit interactionMode / foregroundDemo args (never
//      overridden),
//   2. the pipeline's resolved interaction context (passed by the caller),
//   3. the tool's own resolution (pack default / auto) at dispatch time.
//
// Injected args are constants (the tool zod schemas accept them), so steps
// keep working exactly like direct tools/call calls. ${...} placeholders are
// resolved against the pipeline context after injection.

import type { PackActions } from "./app-packs/types.js";
import { McpUiError } from "./uia/results.js";
import { validateReferences } from "./piping.js";

export { validateReferences };

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
  // Whether the foreground window at the END differs from the one at the
  // start of the operation.
  foregroundChanged: boolean;
  // Whether the foreground changed AT ANY POINT during the run (even when it
  // was restored afterwards). Optional: reported by the pipeline-level
  // aggregate report.
  foregroundChangedDuringRun?: boolean;
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

// CENTRAL background policy table for the generic tool set. This is the
// SINGLE source of truth used by the pipeline background preflight
// (backgroundUnsafeSteps), so no entry point can disagree about whether a
// tool may run in background mode.
//
// Classification principles:
//   safe                - read-only UIA queries / pure state reads; no
//                         activation, no global input, no capture.
//   bestEffort          - usually works in background but may fail depending
//                         on the app / provider (PrintWindow capture, UIA
//                         pattern actions, targeted posted input). Failures
//                         surface as errors, never auto-upgraded.
//   foregroundRequired  - depends on the current foreground window / focus
//                         (global keyboard input via SendInput, physical
//                         cursor, screen-region capture of arbitrary
//                         occluders). Rejected up front in background mode.
//
// A step's explicit noActivate:true converts bestEffort posted-input tools to
// allowed - but it NEVER upgrades a foregroundRequired tool (a posted key
// still needs the right focus state; screen capture still needs visibility).
const TOOL_BACKGROUND_POLICY: Record<string, BackgroundPolicy> = {
  // Process/window lifecycle.
  launch_app: "bestEffort", // noActivate launch is background-friendly; activate-less spawns can self-activate
  profile_launch: "bestEffort", // pack-declared launch; background presentation is best-effort
  wait_for_window: "safe",
  list_windows: "safe",
  get_window_state: "safe",
  close_app: "bestEffort",
  // Capture.
  capture_window: "bestEffort", // PrintWindow works occluded; 'screen' needs visibility
  capture_screen_region: "foregroundRequired", // copies whatever is on screen - occluders captured instead of the target
  // Input.
  type_text: "foregroundRequired", // SendInput Unicode needs focus (noActivate:true posts WM_CHAR -> bestEffort)
  send_key: "foregroundRequired", // keybd_event needs focus (noActivate:true posts WM_KEYDOWN/UP -> bestEffort)
  click_window: "bestEffort", // targeted PostMessage to a window
  click_menu_item: "bestEffort", // targeted menu invocation
  move_mouse_window: "bestEffort", // posts WM_MOUSEMOVE (no physical cursor)
  read_clipboard: "safe",
  write_clipboard: "bestEffort", // may contend with the focused app's clipboard use
  // UIA.
  ui_inspect_tree: "safe",
  ui_query: "safe",
  ui_get: "safe",
  ui_wait: "safe",
  ui_catalog: "safe",
  ui_action: "bestEffort", // UIA pattern actions usually work unfocused; coordinate fallback needs visibility
  // Profile layer.
  profile_list: "safe",
  profile_resolve: "safe",
  profile_action: "bestEffort", // pack-declared backgroundPolicy refines this
  // Pack / contract discovery.
  app_pack_list: "safe",
  app_pack_describe: "safe",
  resolve_semantic_control: "safe",
  app_pack_validate: "safe",
  app_pack_reload: "safe",
  app_pack_probe: "bestEffort", // inspects a live app's UI
  workflow_catalog: "safe",
  tool_contract_list: "safe",
  tool_contract_describe: "safe"
};

// The base background policy of a generic tool (before pack overrides).
export function toolBackgroundPolicy(tool: string): BackgroundPolicy | undefined {
  return TOOL_BACKGROUND_POLICY[tool];
}

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
  // Global keyboard input without noActivate depends on focus: the posted-
  // message variant (noActivate:true) is a bestEffort targeted input instead.
  if ((step.tool === "send_key" || step.tool === "type_text")) {
    return args.noActivate === true ? "bestEffort" : "foregroundRequired";
  }
  const actionPolicy = backgroundPolicyForAction(actions, args.control as string | undefined, args.action as string | undefined);
  if (actionPolicy) return actionPolicy;
  return toolBackgroundPolicy(step.tool);
}

export type UnsafeStep = {
  stepId?: string;
  index?: number;
  // Which pipeline section the step belongs to (steps / finally). Set by the
  // unified backgroundUnsafePipelineSteps preflight.
  section?: "steps" | "finally";
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

// Unified background preflight for a whole pipeline: main steps AND finally.
// The single logic used by run_steps / profile_run_steps / run_workflow /
// continue_run so no entry point can skip the finally section.
export function backgroundUnsafePipelineSteps(
  steps: Array<{ id?: string; tool: string; args?: Record<string, unknown> }>,
  finallySteps: Array<{ id?: string; tool: string; args?: Record<string, unknown> }>,
  getActions: (profileId: string) => PackActions | undefined,
  packActions?: PackActions
): UnsafeStep[] {
  const main = backgroundUnsafeSteps(steps, getActions, packActions).map((s) => ({ ...s, section: "steps" as const }));
  const fin = backgroundUnsafeSteps(finallySteps, getActions, packActions).map((s) => ({ ...s, section: "finally" as const }));
  return [...main, ...fin];
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
      ...(s.section ? { section: s.section } : {}),
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
  foregroundChangedDuringRun?: boolean;
  foregroundRestored?: boolean;
  targetActivated: boolean;
  physicalCursorMoved?: boolean;
}): InteractionReport {
  return {
    requestedMode: mode,
    effectiveMode: effectiveModeFor(mode, opts.foregroundChanged),
    ...(opts.foregroundBefore ? { foregroundBefore: opts.foregroundBefore } : {}),
    ...(opts.foregroundAfter ? { foregroundAfter: opts.foregroundAfter } : {}),
    foregroundChanged: opts.foregroundChanged,
    ...(opts.foregroundChangedDuringRun ? { foregroundChangedDuringRun: true } : {}),
    ...(opts.foregroundRestored !== undefined ? { foregroundRestored: opts.foregroundRestored } : {}),
    targetActivated: opts.targetActivated,
    physicalCursorMoved: opts.physicalCursorMoved ?? false
  };
}

// Extract the interaction report from a tool result / step result value.
export function interactionOf(value: unknown): InteractionReport | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const interaction = (value as { interaction?: unknown }).interaction;
    if (interaction && typeof interaction === "object" && !Array.isArray(interaction)) {
      return interaction as InteractionReport;
    }
  }
  return undefined;
}

// Aggregate interaction impact across step/finally/restore results.
export function aggregateInteractions(
  interactions: Array<InteractionReport | undefined>
): { foregroundChangedDuringRun: boolean; targetActivated: boolean; physicalCursorMoved: boolean } {
  let foregroundChangedDuringRun = false;
  let targetActivated = false;
  let physicalCursorMoved = false;
  for (const i of interactions) {
    if (!i) continue;
    if (i.foregroundChanged === true || i.foregroundChangedDuringRun === true) foregroundChangedDuringRun = true;
    if (i.targetActivated === true) targetActivated = true;
    if (i.physicalCursorMoved === true) physicalCursorMoved = true;
  }
  return { foregroundChangedDuringRun, targetActivated, physicalCursorMoved };
}

// The subset of tools whose args accept interactionMode + foregroundDemo, and
// must therefore receive the pipeline's resolved interaction context. Only
// tools with real interaction semantics are listed - never invented support.
// ui_action is deliberately absent: it has no interaction params in its
// schema; its background constraints are enforced by the pipeline preflight.
const INTERACTION_AWARE_TOOLS = new Set([
  "profile_launch",
  "profile_action",
  "capture_window",
  "launch_app",
  "type_text",
  "send_key"
]);

export type InteractionAwareStep = { tool: string; args?: Record<string, unknown> };

// Build a step copy with the pipeline's resolved interaction context injected
// into its args (for interaction-aware tools). The step's OWN explicit values
// always win; nothing is injected into other tools. The step's remaining
// fields (id, expect, retry, captureBefore, ...) pass through untouched.
export function prepareStepForInteraction<T extends InteractionAwareStep>(
  step: T,
  interaction: StoredInteractionContext
): T {
  if (!INTERACTION_AWARE_TOOLS.has(step.tool)) return step;
  const args = { ...(step.args ?? {}) };
  // 1. Step-explicit mode wins (never overridden).
  const hasExplicitMode = args.interactionMode !== undefined;
  // 2. Pipeline-resolved mode (stored: requestedMode === effectiveMode).
  const pipelineMode: InteractionMode = interaction.requestedMode ?? "auto";
  const mode = hasExplicitMode ? (args.interactionMode as InteractionMode) : pipelineMode;

  if (!hasExplicitMode && mode !== "auto") {
    args.interactionMode = mode;
  }
  // foregroundDemo options: inherit the pipeline's options unless the step
  // declares its own.
  if (mode === "foregroundDemo") {
    const demo = interaction.foregroundDemo;
    const hasExplicitDemo = args.foregroundDemo !== undefined;
    if (demo && !hasExplicitDemo) {
      args.foregroundDemo = {
        ...(demo.restorePreviousForeground !== undefined ? { restorePreviousForeground: demo.restorePreviousForeground } : {}),
        ...(demo.stepDelayMs !== undefined ? { stepDelayMs: demo.stepDelayMs } : {})
      };
    }
  }
  return { ...step, args } as T;
}

// ── Stored interaction context (continue_run inheritance) ──
// The RESOLVED interaction context of a run, saved in its snapshot so
// continue_run reuses it verbatim instead of re-deriving the mode from the
// CURRENT pack defaults (which may have changed since the original run).
export type StoredInteractionContext = {
  requestedMode: InteractionMode;
  effectiveMode: InteractionMode;
  foregroundDemo?: {
    restorePreviousForeground: boolean;
    stepDelayMs?: number;
  };
  allowForegroundFallback: boolean;
  backgroundPresentation?: string;
};

// Resolve the interaction context for a continuation from the stored context.
// Legacy snapshots (created before interaction-context storage) fall back to
// the current pack default and report contextMissing so the caller can warn.
export function resolveContinuationInteraction(
  stored: StoredInteractionContext | undefined,
  packDefault: InteractionMode | undefined
): { mode: InteractionMode; interaction?: InteractionOptions; contextMissing: boolean } {
  if (!stored) {
    return { mode: resolveInteractionMode({ packDefault }), interaction: undefined, contextMissing: true };
  }
  return {
    mode: stored.requestedMode,
    ...(stored.foregroundDemo
      ? {
          interaction: {
            restorePreviousForeground: stored.foregroundDemo.restorePreviousForeground,
            ...(stored.foregroundDemo.stepDelayMs !== undefined ? { stepDelayMs: stored.foregroundDemo.stepDelayMs } : {})
          }
        }
      : {}),
    contextMissing: false
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
