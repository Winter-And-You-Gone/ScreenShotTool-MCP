// Unified pipeline engine.
//
// run_steps, profile_run_steps, run_workflow and continue_run all execute
// through this engine. A pipeline is an ordered list of steps (each with an
// optional id, tool, args, exports, expect, retry), an optional finally list,
// optional state capture/restore, and an overall time budget.
//
// Success semantics per step: tool executed without error AND (if expect is
// set) the postcondition matched. Results are validated against the tool's
// outputSchema before they can be referenced by later steps.

import type { ToolContract } from "./contracts.js";
import { getContract } from "./contracts.js";
import type { PackActions, PackDefaultExpect, PackWorkflowStep } from "./app-packs/types.js";
import type { AppProfile } from "./profiles/types.js";
import { normalizeControlEntry } from "./profiles/types.js";
import { evaluateExpect, type ExpectContext, type ExpectResult } from "./expect.js";
import { extractReferenceHeads, resolvePlaceholdersEx, validateReferences, type PipeContext } from "./piping.js";
import { estimateJsonBytes, isSensitiveFieldName, MAX_PIPELINE_RESULT_BYTES, MAX_STEP_RESULT_BYTES } from "./outputs.js";
import { createRunId, saveRun, type RunSnapshot, type StepSnapshot } from "./runs.js";
import {
  aggregateInteractions,
  backgroundUnsafePipelineSteps,
  interactionOf,
  pipelineInteractionReport,
  pipelineNotBackgroundSafeError,
  prepareStepForInteraction,
  type InteractionMode,
  type InteractionOptions,
  type InteractionReport,
  type StoredInteractionContext
} from "./interaction.js";

// ── Limits (spec section 23) ──

export const MAX_PIPELINE_STEPS = 50;
export const MAX_FINALLY_STEPS = 20;
export const MAX_EXPORTS_PER_STEP = 32;
export const MAX_REF_DEPTH = 16;
export const DEFAULT_MAX_TOTAL_MS = 120_000;
export const MAX_RETRY_ATTEMPTS = 5;

// Codes that may be retried automatically by default.
const DEFAULT_RETRYABLE = new Set([
  "ELEMENT_NOT_AVAILABLE",
  "UIA_ROOT_UNAVAILABLE",
  "TARGET_WINDOW_NOT_READY",
  "POPUP_NOT_READY",
  "PROVIDER_BUSY"
]);

// Codes that are NEVER retried (unless explicitly listed in onlyCodes).
const NEVER_RETRY = new Set([
  "ELEMENT_AMBIGUOUS",
  "WINDOW_AMBIGUOUS",
  "INVALID_SELECTOR",
  "INVALID_PARAMS",
  "PATTERN_NOT_SUPPORTED",
  "PASSWORD_VALUE_PROTECTED",
  "TOOL_OUTPUT_SCHEMA_MISMATCH"
]);

export const RESERVED_STEP_IDS = ["vars", "env", "steps", "results", "run", "pack", "inputs"];
const STEP_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// ── Types ──

export type PipelineStepInput = {
  id?: string;
  tool: string;
  args?: Record<string, unknown>;
  exports?: Record<string, string>;
  expect?: PackDefaultExpect | false;
  retry?: {
    maxAttempts?: number;
    delayMs?: number;
    backoffMultiplier?: number;
    onlyCodes?: string[];
  };
  captureBefore?: CaptureEntry;
  // Finally-only: error codes that are tolerated (the step is reported as
  // skipped instead of failed).
  ignoreCodes?: string[];
};

export type CaptureEntry = {
  saveAs: string;
  read?: { tool?: string; args?: Record<string, unknown> };
};

export type PipelineInput = {
  steps: PipelineStepInput[];
  finally?: PipelineStepInput[];
  captureBefore?: CaptureEntry[];
  restore?: "always" | "never" | "onFailure";
  maxTotalMs?: number;
};

export type StepDispatcher = (tool: string, args: unknown) => Promise<unknown>;

export type PipelineOptions = {
  dispatch: StepDispatcher;
  // App Pack context: enables ${pack.id}, defaultExpect lookup, and
  // profileControl resolution in expect.
  pack?: { id: string; actions: PackActions; profile: AppProfile };
  // Workflow inputs for ${inputs.x}.
  inputs?: Record<string, unknown>;
  // Window/process context auto-injected into steps that lack pid/hwnd
  // (profile_run_steps). Also exposed as ${launch.pid} / ${launch.hwnd}.
  autoContext?: { profile?: string; pid?: number; hwnd?: string; title?: string };
  // Validation callbacks for continue_run preconditions.
  checkProcessAlive?: (pid: number) => Promise<boolean>;
  checkHwndValid?: (hwnd: string) => Promise<boolean>;
  expectDeps: ExpectContext;
  // True when this is a continuation of a previous run (re-resolve args
  // against stored results).
};

export type StepExecutionResult = {
  tool: string;
  success: boolean;
  result?: unknown;
  error?: { code?: string; message: string; details?: unknown };
  expectResult?: ExpectResult | null;
  stateSettled?: boolean;
  // True when the step was skipped because the pipeline deadline was
  // exceeded (never attempted). Skipped finally steps stay executable: a
  // continuation re-attempts them with its fresh deadline.
  skipped?: boolean;
};

export type PipelineResult = {
  schemaVersion: number;
  success: boolean;
  runId: string;
  status: "completed" | "failed";
  total: number;
  completed: number;
  stoppedAtIndex: number | null;
  stoppedAt?: string;
  continuedFrom?: string | number;
  completedSteps: string[];
  steps: StepExecutionResult[];
  exports: Record<string, unknown>;
  error?: { code?: string; message: string; details?: unknown };
  finallyResults: StepExecutionResult[];
  restoreResults: Array<{ key: string; success: boolean; message?: string; valueCaptured?: boolean }>;
  warnings: string[];
  // Continuability of the saved run snapshot (continue_run preconditions).
  continuable: boolean;
  continuationReason: string | null;
  // Aggregate interaction report (mode, foreground restore for
  // foregroundDemo, honest foregroundChanged).
  interaction?: InteractionReport;
};

// ── Static validation (shared by validate_steps and run-time preflight) ──

export type StaticIssue = {
  stepId?: string;
  path: string;
  code: string;
  message: string;
  suggestion?: string;
};

export type StaticValidationResult = {
  valid: boolean;
  errors: StaticIssue[];
  warnings: StaticIssue[];
  estimatedMaxDurationMs: number;
  toolCount: number;
};

export type StaticValidationContext = {
  pack?: { id: string; actions: PackActions };
  getContract: (name: string) => ToolContract | undefined;
  parseArgs?: (tool: string, args: unknown) => { ok: boolean; message?: string };
  windowContext?: { pid?: number; hwnd?: string; title?: string };
};

// Estimate the per-step default budget for tools without an explicit expect
// timeout, used for estimatedMaxDurationMs.
function defaultStepBudget(tool: string): number {
  switch (tool) {
    case "profile_launch": return 30_000;
    case "launch_app": return 15_000;
    case "wait_for_window": return 30_000;
    case "ui_action": case "profile_action": return 15_000;
    case "ui_wait": return 10_000;
    default: return 10_000;
  }
}

function stepBudget(step: PipelineStepInput, expect: PackDefaultExpect | false | undefined): number {
  if (expect && expect.timeoutMs) return expect.timeoutMs;
  if (step.expect && step.expect.timeoutMs) return step.expect.timeoutMs;
  return defaultStepBudget(step.tool);
}

export function validatePipelineStatic(input: PipelineInput, ctx: StaticValidationContext): StaticValidationResult {
  const errors: StaticIssue[] = [];
  const warnings: StaticIssue[] = [];
  const steps = input.steps;
  const tools = new Set<string>();

  if (steps.length > MAX_PIPELINE_STEPS) {
    errors.push({ path: "steps", code: "TOO_MANY_STEPS", message: `Pipeline has ${steps.length} steps; the limit is ${MAX_PIPELINE_STEPS}.` });
  }
  if ((input.finally ?? []).length > MAX_FINALLY_STEPS) {
    errors.push({ path: "finally", code: "TOO_MANY_FINALLY_STEPS", message: `finally has ${input.finally!.length} steps; the limit is ${MAX_FINALLY_STEPS}.` });
  }

  // Step ids: valid, unique, not reserved.
  const idAt = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!step.id) return;
    if (!STEP_ID_RE.test(step.id)) {
      errors.push({ stepId: step.id, path: `steps.${index}.id`, code: "INVALID_STEP_ID", message: `Step id '${step.id}' is invalid.`, suggestion: "Step ids must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$." });
    }
    if (RESERVED_STEP_IDS.includes(step.id)) {
      errors.push({ stepId: step.id, path: `steps.${index}.id`, code: "RESERVED_STEP_ID", message: `Step id '${step.id}' is reserved.`, suggestion: `Reserved: ${RESERVED_STEP_IDS.join(", ")}.` });
    }
    if (idAt.has(step.id)) {
      errors.push({ stepId: step.id, path: `steps.${index}.id`, code: "DUPLICATE_STEP_ID", message: `Duplicate step id '${step.id}'.`, suggestion: "Step ids must be unique." });
    }
    idAt.set(step.id, index);
  });

  let estimatedMaxDurationMs = 0;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const contract = ctx.getContract(step.tool);
    if (!contract) {
      errors.push({ stepId: step.id, path: `steps.${index}.tool`, code: "UNKNOWN_TOOL", message: `Tool '${step.tool}' is not an MCP tool of this server.`, suggestion: "Check the tool name against tools/list." });
      continue;
    }
    tools.add(step.tool);

    // Reference checks: backward-only, fields exist in output schemas.
    const refs = extractReferenceHeads(step.args);
    for (const ref of refs) {
      if (ref.head === "pack") {
        if (!ctx.pack) errors.push({ stepId: step.id, path: `steps.${index}.args`, code: "NO_PACK_CONTEXT", message: "${pack.id} requires an App Pack context.", suggestion: "Use run_workflow or profile_run_steps with a pack." });
        continue;
      }
      if (ref.head === "inputs") {
        continue; // inputs are resolved from workflow inputs
      }
      if (/^\d+$/.test(ref.head)) {
        const n = Number(ref.head);
        if (n >= index) {
          errors.push({ stepId: step.id, path: `steps.${index}.args`, code: "FORWARD_REFERENCE", message: `Step ${index} references step ${n}; a step may only reference earlier steps.` });
        } else {
          const refStep = steps[n];
          const refContract = refStep ? ctx.getContract(refStep.tool) : undefined;
          if (refContract && ref.tail.length > 0 && !fieldExists(refContract, ref.tail)) {
            errors.push({
              stepId: step.id, path: `steps.${index}.args`, code: "UNKNOWN_OUTPUT_PATH",
              message: `Output path '${ref.head}.${ref.tail.join(".")}' does not exist in ${refStep!.tool}'s output schema.`,
              suggestion: suggestionForField(refContract, ref.tail)
            });
          }
        }
        continue;
      }
      const refIndex = idAt.get(ref.head);
      if (refIndex === undefined) {
        errors.push({ stepId: step.id, path: `steps.${index}.args`, code: "UNKNOWN_STEP_REFERENCE", message: `Step references '${ref.head}' which is not a step id.`, suggestion: "Use an earlier step's id, a numeric index, ${pack.id}, or ${inputs.x}." });
      } else if (refIndex >= index) {
        errors.push({ stepId: step.id, path: `steps.${index}.args`, code: "FORWARD_REFERENCE", message: `Step references '${ref.head}' (step ${refIndex}); a step may only reference earlier steps.` });
      } else {
        const refStep = steps[refIndex];
        const refContract = refStep ? ctx.getContract(refStep.tool) : undefined;
        if (refContract && ref.tail.length > 0 && !fieldExists(refContract, ref.tail)) {
          errors.push({
            stepId: step.id, path: `steps.${index}.args`, code: "UNKNOWN_OUTPUT_PATH",
            message: `Output path '${ref.head}.${ref.tail.join(".")}' does not exist in ${refStep!.tool}'s output schema.`,
            suggestion: suggestionForField(refContract, ref.tail)
          });
        }
      }
    }

    // Export paths must exist in the step tool's output schema. Paths are
    // relative to the result root (optional "$" prefix).
    for (const [name, exportPath] of Object.entries(step.exports ?? {})) {
      if (isSensitiveFieldName(name.split("."))) {
        errors.push({ stepId: step.id, path: `steps.${index}.exports.${name}`, code: "EXPORT_SENSITIVE_VALUE_BLOCKED", message: `Export '${name}' matches a sensitive field name.`, suggestion: "Rename the export; sensitive values are never piped." });
      }
      const exportSegments = exportPath.split(".").filter((s) => s !== "$" && s !== "");
      if (exportSegments.length > 0 && !fieldExists(contract, exportSegments)) {
        errors.push({
          stepId: step.id, path: `steps.${index}.exports.${name}`, code: "EXPORT_PATH_NOT_FOUND",
          message: `Export '${name}' path '${exportPath}' does not exist in ${step.tool}'s output schema.`,
          suggestion: suggestionForField(contract, exportSegments)
        });
      }
    }

    // Argument schema check with placeholders masked by typed dummies.
    if (ctx.parseArgs) {
      const masked = maskArgs(step.args ?? {}, (head, tail) => dummyForRef(head, tail, steps, idAt, ctx));
      const parsed = ctx.parseArgs(step.tool, masked);
      if (!parsed.ok) {
        errors.push({
          stepId: step.id, path: `steps.${index}.args`, code: "INVALID_PARAMS",
          message: `Step args do not satisfy ${step.tool}'s input schema: ${parsed.message}`,
          suggestion: "Fix the args or the referenced fields' types."
        });
      }
    }

    // Async actions without expect.
    if (contract.annotations?.needsExpect && step.expect === undefined && !packHasDefaultExpect(ctx, step)) {
      warnings.push({
        stepId: step.id, path: `steps.${index}.expect`, code: "MISSING_EXPECT",
        message: `'${step.tool}' fires an action; no expect postcondition is set and the pack has no defaultExpect for it.`,
        suggestion: "Add expect (e.g. {profileControl, condition:'exists'}) or expect:false to acknowledge."
      });
    }

    // Unsafe retry on non-idempotent steps.
    if (step.retry && !isStepIdempotent(ctx, step)) {
      errors.push({
        stepId: step.id, path: `steps.${index}.retry`, code: "UNSAFE_RETRY",
        message: `Step '${step.tool}' has retry configured but is not idempotent; automatic retry could double-fire the action.`,
        suggestion: "Mark the action idempotent in the pack's actions.json, or verify with expect before retrying."
      });
    }

    // Budget accumulation.
    const attempts = step.retry?.maxAttempts ?? 1;
    const budget = stepBudget(step, step.expect) * Math.min(attempts, MAX_RETRY_ATTEMPTS);
    estimatedMaxDurationMs += budget;
  }

  for (const step of input.finally ?? []) {
    if (!ctx.getContract(step.tool)) {
      errors.push({ stepId: step.id, path: "finally.tool", code: "UNKNOWN_TOOL", message: `Finally tool '${step.tool}' is not an MCP tool.` });
    }
    estimatedMaxDurationMs += stepBudget(step, step.expect);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    estimatedMaxDurationMs: Math.min(estimatedMaxDurationMs, 3_600_000),
    toolCount: tools.size
  };
}

function fieldExists(contract: ToolContract, segments: string[]): boolean {
  let node: import("./contracts.js").JsonSchema = contract.outputSchema;
  for (const seg of segments) {
    // Numeric segments index into arrays.
    if (/^\d+$/.test(seg)) {
      if (node.type === "array" && node.items) {
        node = node.items;
        continue;
      }
      if (node.type === "object" && node.properties?.items?.type === "array") {
        node = node.properties.items.items ?? {};
        continue;
      }
    }
    if (node.type === "array" && node.items) node = node.items;
    // Unverifiable schema node (any / untyped / no declared properties):
    // deeper paths cannot be checked statically, assume they may exist.
    if (!node.properties) return true;
    if (!node.properties[seg]) return false;
    node = node.properties[seg]!;
  }
  return true;
}

function suggestionForField(contract: ToolContract, tail: string[]): string {
  const top = contract.pipeSafeFields.length > 0
    ? `Pipe-safe fields: ${contract.pipeSafeFields.join(", ")}.`
    : `Use a top-level field of ${contract.name}'s output schema.`;
  return `${top} Referenced path: '${tail.join(".")}'.`;
}

// Replace placeholder strings with typed dummy values so the target tool's
// input schema can be checked statically.
function maskArgs(args: unknown, dummyFor: (head: string, tail: string[]) => unknown): unknown {
  return maskNode(args);

  function maskNode(v: unknown): unknown {
    if (typeof v === "string") {
      const whole = /^\$\{([A-Za-z0-9_]+)((?:\.[\w]+)*)\}$/.exec(v);
      if (whole) return dummyFor(whole[1]!, whole[2] ? whole[2].slice(1).split(".") : []);
      return v.replace(/\$\{([A-Za-z0-9_]+)(?![A-Za-z0-9_:-])((?:\.[\w]+)*)\}/g, () => "ref");
    }
    if (Array.isArray(v)) return v.map(maskNode);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = maskNode(val);
      return out;
    }
    return v;
  }
}

function dummyForRef(
  head: string,
  tail: string[],
  steps: PipelineStepInput[],
  idAt: Map<string, number>,
  ctx: StaticValidationContext
): unknown {
  if (head === "pack") return { id: ctx.pack?.id ?? "pack" };
  if (head === "inputs") return "value";
  if (/^\d+$/.test(head)) return dummyFromSchema(steps[Number(head)] ? ctx.getContract(steps[Number(head)]!.tool) : undefined, tail);
  const idx = idAt.get(head);
  if (idx === undefined) return "ref";
  return dummyFromSchema(ctx.getContract(steps[idx]!.tool), tail);
}

function dummyFromSchema(contract: ToolContract | undefined, tail: string[]): unknown {
  if (!contract) return "ref";
  let node: import("./contracts.js").JsonSchema = contract.outputSchema;
  for (const seg of tail) {
    if (node.type === "array" && node.items) node = node.items;
    if (!node.properties || !node.properties[seg]) return "ref";
    node = node.properties[seg]!;
  }
  switch (node.type) {
    // 1 satisfies positive/zero minimums on common numeric fields (pid,
    // index, expectedCount) - a 0 dummy would fail minimum:1 constraints.
    case "number": case "integer": return 1;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    case "string": default: return "ref";
  }
}

function packHasDefaultExpect(ctx: StaticValidationContext, step: PipelineStepInput): boolean {
  if (!ctx.pack) return false;
  const control = step.args?.control as string | undefined;
  const action = step.args?.action as string | undefined;
  if (!control || !action) return false;
  return ctx.pack.actions.contracts.some((c) => c.control === control && c.action === action && c.defaultExpect);
}

function isStepIdempotent(ctx: StaticValidationContext, step: PipelineStepInput): boolean {
  const contract = ctx.getContract(step.tool);
  if (contract?.annotations?.idempotent) return true;
  if (["ui_wait", "ui_get", "ui_query", "ui_inspect_tree", "ui_catalog", "read_clipboard", "list_windows", "get_window_state", "wait_for_window", "profile_resolve", "profile_list"].includes(step.tool)) return true;
  if (!ctx.pack) return false;
  const control = step.args?.control as string | undefined;
  const action = step.args?.action as string | undefined;
  if (!control || !action) return false;
  const c = ctx.pack.actions.contracts.find((x) => x.control === control && x.action === action);
  return c?.idempotent === true;
}

// ── Execution ──

export type ExecutionContext = {
  dispatch: StepDispatcher;
  pack?: { id: string; actions: PackActions; profile: AppProfile; version?: string };
  // Resolve an App Profile by id from the server's pack registry. Needed by
  // page/selection capture for run_steps pipelines that carry a profile in
  // their step args but no pack context.
  resolveProfile?: (profileId: string) => AppProfile | undefined;
  // Resolve a pack's action contracts by profile id (background-policy
  // preflight for pack-less run_steps pipelines).
  resolvePackActions?: (profileId: string) => PackActions | undefined;
  // Resolved interaction mode for this pipeline (explicit > workflow > pack
  // default > auto). Background preflights the steps; foregroundDemo restores
  // the previous foreground window at the end.
  interactionMode?: InteractionMode;
  interaction?: InteractionOptions & { foregroundBefore?: string };
  // Restores a previous foreground window (foregroundDemo cleanup). Wired by
  // index.ts to the windows module.
  restoreForeground?: (previousForegroundHwnd?: string) => Promise<{ restored: boolean; foregroundHwnd: string; foregroundChanged: boolean }>;
  // Reads the current foreground window hwnd. Wired by index.ts; absent in
  // unit tests (the pipeline then reports only what steps themselves
  // observed).
  getForeground?: () => Promise<string>;
  inputs?: Record<string, unknown>;
  autoContext?: { profile?: string; pid?: number; hwnd?: string; title?: string };
  expectDeps: ExpectContext;
};

// ── Typed state capture / restore ──
//
// captureBefore records a TYPED state snapshot (not just a raw value):
// value / toggle / selection / range / expanded / visibility / page. The
// capture kind is derived from the step's action when available, else
// auto-detected from the control's UIA state. Restore replays the matching
// reverse action and VERIFIES the state afterwards. Password-protected
// controls are never captured or restored.

export type CapturedState =
  | { kind: "value"; value: string }
  | { kind: "toggle"; checked: boolean }
  // Real PRE-ACTION selection state. name = the actually selected item's
  // display text at capture time; index = its real 0-based position among the
  // provider's items when reliably readable. NEVER derived from the step's
  // target arguments (step.args.value / step.args.index are the DESTINATION).
  | { kind: "selection"; name?: string; index?: number }
  | { kind: "range"; value: number }
  | { kind: "expanded"; expanded: boolean }
  | { kind: "visibility"; visible: boolean }
  // Real PRE-ACTION page: the logical control that was actually selected
  // (toggleState On / selected true) before the navigation step. Never the
  // step's target control.
  | { kind: "page"; profile?: string; control?: string };

export type CapturedValue = {
  key: string;
  stepId?: string;
  // null when the pre-action state could not be determined (captureFailed).
  state: CapturedState | null;
  // The intended state kind when state is null (capture failed).
  kind?: CapturedState["kind"];
  // True when the state could not be read before the action; restore then
  // reports RESTORE_STATE_UNAVAILABLE instead of guessing.
  captureFailed?: boolean;
  protected: boolean;
  readTool: string;
  readArgs: Record<string, unknown>;
  // For step-level captures: the step's own tool/args (restore targets the
  // same control with the matching reverse action).
  stepTool?: string;
  stepArgs?: Record<string, unknown>;
};

// Map a step action to the state kind it mutates.
function captureKindForAction(action: string | undefined): CapturedState["kind"] | "auto" {
  switch (action) {
    case "setValue": case "appendText": case "clear": return "value";
    case "setChecked": case "toggle": return "toggle";
    case "selectByName": case "selectByIndex": return "selection";
    case "setRangeValue": return "range";
    case "expand": case "collapse": return "expanded";
    case "ensureSelected": case "ensurePageSelected": return "page";
    default: return "auto";
  }
}

// The UIA element fields the state handlers rely on.
type ElementLike = {
  isPassword?: boolean;
  valueProtected?: boolean;
  value?: string | null;
  selectedName?: string | null;
  selectedIndex?: number | null;
  toggleState?: string | null;
  selected?: boolean | null;
  rangeValue?: number | null;
  expandCollapseState?: string | null;
  offscreen?: boolean;
};

type CaptureContext = {
  element?: ElementLike;
  readArgs: Record<string, unknown>;
  ctx: ExecutionContext;
  step?: PipelineStepInput;
};

type RestorePlan = { action: string; restoreArgs: { tool: string; args: Record<string, unknown> } } | { action: null };

type StateHandler = {
  capture(c: CaptureContext): Promise<CapturedState | undefined>;
  restoreAction(entry: CapturedValue): RestorePlan;
  verify(entry: CapturedValue, ctx: ExecutionContext): Promise<{ ok: boolean; expected: string; actual: string }>;
};

// Extract window-context fields from a read/capture args object.
function windowFields(args: Record<string, unknown>): { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string } {
  return {
    ...(args.hwnd !== undefined ? { hwnd: args.hwnd as string | number } : {}),
    ...(args.pid !== undefined ? { pid: args.pid as number } : {}),
    ...(args.processName !== undefined ? { processName: args.processName as string } : {}),
    ...(args.titleContains !== undefined ? { titleContains: args.titleContains as string } : {})
  };
}

// Scan the control's popup for the uniquely selected ListItem. This is a
// REAL read of the provider's current selection (name + position), never a
// guess from action arguments.
async function scanSelectedListItem(ctx: ExecutionContext, readArgs: Record<string, unknown>): Promise<{ name?: string; index?: number } | undefined> {
  try {
    const q = await ctx.dispatch("ui_query", {
      ...windowFields(readArgs),
      selector: { controlType: "ListItem" },
      includeProcessPopups: true,
      maxDepth: 15,
      maxResults: 200,
      timeoutMs: 8000
    });
    const elements = (q as { elements?: Array<{ selected?: boolean | null; name?: string }> }).elements ?? [];
    const selected = elements.filter((e) => e.selected === true);
    if (selected.length === 1) {
      const pos = elements.indexOf(selected[0]!);
      return { name: selected[0]!.name, index: pos >= 0 ? pos : undefined };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Read whether a logical control is currently selected (toggle On / selected
// true). Returns undefined when the state cannot be determined. The window
// context (hwnd/pid) from the step is forwarded so resolve targets the right
// window even when the app exposes several top-level windows.
async function isControlSelected(ctx: ExecutionContext, control: string, window?: { hwnd?: string | number; pid?: number }, profile?: AppProfile): Promise<boolean | undefined> {
  const resolved = profile ?? ctx.pack?.profile;
  if (!resolved) return undefined;
  try {
    const r = await ctx.dispatch("profile_resolve", {
      profile: resolved.id,
      control,
      ...(window?.hwnd !== undefined ? { hwnd: window.hwnd } : {}),
      ...(window?.pid !== undefined ? { pid: window.pid } : {}),
      includeProcessPopups: true,
      maxDepth: 15,
      maxNodes: 2000,
      timeoutMs: 8000
    });
    const element = (r as { element?: ElementLike }).element;
    if (!element) return undefined;
    if (element.toggleState !== null && element.toggleState !== undefined) return element.toggleState === "On";
    if (element.selected !== null && element.selected !== undefined) return element.selected === true;
    return undefined;
  } catch {
    return undefined;
  }
}

// Determine the ACTUAL pre-action selected page: the unique control in the
// step's selectionGroup whose state reads selected. 0 or >1 candidates ->
// undefined (RESTORE_STATE_UNAVAILABLE), never a guess.
async function captureOriginalPage(ctx: ExecutionContext, step: PipelineStepInput): Promise<{ kind: "page"; profile?: string; control?: string } | undefined> {
  const stepProfileId = step.args?.profile as string | undefined;
  const profile = ctx.pack?.profile ?? (stepProfileId && ctx.resolveProfile ? ctx.resolveProfile(stepProfileId) : undefined);
  if (!profile) return undefined;
  const stepControl = step.args?.control as string | undefined;
  if (!stepControl) return undefined;
  // Page group: the step's own control declares selectionGroup, or the pack
  // action contract for (control, action) declares one.
  let group: string | undefined;
  const ownEntry = normalizeControlEntry(profile.controls[stepControl]);
  if (ownEntry?.selectionGroup) group = ownEntry.selectionGroup;
  if (!group && ctx.pack) {
    const action = step.args?.action as string | undefined;
    const contract = ctx.pack.actions.contracts.find((c) => c.control === stepControl && c.action === action);
    group = contract?.selectionGroup;
  }
  if (!group) return undefined;

  // Candidates: every profile control in the same group (including the step
  // target - before the action it may or may not be the selected page).
  const candidates = Object.entries(profile.controls)
    .filter(([name, raw]) => {
      if (name === stepControl && !ownEntry?.selectionGroup) return false; // target without a group decl is not a candidate
      const entry = normalizeControlEntry(raw);
      return entry?.selectionGroup === group;
    })
    .map(([name]) => name);
  if (candidates.length < 2) return undefined;

  const selectedPages: string[] = [];
  const window = {
    ...(step.args?.hwnd !== undefined ? { hwnd: step.args.hwnd as string | number } : {}),
    ...(step.args?.pid !== undefined ? { pid: step.args.pid as number } : {})
  };
  for (const control of candidates) {
    const selected = await isControlSelected(ctx, control, window, profile);
    if (selected === true) selectedPages.push(control);
  }
  if (selectedPages.length !== 1) return undefined; // 0 or ambiguous
  return { kind: "page", profile: profile.id, control: selectedPages[0]! };
}

// ── per-kind state handlers ──

const STATE_HANDLERS: Record<CapturedState["kind"], StateHandler> = {
  value: {
    capture: ({ element }) => {
      if (element && typeof element.value === "string") return Promise.resolve({ kind: "value", value: element.value });
      return Promise.resolve(undefined);
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "value"; value: string };
      return actionForTarget(entry, "setValue", { value: s.value });
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "value"; value: string };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: s.value, actual: "element not found" };
      return { ok: element.value === s.value, expected: s.value, actual: String(element.value) };
    }
  },
  toggle: {
    capture: ({ element }) => {
      if (element && element.toggleState !== null && element.toggleState !== undefined) {
        return Promise.resolve({ kind: "toggle", checked: element.toggleState === "On" });
      }
      return Promise.resolve(undefined);
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "toggle"; checked: boolean };
      return actionForTarget(entry, "setChecked", { value: s.checked ? "true" : "false" });
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "toggle"; checked: boolean };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: String(s.checked), actual: "element not found" };
      return { ok: (element.toggleState === "On") === s.checked, expected: String(s.checked), actual: String(element.toggleState) };
    }
  },
  selection: {
    capture: async ({ element, readArgs, ctx }) => {
      if (!element) return undefined;
      // Real pre-action selection: from the read element first...
      const name = typeof element.value === "string" && element.value.length > 0
        ? element.value
        : (element.selectedName ?? undefined);
      let index = element.selectedIndex ?? undefined;
      // ...then, when parts are missing, from a real scan of the provider's
      // items (the uniquely selected ListItem's position). NEVER from
      // step.args.value / step.args.index.
      if (name === undefined || index === undefined) {
        const scan = await scanSelectedListItem(ctx, readArgs);
        if (scan) {
          if (name === undefined && scan.name !== undefined) {
            const merged: { kind: "selection"; name?: string; index?: number } = { kind: "selection", name: scan.name };
            if (index !== undefined) merged.index = index;
            else if (scan.index !== undefined) merged.index = scan.index;
            return merged;
          }
          if (index === undefined && scan.index !== undefined) index = scan.index;
        }
      }
      if (name === undefined && index === undefined) return undefined;
      return { kind: "selection", ...(name !== undefined ? { name } : {}), ...(index !== undefined ? { index } : {}) };
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "selection"; name?: string; index?: number };
      // Restore order: reliable name first, then the ORIGINAL index.
      if (s.name !== undefined) return actionForTarget(entry, "selectByName", { value: s.name });
      if (s.index !== undefined) return actionForTarget(entry, "selectByIndex", { index: s.index });
      return { action: null };
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "selection"; name?: string; index?: number };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: s.name ?? `index=${s.index}`, actual: "element not found" };
      // Name verification first; when the name is not readable back but an
      // ORIGINAL index was captured, verify the index via a real item scan.
      if (s.name !== undefined) {
        const readName = element.value ?? element.selectedName ?? null;
        if (readName === s.name) return { ok: true, expected: s.name, actual: String(readName) };
        if (s.index !== undefined) {
          const scan = await scanSelectedListItem(ctx, entry.readArgs);
          if (scan && scan.index === s.index) return { ok: true, expected: `index=${s.index}`, actual: `index=${scan.index} name=${scan.name ?? "?"}` };
        }
        return { ok: false, expected: s.name, actual: String(readName) };
      }
      if (s.index !== undefined) {
        const scan = await scanSelectedListItem(ctx, entry.readArgs);
        if (!scan || scan.index === undefined) return { ok: false, expected: `index=${s.index}`, actual: "no uniquely selected item readable" };
        return { ok: scan.index === s.index, expected: `index=${s.index}`, actual: `index=${scan.index} name=${scan.name ?? "?"}` };
      }
      return { ok: false, expected: "selection", actual: "no name/index captured" };
    }
  },
  range: {
    capture: ({ element }) => {
      if (element && typeof element.rangeValue === "number") return Promise.resolve({ kind: "range", value: element.rangeValue });
      return Promise.resolve(undefined);
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "range"; value: number };
      return actionForTarget(entry, "setRangeValue", { rangeValue: s.value });
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "range"; value: number };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: String(s.value), actual: "element not found" };
      return { ok: element.rangeValue === s.value, expected: String(s.value), actual: String(element.rangeValue) };
    }
  },
  expanded: {
    capture: ({ element }) => {
      if (element && element.expandCollapseState !== null && element.expandCollapseState !== undefined) {
        return Promise.resolve({ kind: "expanded", expanded: element.expandCollapseState === "Expanded" });
      }
      return Promise.resolve(undefined);
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "expanded"; expanded: boolean };
      return actionForTarget(entry, s.expanded ? "expand" : "collapse");
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "expanded"; expanded: boolean };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: String(s.expanded), actual: "element not found" };
      return { ok: (element.expandCollapseState === "Expanded") === s.expanded, expected: String(s.expanded), actual: String(element.expandCollapseState) };
    }
  },
  visibility: {
    capture: ({ element }) => {
      if (element && element.offscreen !== undefined) return Promise.resolve({ kind: "visibility", visible: !element.offscreen });
      return Promise.resolve(undefined);
    },
    restoreAction: () => ({ action: null }),
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "visibility"; visible: boolean };
      const element = await readElement(entry, ctx);
      if (!element) return { ok: false, expected: String(s.visible), actual: "element not found" };
      return { ok: !element.offscreen === s.visible, expected: String(s.visible), actual: String(!element.offscreen) };
    }
  },
  page: {
    capture: async ({ ctx, step }) => {
      if (!step) return undefined;
      return captureOriginalPage(ctx, step);
    },
    restoreAction: (entry) => {
      const s = entry.state as { kind: "page"; profile?: string; control?: string };
      if (!s.control) return { action: null };
      // Restore the ORIGINAL page control (never the step's target).
      const profile = s.profile ?? (entry.stepArgs?.profile as string | undefined);
      if (!profile) return { action: null };
      return {
        action: "ensureSelected",
        restoreArgs: {
          tool: "profile_action",
          args: {
            profile, control: s.control, action: "ensureSelected",
            ...(entry.stepArgs?.hwnd !== undefined ? { hwnd: entry.stepArgs.hwnd } : {}),
            ...(entry.stepArgs?.pid !== undefined ? { pid: entry.stepArgs.pid } : {})
          }
        }
      };
    },
    verify: async (entry, ctx) => {
      const s = entry.state as { kind: "page"; profile?: string; control?: string };
      if (!s.control) return { ok: false, expected: "original page", actual: "no captured control" };
      const window = {
        ...(entry.stepArgs?.hwnd !== undefined ? { hwnd: entry.stepArgs.hwnd as string | number } : {}),
        ...(entry.stepArgs?.pid !== undefined ? { pid: entry.stepArgs.pid as number } : {})
      };
      const verifyProfile = ctx.pack?.profile ?? (s.profile && ctx.resolveProfile ? ctx.resolveProfile(s.profile) : undefined);
      // REAL re-query: the original control must read selected again...
      const origSelected = await isControlSelected(ctx, s.control, window, verifyProfile);
      if (origSelected !== true) {
        return { ok: false, expected: `${s.control} selected=true`, actual: `${s.control} selected=${String(origSelected)}` };
      }
      // ...and the step's target page (if different) must no longer be selected.
      const targetControl = entry.stepArgs?.control as string | undefined;
      if (targetControl && targetControl !== s.control) {
        const targetSelected = await isControlSelected(ctx, targetControl, window, verifyProfile);
        if (targetSelected === true) {
          return { ok: false, expected: `${targetControl} not selected`, actual: `${targetControl} still selected` };
        }
      }
      return { ok: true, expected: s.control, actual: `${s.control} selected=true` };
    }
  }
};

// Build the reverse-action plan for value/toggle/range/expanded/selection on
// the same target the capture came from (step tool + args, or ui_get args).
function actionForTarget(entry: CapturedValue, action: string, extra: Record<string, unknown> = {}): RestorePlan {
  const stepTool = entry.stepTool;
  const stepArgs = entry.stepArgs;
  if (stepTool === "profile_action" && stepArgs) {
    return { action, restoreArgs: { tool: "profile_action", args: { ...stepArgs, action, ...extra } } };
  }
  if (stepTool === "ui_action" && stepArgs) {
    return { action, restoreArgs: { tool: "ui_action", args: { ...stepArgs, action, ...extra } } };
  }
  if (entry.readTool === "ui_get") {
    return { action, restoreArgs: { tool: "ui_action", args: { ...entry.readArgs, action, ...extra } } };
  }
  return { action: null };
}

// Re-read the captured control's element.
async function readElement(entry: CapturedValue, ctx: ExecutionContext): Promise<ElementLike | null | undefined> {
  const readTool = entry.readTool ?? "ui_get";
  try {
    const result = await ctx.dispatch(readTool, entry.readArgs);
    const element = (result as { element?: ElementLike }).element;
    if (element?.isPassword || element?.valueProtected) {
      const err = new Error("RESTORE_SENSITIVE_STATE_BLOCKED") as Error & { code?: string };
      err.code = "RESTORE_SENSITIVE_STATE_BLOCKED";
      throw err;
    }
    return element;
  } catch (error) {
    throw error;
  }
}

// Read a control's state before an action (for later restore). Password
// fields are never captured (valueProtected).
async function captureValue(
  entry: CaptureEntry,
  ctx: ExecutionContext,
  byId: Map<string, unknown>,
  byIndex: unknown[],
  step?: PipelineStepInput
): Promise<CapturedValue | undefined> {
  const read = entry.read ?? { tool: "ui_get", args: {} };
  const readTool = read.tool ?? "ui_get";
  let args: unknown;
  try {
    const resolution = resolvePlaceholdersEx(read.args ?? {}, { byId, byIndex, pack: ctx.pack ? { id: ctx.pack.id } : undefined, inputs: ctx.inputs });
    if (!resolution.ok) return undefined;
    args = resolution.value;
  } catch {
    return undefined;
  }
  const readArgs = (read.args ?? {}) as Record<string, unknown>;

  // Page selection is captured from the profile's page group BEFORE the
  // action runs - never from the step's target control.
  if (step && captureKindForAction(step.args?.action as string | undefined) === "page") {
    const state = await STATE_HANDLERS.page.capture({ readArgs, ctx, step });
    if (!state) {
      return {
        key: entry.saveAs, stepId: step.id, kind: "page", state: null, captureFailed: true,
        protected: false, readTool, readArgs, stepTool: step.tool, stepArgs: step.args as Record<string, unknown>
      };
    }
    return {
      key: entry.saveAs,
      stepId: step.id,
      state,
      protected: false,
      readTool,
      readArgs,
      stepTool: step.tool,
      stepArgs: step.args as Record<string, unknown>
    };
  }

  try {
    const result = await ctx.dispatch(readTool, args);
    const element = (result as { element?: ElementLike }).element;
    if (!element) return undefined;
    if (element.isPassword || element.valueProtected) {
      return { key: entry.saveAs, stepId: step?.id, state: { kind: "value", value: "" }, protected: true, readTool, readArgs };
    }

    const kind = step ? captureKindForAction(step.args?.action as string | undefined) : "auto";
    let state: CapturedState | undefined;
    if (kind === "auto") {
      // auto: prefer the most specific state the control exposes.
      const autoOrder: CapturedState["kind"][] = ["toggle", "range", "expanded", "value"];
      for (const k of autoOrder) {
        const candidate = await STATE_HANDLERS[k].capture({ element, readArgs, ctx, step });
        if (candidate) {
          state = candidate;
          break;
        }
      }
    } else {
      state = await STATE_HANDLERS[kind].capture({ element, readArgs, ctx, step });
    }
    if (!state) {
      return {
        key: entry.saveAs, stepId: step?.id, kind: kind === "auto" ? undefined : kind,
        state: null, captureFailed: true, protected: false, readTool, readArgs,
        ...(step ? { stepTool: step.tool, stepArgs: step.args as Record<string, unknown> } : {})
      };
    }
    return {
      key: entry.saveAs,
      stepId: step?.id,
      state,
      protected: false,
      readTool,
      readArgs,
      ...(step ? { stepTool: step.tool, stepArgs: step.args as Record<string, unknown> } : {})
    };
  } catch {
    return undefined;
  }
}

export type RestoreResult = {
  key: string;
  stepId?: string;
  kind: string;
  attempted: boolean;
  success: boolean;
  verified: boolean;
  // RESTORE_STATE_UNAVAILABLE | RESTORE_VERIFICATION_FAILED |
  // RESTORE_SENSITIVE_STATE_BLOCKED
  code?: string;
  method?: string;
  expected?: unknown;
  actual?: unknown;
  message?: string;
  valueCaptured?: boolean;
  // True when the entry was skipped because the pipeline deadline was
  // exceeded (never attempted). Skipped entries stay restorable: a
  // continuation re-attempts them with its fresh deadline.
  skipped?: boolean;
  // Interaction report of the restore action (for pipeline-level
  // aggregation).
  interaction?: unknown;
};

async function runRestore(
  input: PipelineInput,
  success: boolean,
  captured: Map<string, CapturedValue>,
  ctx: ExecutionContext,
  byId: Map<string, unknown>,
  byIndex: unknown[],
  deadline: number,
  skipKeys?: Set<string>
): Promise<RestoreResult[]> {
  const mode = input.restore ?? "never";
  if (mode === "never" || (mode === "onFailure" && success)) return [];
  const results: RestoreResult[] = [];
  for (const entry of captured.values()) {
    const entryKind = entry.state?.kind ?? entry.kind ?? "unknown";
    if (skipKeys?.has(entry.key)) continue;
    if (Date.now() > deadline) {
      results.push({ key: entry.key, stepId: entry.stepId, kind: entryKind, attempted: false, success: false, verified: false, skipped: true, message: "Restore skipped: pipeline time budget exceeded.", valueCaptured: !entry.protected });
      continue;
    }
    if (entry.captureFailed || entry.state === null) {
      results.push({
        key: entry.key, stepId: entry.stepId, kind: entryKind, attempted: false, success: false, verified: false,
        code: "RESTORE_STATE_UNAVAILABLE",
        message: `The original ${entryKind} state could not be reliably determined before the action; no restore was attempted and no guess was made (RESTORE_STATE_UNAVAILABLE).`,
        valueCaptured: false
      });
      continue;
    }
    if (entry.protected) {
      results.push({
        key: entry.key, stepId: entry.stepId, kind: entryKind, attempted: false, success: false, verified: false,
        code: "RESTORE_SENSITIVE_STATE_BLOCKED",
        message: "State not captured (password-protected); capture, restore, export and error echo are blocked.",
        valueCaptured: false
      });
      continue;
    }
    const outcome = await restoreOne(entry, ctx);
    results.push(outcome);
  }
  return results;
}

// Restore one captured state with the matching reverse action, then VERIFY by
// re-reading the control.
async function restoreOne(entry: CapturedValue, ctx: ExecutionContext): Promise<RestoreResult> {
  // Capture-failed entries never reach restoreOne (runRestore reports
  // RESTORE_STATE_UNAVAILABLE), but stay safe against null state anyway.
  if (entry.state === null) {
    return {
      key: entry.key, stepId: entry.stepId, kind: entry.kind ?? "unknown",
      attempted: false, success: false, verified: false, code: "RESTORE_STATE_UNAVAILABLE",
      message: "The original state could not be determined; no restore was attempted (RESTORE_STATE_UNAVAILABLE).",
      valueCaptured: false
    };
  }
  const base: RestoreResult = {
    key: entry.key, stepId: entry.stepId, kind: entry.state.kind,
    attempted: true, success: false, verified: false, valueCaptured: true
  };
  try {
    // Selection restore is multi-stage (spec 4.3): try the captured NAME
    // first; when that fails, fall back to the ORIGINAL captured index.
    if (entry.state.kind === "selection") {
      return await restoreSelection(entry, ctx, base);
    }

    const handler = STATE_HANDLERS[entry.state.kind];
    const restorePlan = handler.restoreAction(entry);
    if (restorePlan.action === null) {
      return {
        ...base,
        code: "RESTORE_STATE_UNAVAILABLE",
        message: `No restore action available for state kind '${entry.state.kind}' (the original state could not be reliably restored).`
      };
    }
    const restoredValue = await ctx.dispatch(restorePlan.restoreArgs.tool, restorePlan.restoreArgs.args);
    const interaction = interactionOf(restoredValue);
    // Verify by re-reading the control - never a self-fulfilling check.
    const verified = await handler.verify(entry, ctx);
    return {
      ...base,
      success: verified.ok,
      verified: verified.ok,
      method: restorePlan.action,
      expected: verified.expected,
      actual: verified.actual,
      ...(interaction ? { interaction } : {}),
      ...(verified.ok ? {} : { code: "RESTORE_VERIFICATION_FAILED" }),
      message: verified.ok ? undefined : `Restore did not verify: expected ${verified.expected}, read ${verified.actual} (RESTORE_VERIFICATION_FAILED).`
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "RESTORE_SENSITIVE_STATE_BLOCKED") {
      return { ...base, code: "RESTORE_SENSITIVE_STATE_BLOCKED", success: false, message: "Password-protected state is never captured or restored (RESTORE_SENSITIVE_STATE_BLOCKED).", valueCaptured: false };
    }
    return { ...base, message: `Restore failed: ${code ?? ""} ${message}`.trim() };
  }
}

// Multi-stage selection restore: name first, then the ORIGINAL index.
async function restoreSelection(entry: CapturedValue, ctx: ExecutionContext, base: RestoreResult): Promise<RestoreResult> {
  const s = entry.state as { kind: "selection"; name?: string; index?: number };
  const handler = STATE_HANDLERS.selection;

  // Stage 1: reliable name -> selectByName -> verify the name.
  if (s.name !== undefined) {
    const plan = actionForTarget(entry, "selectByName", { value: s.name });
    if (plan.action !== null) {
      try {
        const restoredValue = await ctx.dispatch(plan.restoreArgs.tool, plan.restoreArgs.args);
        const interaction = interactionOf(restoredValue);
        const v = await handler.verify(entry, ctx);
        if (v.ok) {
          return { ...base, success: true, verified: true, method: "selectByName", expected: v.expected, actual: v.actual, ...(interaction ? { interaction } : {}) };
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "RESTORE_SENSITIVE_STATE_BLOCKED") throw error;
      }
      // name stage failed -> fall through to the original index.
    }
  }

  // Stage 2: reliable ORIGINAL index -> selectByIndex(originalIndex).
  if (s.index !== undefined) {
    const plan = actionForTarget(entry, "selectByIndex", { index: s.index });
    if (plan.action !== null) {
      try {
        const restoredValue = await ctx.dispatch(plan.restoreArgs.tool, plan.restoreArgs.args);
        const interaction = interactionOf(restoredValue);
        const v = await handler.verify(entry, ctx);
        if (v.ok) {
          return { ...base, success: true, verified: true, method: "selectByIndex", expected: v.expected, actual: v.actual, ...(interaction ? { interaction } : {}) };
        }
        return {
          ...base, code: "RESTORE_VERIFICATION_FAILED", method: "selectByIndex", verified: false,
          expected: v.expected, actual: v.actual,
          ...(interaction ? { interaction } : {}),
          message: `Restore did not verify: expected ${v.expected}, read ${v.actual} (RESTORE_VERIFICATION_FAILED).`
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "RESTORE_SENSITIVE_STATE_BLOCKED") throw error;
        return { ...base, code: "RESTORE_VERIFICATION_FAILED", message: `Index restore failed: ${error instanceof Error ? error.message : String(error)} (RESTORE_VERIFICATION_FAILED).` };
      }
    }
  }

  return {
    ...base,
    code: "RESTORE_STATE_UNAVAILABLE",
    message: "No reliable original name or index was captured for selection restore; no guess was made (RESTORE_STATE_UNAVAILABLE)."
  };
}

export async function runPipeline(input: PipelineInput, ctx: ExecutionContext): Promise<PipelineResult> {
  const runId = createRunId();
  const maxTotalMs = input.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const deadline = Date.now() + maxTotalMs;
  const warnings: string[] = [];
  const exports: Record<string, unknown> = {};
  // Per-step exported values (used by the minimal run snapshot).
  const stepExportValues: Array<Record<string, unknown>> = [];
  const byId = new Map<string, unknown>();
  const byIndex: unknown[] = [];
  const stepResults: StepExecutionResult[] = [];
  const captured = new Map<string, CapturedValue>();
  const completedIds: string[] = [];

  // The pipeline's resolved interaction context, injected into every
  // interaction-aware step (profile_launch / profile_action / capture_window /
  // launch_app / type_text / send_key / ui_action) BEFORE the step executes.
  // A step's own explicit interactionMode/foregroundDemo args always win;
  // everything else inherits the pipeline context, so a foregroundDemo run
  // never falls back to the pack's background default mid-pipeline.
  const storedInteraction = storedInteractionContext(ctx);
  const steps = input.steps.map((s) => prepareStepForInteraction(s, storedInteraction));
  const finallySteps = (input.finally ?? []).map((s) => prepareStepForInteraction(s, storedInteraction));
  const effectiveInput: PipelineInput = { ...input, steps, finally: finallySteps };

  // Pipeline-level foreground snapshot: prefer the pre-launch value captured
  // by the outer profile_launch (profile_run_steps), else read the real
  // foreground NOW, before any step runs.
  const foregroundBefore = ctx.interaction?.foregroundBefore ?? await readPipelineForeground(ctx);

  // Structural pre-check before any step runs.
  const refCheck = validateReferences(effectiveInput.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args ?? {} })), { pack: ctx.pack ? { id: ctx.pack.id } : undefined, inputs: ctx.inputs });
  if (!refCheck.ok) {
    return pipelineFailure(runId, effectiveInput, stepResults, exports, 0, undefined, { code: "INVALID_REFERENCES", message: refCheck.message }, [], warnings, undefined);
  }

  // Background preflight: a pipeline that contains foregroundRequired steps
  // (or global keyboard input) is refused BEFORE any step runs - never a
  // mid-run foreground steal. Covers BOTH the main steps and the finally
  // steps. bestEffort steps are allowed and surface their own failures.
  const backgroundPreflight = backgroundUnsafePipelineSteps(
    effectiveInput.steps,
    effectiveInput.finally ?? [],
    (profileId) => ctx.resolvePackActions?.(profileId),
    ctx.pack?.actions
  );
  if (ctx.interactionMode === "background" && backgroundPreflight.length > 0) {
    const err = pipelineNotBackgroundSafeError("background", backgroundPreflight);
    return pipelineFailure(
      runId, effectiveInput, stepResults, exports, 0, undefined,
      { code: "PIPELINE_NOT_BACKGROUND_SAFE", message: err.message, details: err.details },
      [], warnings, undefined,
      pipelineInteractionReport("background", {
        ...(foregroundBefore ? { foregroundBefore } : {}),
        foregroundChanged: false,
        targetActivated: false
      })
    );
  }

  let stoppedAtIndex: number | null = null;
  let stopError: { code?: string; message: string; details?: unknown } | undefined;

  // Pipeline-level captureBefore: read values before the main steps. Failed
  // captures are recorded too (restore reports RESTORE_STATE_UNAVAILABLE).
  for (const entry of effectiveInput.captureBefore ?? []) {
    const capturedValue = await captureValue(entry, ctx, byId, byIndex);
    captured.set(entry.saveAs, capturedValue ?? { key: entry.saveAs, state: null, kind: "value", captureFailed: true, protected: false, readTool: "ui_get", readArgs: {} });
  }

  const pipeCtx: PipeContext = {
    byId,
    byIndex,
    pack: ctx.pack ? { id: ctx.pack.id } : undefined,
    inputs: ctx.inputs
  };

  for (let i = 0; i < effectiveInput.steps.length; i++) {
    if (Date.now() > deadline) {
      stoppedAtIndex = i;
      stopError = { code: "PIPELINE_TIMEOUT", message: `Pipeline exceeded the total time budget of ${maxTotalMs}ms at step ${i}.` };
      break;
    }
    const step = effectiveInput.steps[i]!;

    // Step-level captureBefore: read the control's state before acting.
    // Failed captures are recorded too (RESTORE_STATE_UNAVAILABLE).
    if (step.captureBefore?.saveAs) {
      const capturedValue = await captureValue(step.captureBefore, ctx, byId, byIndex, step);
      if (capturedValue) {
        captured.set(step.captureBefore.saveAs, capturedValue);
      } else {
        const intendedKind = captureKindForAction(step.args?.action as string | undefined);
        captured.set(step.captureBefore.saveAs, {
          key: step.captureBefore.saveAs, stepId: step.id,
          kind: intendedKind === "auto" ? undefined : intendedKind,
          state: null, captureFailed: true, protected: false, readTool: "ui_get", readArgs: {},
          stepTool: step.tool, stepArgs: step.args as Record<string, unknown>
        });
      }
    }

    const exec = await executeStep(step, i, ctx, pipeCtx, deadline, captured, warnings);
    stepResults.push(exec);
    if (exec.success) {
      byIndex.push(exec.result);
      if (step.id) {
        byId.set(step.id, exec.result);
        completedIds.push(step.id);
      }
      // foregroundDemo: let the UI settle between steps (the caller asked for
      // a visible, stable demo).
      const stepDelayMs = ctx.interactionMode === "foregroundDemo" ? (ctx.interaction?.stepDelayMs ?? 0) : 0;
      if (stepDelayMs > 0 && Date.now() + stepDelayMs <= deadline) {
        await sleep(stepDelayMs);
      }
      // Validate exports.
      const exportOutcome = applyExports(step, exec.result!, exports);
      stepExportValues.push(exportOutcome.values);
      for (const err of exportOutcome.errors) {
        stepResults.push({ tool: step.tool, success: false, error: err });
        stoppedAtIndex = i;
        stopError = err;
        break;
      }
      if (stoppedAtIndex !== null) break;
      // Enforce result size limits.
      if (estimateJsonBytes(exec.result) > MAX_STEP_RESULT_BYTES) {
        stoppedAtIndex = i;
        stopError = { code: "STEP_RESULT_TOO_LARGE", message: `Step '${step.id ?? i}' result exceeds ${MAX_STEP_RESULT_BYTES} bytes.` };
        break;
      }
    } else {
      stoppedAtIndex = i;
      stopError = exec.error;
      break;
    }
  }

  const success = stoppedAtIndex === null;
  const restoreResults = await runRestore(effectiveInput, success, captured, ctx, byId, byIndex, deadline);
  const ranFinallyIds: string[] = [];
  const finallyResults = await runFinally(effectiveInput, ctx, pipeCtx, exports, deadline, warnings, undefined, ranFinallyIds);

  // Pipeline-level interaction report: re-read the real foreground AFTER
  // steps + restore + finally all finished, and aggregate what the steps
  // themselves observed. foregroundChanged = final before/after difference;
  // foregroundChangedDuringRun = any change during the run (even when
  // restored); foregroundRestored = the final read equals the start.
  const interaction = await finalizePipelineInteraction(ctx, stepResults, finallyResults, restoreResults, foregroundBefore, warnings);

  // Persist a MINIMAL continuable snapshot: per completed step only the
  // fields later steps reference + pipe-safe fields + that step's exports
  // (pipeProjection). Oversized snapshots are marked not-continuable, never
  // silently presented as resumable.
  const futureRefs = collectFutureReferences(effectiveInput);
  const stepSnapshots: StepSnapshot[] = [];
  for (let i = 0; i < effectiveInput.steps.length; i++) {
    const exec = stepResults[i];
    if (!exec) break; // steps after the stop point never ran
    const step = effectiveInput.steps[i]!;
    const contract = getContract(step.tool);
    stepSnapshots.push({
      id: step.id,
      index: i,
      tool: step.tool,
      pipeProjection: exec.success && contract
        ? buildPipeProjection(i, step.id, exec.result, futureRefs, step.exports ?? {}, contract)
        : null,
      exports: stepExportValues[i] ?? {},
      success: exec.success,
      error: exec.error
    });
  }
  const snapshot: RunSnapshot = {
    runId,
    kind: "run_steps",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    input: effectiveInput as unknown,
    packId: ctx.pack?.id,
    packVersion: ctx.pack?.version,
    pid: ctx.autoContext?.pid,
    hwnd: ctx.autoContext?.hwnd,
    title: ctx.autoContext?.title,
    profile: ctx.autoContext?.profile,
    steps: stepSnapshots,
    exports,
    stoppedAtStep: stoppedAtIndex ?? effectiveInput.steps.length,
    error: stopError,
    inputs: ctx.inputs,
    maxSteps: effectiveInput.steps.length,
    totalTimeoutMs: maxTotalMs,
    // Save the RESOLVED interaction context so continue_run reuses it instead
    // of re-deriving the mode from current pack defaults.
    interaction: storedInteraction,
    // Cleanup lifecycle bookkeeping for continue_run: which finally steps /
    // restore keys already executed in the original run. A continuation never
    // runs cleanup twice (already-done finally steps are reported as
    // alreadyRan). The ORIGINAL captured state is stored so the continuation
    // can replay the restore with the same snapshot and re-verify.
    finallyRan: ranFinallyIds,
    capturedState: [...captured.values()].map((c) => ({
      key: c.key,
      ...(c.stepId ? { stepId: c.stepId } : {}),
      state: c.state,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.captureFailed ? { captureFailed: true } : {}),
      protected: c.protected,
      readTool: c.readTool,
      readArgs: c.readArgs,
      ...(c.stepTool ? { stepTool: c.stepTool } : {}),
      ...(c.stepArgs ? { stepArgs: c.stepArgs } : {})
    })),
    continuable: false,
    continuationReason: null
  };
  const saved = saveRun(snapshot);

  return {
    schemaVersion: 1,
    success,
    runId,
    status: success ? "completed" : "failed",
    total: effectiveInput.steps.length,
    completed: success ? effectiveInput.steps.length : (stoppedAtIndex ?? effectiveInput.steps.length),
    stoppedAtIndex,
    ...(stoppedAtIndex !== null && effectiveInput.steps[stoppedAtIndex] !== undefined && effectiveInput.steps[stoppedAtIndex]!.id ? { stoppedAt: effectiveInput.steps[stoppedAtIndex]!.id } : {}),
    completedSteps: completedIds,
    steps: stepResults,
    exports,
    ...(stopError ? { error: stopError } : {}),
    finallyResults,
    restoreResults,
    warnings,
    ...(interaction ? { interaction } : {}),
    continuable: saved.continuable,
    continuationReason: saved.continuationReason
  };
}

// The RESOLVED interaction context of a run, stored in its snapshot for
// continue_run inheritance. Always stored (mode defaults to auto) so a
// continuation never guesses from current pack defaults.
function storedInteractionContext(ctx: ExecutionContext): StoredInteractionContext {
  const mode: InteractionMode = ctx.interactionMode ?? "auto";
  return {
    requestedMode: mode,
    effectiveMode: mode,
    ...(mode === "foregroundDemo"
      ? {
          foregroundDemo: {
            restorePreviousForeground: ctx.interaction?.restorePreviousForeground ?? ctx.pack?.profile.interaction?.restorePreviousForeground ?? true,
            ...(ctx.interaction?.stepDelayMs !== undefined ? { stepDelayMs: ctx.interaction.stepDelayMs } : {})
          }
        }
      : {}),
    allowForegroundFallback: ctx.pack?.profile.interaction?.allowForegroundFallback ?? false,
    ...(ctx.pack?.profile.interaction?.backgroundPresentation ? { backgroundPresentation: ctx.pack.profile.interaction.backgroundPresentation } : {})
  };
}

// Read the current foreground hwnd (best-effort; undefined when unavailable).
async function readPipelineForeground(ctx: ExecutionContext): Promise<string | undefined> {
  if (!ctx.getForeground) return undefined;
  try {
    return await ctx.getForeground();
  } catch {
    return undefined;
  }
}

// Final pipeline-level interaction report. Order:
//   1. foregroundDemo cleanup (restore the previous foreground window) - the
//      default restorePreviousForeground=true behavior;
//   2. re-read the real foreground AFTER everything finished;
//   3. aggregate what the steps / finally / restore actions themselves
//      observed (foregroundChangedDuringRun, targetActivated,
//      physicalCursorMoved);
//   4. background mode: an un-restored foreground is reported honestly
//      (foregroundChanged:true / foregroundRestored:false + warning), never
//      hidden, and never fails already-completed business steps.
async function finalizePipelineInteraction(
  ctx: ExecutionContext,
  stepResults: StepExecutionResult[],
  finallyResults: StepExecutionResult[],
  restoreResults: Array<{ interaction?: unknown }>,
  foregroundBefore: string | undefined,
  warnings: string[]
): Promise<InteractionReport> {
  const mode = ctx.interactionMode ?? "auto";

  // foregroundDemo cleanup: restore the previous foreground window the launch
  // saved (default restorePreviousForeground=true). Best-effort and honest:
  // a failed restore is reported in the interaction metadata, never hidden.
  if (mode === "foregroundDemo") {
    const restorePrevious = ctx.interaction?.restorePreviousForeground ?? true;
    const demoBefore = foregroundBefore ?? ctx.interaction?.foregroundBefore ?? firstStepForegroundBefore(stepResults);
    if (restorePrevious && demoBefore && ctx.restoreForeground) {
      try {
        const restored = await ctx.restoreForeground(demoBefore);
        if (!restored.restored) {
          warnings.push("foregroundDemo: the previous foreground window could not be restored.");
        }
      } catch {
        warnings.push("foregroundDemo: restoring the previous foreground window failed.");
      }
    }
  }

  // The final truth is the re-read hwnd, not child-step booleans.
  const foregroundAfter = await readPipelineForeground(ctx);
  const foregroundKnown = foregroundBefore !== undefined && foregroundAfter !== undefined;
  const foregroundChanged = foregroundKnown && foregroundBefore !== foregroundAfter;
  const foregroundRestored = foregroundKnown && foregroundBefore === foregroundAfter;

  const aggregate = aggregateInteractions([
    ...stepResults.map((s) => interactionOf(s.result)),
    ...finallyResults.map((s) => interactionOf(s.result)),
    // RestoreResult carries the captured interaction directly; interactionOf
    // extracts the `interaction` field from the containing object.
    ...restoreResults.map((r) => interactionOf(r))
  ]);

  if (mode === "background" && foregroundChanged) {
    warnings.push(
      `BACKGROUND_FOREGROUND_NOT_RESTORED: The pipeline ended with a different foreground window than it started with (foregroundBefore=${foregroundBefore ?? "?"}, foregroundAfter=${foregroundAfter ?? "?"}).`
    );
  }

  return pipelineInteractionReport(mode, {
    ...(foregroundBefore ? { foregroundBefore } : {}),
    ...(foregroundAfter ? { foregroundAfter } : {}),
    foregroundChanged,
    ...(aggregate.foregroundChangedDuringRun ? { foregroundChangedDuringRun: true } : {}),
    ...(foregroundKnown ? { foregroundRestored } : {}),
    targetActivated: aggregate.targetActivated,
    ...(aggregate.physicalCursorMoved ? { physicalCursorMoved: true } : {})
  });
}

// The previous foreground window saved by the first launch step of a
// foregroundDemo pipeline (used when the pipeline itself had no outer launch).
function firstStepForegroundBefore(stepResults: StepExecutionResult[]): string | undefined {
  for (const exec of stepResults) {
    if (!exec.success) continue;
    const r = exec.result as { interaction?: InteractionReport } | undefined;
    if (r?.interaction?.foregroundBefore) return r.interaction.foregroundBefore;
  }
  return undefined;
}

function pipelineFailure(
  runId: string,
  input: PipelineInput,
  stepResults: StepExecutionResult[],
  exports: Record<string, unknown>,
  stoppedAtIndex: number | null,
  stoppedAt: string | undefined,
  error: { code?: string; message: string; details?: unknown },
  finallyResults: StepExecutionResult[],
  warnings: string[],
  restoreResults: Array<{ key: string; success: boolean; message?: string; valueCaptured?: boolean }> | undefined,
  interaction?: InteractionReport
): PipelineResult {
  return {
    schemaVersion: 1,
    success: false,
    runId,
    status: "failed",
    total: input.steps.length,
    completed: 0,
    stoppedAtIndex,
    ...(stoppedAt ? { stoppedAt } : {}),
    completedSteps: [],
    steps: stepResults,
    exports,
    error,
    finallyResults,
    restoreResults: restoreResults ?? [],
    warnings,
    ...(interaction ? { interaction } : {}),
    continuable: false,
    continuationReason: null
  };
}

// ── Minimal continuable snapshots ──
//
// Before execution we statically collect every placeholder reference in step
// args, expects, finally steps and capture/restore reads. After a step
// completes we keep ONLY:
//   - the fields future steps reference from this step,
//   - this step's exported fields,
//   - the tool contract's pipe-safe top-level fields,
//   - cheap context objects (small arrays/objects).
// The full raw result is never stored in the run snapshot.

function collectFutureReferences(input: PipelineInput): Map<string, string[][]> {
  const refs = new Map<string, string[][]>();
  const add = (value: unknown): void => {
    for (const r of extractReferenceHeads(value)) {
      const list = refs.get(r.head) ?? [];
      if (!list.some((p) => p.join(".") === r.tail.join("."))) list.push(r.tail);
      refs.set(r.head, list);
    }
  };
  for (const step of input.steps) {
    add(step.args);
    if (step.expect) add(step.expect);
    if (step.captureBefore?.read?.args) add(step.captureBefore.read.args);
  }
  for (const f of input.finally ?? []) {
    add(f.args);
    if (f.expect) add(f.expect);
    if (f.captureBefore?.read?.args) add(f.captureBefore.read.args);
  }
  for (const c of input.captureBefore ?? []) add(c.read?.args);
  return refs;
}

function buildPipeProjection(
  stepIndex: number,
  stepId: string | undefined,
  result: unknown,
  futureRefs: Map<string, string[][]>,
  exportPaths: Record<string, string>,
  contract: ToolContract
): unknown {
  const required: string[][] = [];
  // 1. This step's exported paths.
  for (const path of Object.values(exportPaths)) {
    required.push(path.split(".").filter((s) => s !== "$" && s !== ""));
  }
  // 2. Future references targeting this step (by index and by id).
  const heads = [String(stepIndex), ...(stepId ? [stepId] : [])];
  for (const head of heads) {
    for (const tail of futureRefs.get(head) ?? []) required.push(tail);
  }
  // 3. Contract pipe-safe top-level fields are kept when cheap (bounded).
  return pickPaths(result, required, contract.pipeSafeFields);
}

// Oversized pipe-safe fields (e.g. a full ui_inspect_tree node array) are
// NOT projected unless explicitly referenced - the snapshot must stay small
// enough to be honestly resumable.
const PIPE_SAFE_PROJECTION_MAX_BYTES = 64 * 1024;

// Keep only the top-level subtrees touched by the required paths (plus cheap
// context objects and cheap pipe-safe fields). Index references keep the
// whole array (indices are data-dependent and cannot be sliced statically).
function pickPaths(value: unknown, paths: string[][], pipeSafeFields: string[] = []): unknown {
  if (value === null || typeof value !== "object") return value;
  const top = new Set<string>();
  let anyIndex = false;
  for (const p of paths) {
    if (p.length === 0) continue;
    if (/^\d+$/.test(p[0]!)) anyIndex = true;
    else top.add(p[0]!);
  }
  if (Array.isArray(value)) return anyIndex ? value : [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (top.has(k)) {
      out[k] = v;
    } else if (pipeSafeFields.includes(k) && v !== null && typeof v === "object" && estimateJsonBytes(v) <= PIPE_SAFE_PROJECTION_MAX_BYTES) {
      out[k] = v;
    } else if (v !== null && typeof v === "object" && estimateJsonBytes(v) <= 4096) {
      // Cheap context objects are preserved (bounded, harmless).
      out[k] = v;
    }
  }
  return out;
}

// Execute one step with expect + retry semantics.
async function executeStep(
  step: PipelineStepInput,
  index: number,
  ctx: ExecutionContext,
  pipeCtx: PipeContext,
  deadline: number,
  captured: Map<string, CapturedValue>,
  warnings: string[]
): Promise<StepExecutionResult> {
  const contract = getContract(step.tool);
  if (!contract) {
    return { tool: step.tool, success: false, error: { code: "UNKNOWN_TOOL", message: `Tool '${step.tool}' is not an MCP tool of this server.` } };
  }

  const attempts = Math.min(step.retry?.maxAttempts ?? 1, MAX_RETRY_ATTEMPTS);
  const delayMs = step.retry?.delayMs ?? 200;
  const backoff = step.retry?.backoffMultiplier ?? 1.5;
  const onlyCodes = step.retry?.onlyCodes;

  let lastError: { code?: string; message: string; details?: unknown } | undefined;
  let lastExpect: ExpectResult | null = null;
  let expectApplied = false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (Date.now() > deadline) {
      return { tool: step.tool, success: false, error: { code: "PIPELINE_TIMEOUT", message: "Pipeline time budget exceeded." } };
    }

    // Resolve args against the pipe context.
    const resolution = resolvePlaceholdersEx(step.args ?? {}, pipeCtx);
    if (!resolution.ok) {
      return { tool: step.tool, success: false, error: { code: "REFERENCE_RESOLUTION_FAILED", message: resolution.reason } };
    }

    let result: unknown;
    try {
      result = await ctx.dispatch(step.tool, resolution.value);
    } catch (error) {
      lastError = normalizeStepError(error);
      // ignoreCodes on a step (typically a finally step or an idempotent
      // close/cleanup step) tolerates listed codes: reported as skipped.
      if (lastError.code && step.ignoreCodes?.includes(lastError.code)) {
        warnings.push(`Step '${step.id ?? index}' ignored error ${lastError.code} (ignoreCodes).`);
        return { tool: step.tool, success: true, result: { skipped: true, ignoredCode: lastError.code } };
      }
      if (shouldRetry(lastError.code, onlyCodes, step, ctx)) {
        await sleep(delayMs * Math.pow(backoff, attempt));
        continue;
      }
      return { tool: step.tool, success: false, error: lastError };
    }

    // NOTE: output schema validation happens ONCE in the unified executor
    // (src/executor.ts) for every tool call, including pipeline steps - a
    // result that failed validation never reaches this point.

    // Expect: explicit > pack defaultExpect > none.
    let expect: PackDefaultExpect | false | undefined = step.expect;
    let expectFrom = "explicit";
    if (expect === undefined) {
      const fromPack = packDefaultExpectFor(ctx, step);
      if (fromPack) {
        expect = fromPack;
        expectFrom = "pack-default";
      }
    }
    if (expect === false) {
      if (expectFrom === "explicit") {
        warnings.push(`Step '${step.id ?? index}' disabled its postcondition (expect:false).`);
      }
      expectApplied = true;
      return { tool: step.tool, success: true, result, stateSettled: false };
    }
    if (expect) {
      const expectResult = await evaluateExpect(ctx.expectDeps, {
        ...expect,
        profile: ctx.pack?.profile,
        hwnd: ctx.autoContext?.hwnd,
        pid: ctx.autoContext?.pid,
        includeProcessPopups: true
      });
      lastExpect = expectResult;
      expectApplied = true;
      if (!expectResult.matched) {
        lastError = {
          code: "STEP_POSTCONDITION_TIMEOUT",
          message: `Step '${step.id ?? index}' (${step.tool}) ran but the postcondition did not match within ${expectResult.timeoutMs}ms: condition '${expectResult.condition}'${expectFrom === "pack-default" ? " (pack defaultExpect)" : ""}.`,
          details: { condition: expectResult.condition, timedOut: true, lastObservation: redactObservation(expectResult.lastObservation) }
        };
        if (shouldRetry(lastError.code, onlyCodes, step, ctx)) {
          await sleep(delayMs * Math.pow(backoff, attempt));
          continue;
        }
        return { tool: step.tool, success: false, error: lastError, expectResult };
      }
    }

    return {
      tool: step.tool,
      success: true,
      result,
      expectResult: expectApplied ? lastExpect : null,
      stateSettled: expectApplied ? true : false
    };
  }

  // Exhausted attempts.
  return { tool: step.tool, success: false, error: lastError ?? { code: "ACTION_FAILED", message: "All retry attempts failed." }, expectResult: lastExpect };
}

function packDefaultExpectFor(ctx: ExecutionContext, step: PipelineStepInput): PackDefaultExpect | undefined {
  if (!ctx.pack) return undefined;
  const control = step.args?.control as string | undefined;
  const action = step.args?.action as string | undefined;
  if (!control || !action) return undefined;
  const contract = ctx.pack.actions.contracts.find((c) => c.control === control && c.action === action);
  if (contract?.defaultExpect === undefined || contract.defaultExpect === false) return undefined;
  return contract.defaultExpect;
}

function shouldRetry(
  code: string | undefined,
  onlyCodes: string[] | undefined,
  step: PipelineStepInput,
  ctx: ExecutionContext
): boolean {
  if (!code) return false;
  if (onlyCodes) return onlyCodes.includes(code);
  if (NEVER_RETRY.has(code)) return false;
  if (DEFAULT_RETRYABLE.has(code)) return true;
  // Explicit retry config: allow retrying generic codes (ACTION_FAILED etc.)
  // only when the step is idempotent.
  if (step.retry && isStepIdempotent({ pack: ctx.pack ? { id: ctx.pack.id, actions: ctx.pack.actions } : undefined, getContract, parseArgs: undefined }, step)) {
    return true;
  }
  return false;
}

function applyExports(step: PipelineStepInput, result: unknown, exports: Record<string, unknown>): { errors: Array<{ code?: string; message: string; details?: unknown }>; values: Record<string, unknown> } {
  const errors: Array<{ code?: string; message: string; details?: unknown }> = [];
  const values: Record<string, unknown> = {};
  const entries = Object.entries(step.exports ?? {});
  if (entries.length > MAX_EXPORTS_PER_STEP) {
    errors.push({ code: "TOO_MANY_EXPORTS", message: `Step '${step.id ?? ""}' declares ${entries.length} exports; the limit is ${MAX_EXPORTS_PER_STEP}.` });
    return { errors, values };
  }
  for (const [name, path] of entries) {
    if (isSensitiveFieldName(name.split("."))) {
      errors.push({ code: "EXPORT_SENSITIVE_VALUE_BLOCKED", message: `Export '${name}' matches a sensitive field name; not exported.` });
      continue;
    }
    if (path.length > 256) {
      errors.push({ code: "EXPORT_PATH_TOO_LONG", message: `Export '${name}' path exceeds 256 characters.` });
      continue;
    }
    const segments = path.split(".");
    if (segments.length > MAX_REF_DEPTH) {
      errors.push({ code: "EXPORT_PATH_TOO_DEEP", message: `Export '${name}' path exceeds depth ${MAX_REF_DEPTH}.` });
      continue;
    }
    const resolved = resolveExportPath(result, segments);
    if (!resolved.ok) {
      errors.push({ code: "EXPORT_PATH_NOT_FOUND", message: `Export '${name}' path '${path}' could not be resolved: ${resolved.reason}` });
      continue;
    }
    const value = resolved.value;
    if (value === null || value === undefined) {
      errors.push({ code: "EXPORT_VALUE_NULL", message: `Export '${name}' path '${path}' resolved to null/undefined.` });
      continue;
    }
    if (typeof value === "string" && value.length > 64 * 1024) {
      errors.push({ code: "EXPORT_VALUE_TOO_LARGE", message: `Export '${name}' string exceeds 64 KiB.` });
      continue;
    }
    exports[name] = value;
    values[name] = value;
  }
  return { errors, values };
}

function resolveExportPath(result: unknown, segments: string[]): { ok: true; value: unknown } | { ok: false; reason: string } {
  let current = result;
  // "$" or "" as the first segment denotes the absolute root.
  const start = segments[0] === "$" || segments[0] === "" ? 1 : 0;
  for (let i = start; i < segments.length; i++) {
    const seg = segments[i]!;
    if (current === null || current === undefined) {
      return { ok: false, reason: `null/undefined at '${segments.slice(0, i).join(".")}'` };
    }
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return { ok: false, reason: `array index '${seg}' out of range` };
      }
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
      if (current === undefined) {
        return { ok: false, reason: `no field '${seg}'` };
      }
    } else {
      return { ok: false, reason: `cannot index into ${typeof current} at '${segments.slice(0, i).join(".")}'` };
    }
  }
  return { ok: true, value: current };
}

// Read a control's value before an action (for later restore). Password
// fields are never captured (valueProtected).
async function runFinally(
  input: PipelineInput,
  ctx: ExecutionContext,
  pipeCtx: PipeContext,
  exports: Record<string, unknown>,
  deadline: number,
  warnings: string[],
  alreadyRan?: string[],
  ranIds: string[] = []
): Promise<StepExecutionResult[]> {
  const results: StepExecutionResult[] = [];
  for (const step of input.finally ?? []) {
    // Lifecycle dedup: a finally step that ALREADY completed in the original
    // run is never re-executed by a continuation (its result is preserved).
    const stepKey = step.id ?? `${step.tool}:${JSON.stringify(step.args ?? {})}`;
    if (alreadyRan?.includes(stepKey)) {
      results.push({ tool: step.tool, success: true, result: { skipped: true, alreadyRan: true }, skipped: true });
      continue;
    }
    if (Date.now() > deadline) {
      results.push({ tool: step.tool, success: false, error: { code: "PIPELINE_TIMEOUT", message: "Finally skipped: pipeline time budget exceeded." }, skipped: true });
      continue;
    }
    const resolution = resolvePlaceholdersEx(step.args ?? {}, pipeCtx);
    if (!resolution.ok) {
      results.push({ tool: step.tool, success: false, error: { code: "REFERENCE_RESOLUTION_FAILED", message: resolution.reason } });
      continue;
    }
    try {
      // Output validation happens once in the unified executor, same as for
      // main steps.
      const result = await ctx.dispatch(step.tool, resolution.value);
      ranIds.push(stepKey);
      results.push({ tool: step.tool, success: true, result });
    } catch (error) {
      const normalized = normalizeStepError(error);
      const ignoreCodes = step.ignoreCodes ?? [];
      if (normalized.code && ignoreCodes.includes(normalized.code)) {
        warnings.push(`Finally step '${step.id ?? ""}' ignored error ${normalized.code} (ignoreCodes).`);
        ranIds.push(stepKey);
        results.push({ tool: step.tool, success: true, result: { skipped: true, ignoredCode: normalized.code } });
      } else {
        results.push({ tool: step.tool, success: false, error: normalized });
      }
    }
  }
  return results;
}

function normalizeStepError(error: unknown): { code?: string; message: string; details?: unknown } {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown; name?: unknown };
    if (typeof e.code === "string" || typeof e.message === "string" || typeof e.code === "number") {
      return {
        ...(typeof e.code === "string" || typeof e.code === "number" ? { code: String(e.code) } : {}),
        message: typeof e.message === "string" ? e.message : String(error),
        ...(e.details !== undefined ? { details: e.details } : {})
      };
    }
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: String(error) };
}

// Redact password values / runtimeIds from expect observations before
// surfacing them.
function redactObservation(observation: unknown): unknown {
  if (observation === null || typeof observation !== "object") return observation;
  if (Array.isArray(observation)) return observation.map(redactObservation);
  const copy: Record<string, unknown> = { ...(observation as Record<string, unknown>) };
  if ("isPassword" in copy && copy.isPassword === true) copy.value = null;
  if ("runtimeId" in copy) copy.runtimeId = undefined;
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── continue_run ──

export type ContinueOptions = {
  runId: string;
  continueFrom: string | number;
  ctx: ExecutionContext;
  checkProcessAlive?: (pid: number) => Promise<boolean>;
  checkHwndValid?: (hwnd: string) => Promise<boolean>;
  getPackVersion?: (packId: string) => string | undefined;
};

export async function continuePipeline(opts: ContinueOptions): Promise<PipelineResult> {
  const { runId, continueFrom } = opts;
  const { getRun } = await import("./runs.js");
  const snapshot = getRun(runId);
  if (!snapshot) {
    return {
      schemaVersion: 1, success: false, runId, status: "failed", total: 0, completed: 0,
      stoppedAtIndex: null, completedSteps: [], steps: [], exports: {},
      error: { code: "RUN_EXPIRED", message: `Run '${runId}' was not found or has expired (runs are kept in memory for 10 minutes).` },
      finallyResults: [], restoreResults: [], warnings: [],
      continuable: false, continuationReason: null
    };
  }

  // The snapshot must actually be resumable: a truncated snapshot (over the
  // run result budget) is refused explicitly instead of failing later on
  // missing references.
  if (!snapshot.continuable) {
    return fail(runId, "RUN_NOT_CONTINUABLE", `Run '${runId}' is not continuable: its snapshot was truncated beyond what can be honestly resumed (${snapshot.continuationReason ?? "RUN_SNAPSHOT_TRUNCATED"}). Re-run the pipeline from the start.`);
  }

  // Pack version must still match.
  if (snapshot.packId && opts.getPackVersion) {
    const current = opts.getPackVersion(snapshot.packId);
    if (current !== snapshot.packVersion && snapshot.packVersion !== undefined) {
      return fail(runId, "RUN_PACK_VERSION_CHANGED", `Pack '${snapshot.packId}' changed from version '${snapshot.packVersion}' to '${current ?? "unknown"}'; the saved run cannot be continued.`);
    }
  }

  // Process must still be alive. The pid is discovered from the snapshot's
  // own fields, the exports, or any completed step result that carried one.
  const launchExports = snapshot.exports?.launch as { pid?: number; hwnd?: string } | undefined;
  let foundPid = snapshot.pid ?? (typeof launchExports?.pid === "number" ? launchExports.pid : undefined);
  let foundHwnd = snapshot.hwnd ?? (typeof launchExports?.hwnd === "string" ? launchExports.hwnd : undefined);
  for (const r of snapshot.steps) {
    const res = r.pipeProjection as { pid?: number; hwnd?: string | number } | null | undefined;
    if (!res) continue;
    if (foundPid === undefined && typeof res.pid === "number") foundPid = res.pid;
    if (foundHwnd === undefined && (typeof res.hwnd === "string" || typeof res.hwnd === "number")) foundHwnd = String(res.hwnd);
  }
  const pid = foundPid;
  if (pid !== undefined && opts.checkProcessAlive) {
    const alive = await opts.checkProcessAlive(pid);
    if (!alive) {
      return fail(runId, "RUN_PROCESS_EXITED", `Process ${pid} is no longer running; the saved run cannot be continued.`);
    }
  }

  // HWND must still be valid.
  const hwnd = foundHwnd;
  if (hwnd !== undefined && opts.checkHwndValid) {
    const valid = await opts.checkHwndValid(hwnd);
    if (!valid) {
      return fail(runId, "RUN_WINDOW_RECREATED", `Window ${hwnd} is no longer valid; the target window was recreated. Re-run the pipeline from the start.`);
    }
  }

  const input = snapshot.input as PipelineInput;
  if (!input || !Array.isArray(input.steps)) {
    return fail(runId, "RUN_STATE_STALE", "The saved run snapshot is corrupt; cannot continue.");
  }

  // Locate the continuation point.
  let fromIndex: number;
  if (typeof continueFrom === "number") {
    fromIndex = continueFrom;
  } else {
    const idx = input.steps.findIndex((s) => s.id === continueFrom);
    if (idx < 0) {
      return fail(runId, "RUN_STATE_STALE", `Step '${continueFrom}' does not exist in the saved run.`, `Valid steps: ${input.steps.map((s) => s.id ?? `[${input.steps.indexOf(s)}]`).join(", ")}`);
    }
    fromIndex = idx;
  }
  if (fromIndex < 0 || fromIndex >= input.steps.length) {
    return fail(runId, "RUN_STATE_STALE", `Continuation index ${fromIndex} is out of range (0..${input.steps.length - 1}).`);
  }

  // ── Unified continuation lifecycle ──
  //
  // The continuation is ONE run with ONE time budget, computed ONCE here:
  // main steps, expect, retry, restore, finally and foregroundDemo step
  // delays all share this single deadline. No step re-computes
  // Date.now() + totalTimeoutMs.
  const continuationBudgetMs = snapshot.totalTimeoutMs ?? DEFAULT_MAX_TOTAL_MS;
  const deadline = Date.now() + continuationBudgetMs;

  // Background preflight on the REMAINING main steps AND the finally steps
  // (same rule as runPipeline, using the stored interaction mode): a
  // background continuation never resumes into a foregroundRequired step.
  if (opts.ctx.interactionMode === "background") {
    const unsafe = backgroundUnsafePipelineSteps(
      input.steps.slice(fromIndex),
      input.finally ?? [],
      (profileId) => opts.ctx.resolvePackActions?.(profileId),
      opts.ctx.pack?.actions
    );
    if (unsafe.length > 0) {
      const err = pipelineNotBackgroundSafeError("background", unsafe);
      return {
        schemaVersion: 1, success: false, runId, status: "failed", total: input.steps.length, completed: 0,
        stoppedAtIndex: null, completedSteps: [], steps: [], exports: {},
        error: { code: "PIPELINE_NOT_BACKGROUND_SAFE", message: err.message, details: err.details },
        finallyResults: [], restoreResults: [], warnings: [],
        continuable: false, continuationReason: null
      };
    }
  }

  // Pipeline-level foreground snapshot for the continuation segment.
  const foregroundBefore = opts.ctx.interaction?.foregroundBefore ?? await readPipelineForeground(opts.ctx);
  const warnings: string[] = [];

  // The continuation inherits the RESOLVED interaction context of the
  // original run; every interaction-aware remaining step is re-prepared with
  // it (same rule as runPipeline).
  const storedInteraction = storedInteractionContext(opts.ctx);
  const remainingSteps = input.steps.slice(fromIndex).map((s) => prepareStepForInteraction(s, storedInteraction));
  const finallySteps = (input.finally ?? []).map((s) => prepareStepForInteraction(s, storedInteraction));

  // Re-execute from the continuation point, reusing stored results for the
  // completed prefix. The stored results act as the pipe context, so steps
  // before fromIndex are NOT re-run.
  const results: unknown[] = [];
  const byId = new Map<string, unknown>();
  const completedIds: string[] = [];
  for (let i = 0; i < fromIndex; i++) {
    const stored = snapshot.steps[i];
    if (!stored) return fail(runId, "RUN_STATE_STALE", `Missing stored projection for step ${i}; cannot continue.`);
    results.push(stored.pipeProjection);
    if (stored.id) {
      byId.set(stored.id, stored.pipeProjection);
      completedIds.push(stored.id);
    }
  }

  const stepResults: StepExecutionResult[] = [];
  const exports = { ...snapshot.exports };
  // Per-step exported values keyed by GLOBAL step index (the continuation
  // segment starts at fromIndex, so a 0-based array would misalign the
  // snapshot exports for later continues).
  const stepExportsByIndex: Record<number, Record<string, unknown>> = {};
  let stoppedAtIndex: number | null = null;
  let stopError: { code?: string; message: string; details?: unknown } | undefined;

  const pipeCtx: PipeContext = {
    byId,
    byIndex: results,
    pack: opts.ctx.pack ? { id: opts.ctx.pack.id } : undefined,
    inputs: snapshot.inputs
  };

  // Captured state for restore: the ORIGINAL run's captures are replayed
  // verbatim from the snapshot (never re-read - the pre-action state no
  // longer exists). Step-level captures of the CONTINUED steps are added as
  // they run.
  const captured = new Map<string, CapturedValue>();
  for (const c of snapshot.capturedState ?? []) {
    captured.set(c.key, {
      key: c.key,
      ...(c.stepId ? { stepId: c.stepId } : {}),
      state: c.state as CapturedState | null,
      ...(c.kind ? { kind: c.kind as CapturedState["kind"] } : {}),
      ...(c.captureFailed ? { captureFailed: true } : {}),
      protected: c.protected,
      readTool: c.readTool,
      readArgs: c.readArgs,
      ...(c.stepTool ? { stepTool: c.stepTool } : {}),
      ...(c.stepArgs ? { stepArgs: c.stepArgs as Record<string, unknown> } : {})
    });
  }

  for (let i = fromIndex; i < input.steps.length; i++) {
    const step = remainingSteps[i - fromIndex]!;
    if (Date.now() > deadline) {
      stoppedAtIndex = i;
      stopError = { code: "PIPELINE_TIMEOUT", message: `Pipeline exceeded the total time budget of ${continuationBudgetMs}ms at step ${i} (continued run).` };
      break;
    }
    // Step-level captureBefore on continued steps (same rule as runPipeline).
    if (step.captureBefore?.saveAs) {
      const capturedValue = await captureValue(step.captureBefore, opts.ctx, byId, results, step);
      if (capturedValue) {
        captured.set(step.captureBefore.saveAs, capturedValue);
      } else {
        const intendedKind = captureKindForAction(step.args?.action as string | undefined);
        captured.set(step.captureBefore.saveAs, {
          key: step.captureBefore.saveAs, stepId: step.id,
          kind: intendedKind === "auto" ? undefined : intendedKind,
          state: null, captureFailed: true, protected: false, readTool: "ui_get", readArgs: {},
          stepTool: step.tool, stepArgs: step.args as Record<string, unknown>
        });
      }
    }
    const exec = await executeStep(step, i, opts.ctx, pipeCtx, deadline, captured, warnings);
    stepResults.push(exec);
    if (exec.success) {
      results.push(exec.result);
      if (step.id) {
        byId.set(step.id, exec.result);
        completedIds.push(step.id);
      }
      // foregroundDemo: keep the demo pacing on the continued steps too, under
      // the SAME deadline.
      const stepDelayMs = opts.ctx.interactionMode === "foregroundDemo" ? (opts.ctx.interaction?.stepDelayMs ?? 0) : 0;
      if (stepDelayMs > 0 && Date.now() + stepDelayMs <= deadline) {
        await sleep(stepDelayMs);
      }
      const exportOutcome = applyExports(step, exec.result!, exports);
      stepExportsByIndex[i] = exportOutcome.values;
      if (exportOutcome.errors.length > 0) {
        stoppedAtIndex = i;
        stopError = exportOutcome.errors[0]!;
        break;
      }
    } else {
      stoppedAtIndex = i;
      stopError = exec.error;
      break;
    }
  }

  // Restore phase: replay the ORIGINAL captured state (plus continuation
  // captures) and re-verify - never silently skipped. When the snapshot
  // carries no captured state but the input declares captures, the restore
  // reports RESTORE_STATE_UNAVAILABLE instead of pretending success.
  const success = stoppedAtIndex === null;
  let restoreResults: RestoreResult[] = [];
  if (restoreRequired(input.restore, success) && declaredCaptureKeys(input).length > 0) {
    if (captured.size === 0) {
      // The snapshot has no captured state at all (legacy run): the original
      // state cannot be restored - report honestly per declared capture.
      restoreResults = declaredCaptureKeys(input).map((key) => ({
        key,
        kind: "unknown",
        attempted: false,
        success: false,
        verified: false,
        code: "RESTORE_STATE_UNAVAILABLE",
        message: "The original state was not saved in the run snapshot; no restore was attempted (RESTORE_STATE_UNAVAILABLE).",
        valueCaptured: false
      }));
    } else {
      restoreResults = await runRestore(input, success, captured, opts.ctx, byId, results, deadline);
    }
  }

  // Finally phase: runs on continuation success AND failure. Steps that
  // already completed in the original run are reported as alreadyRan (never
  // executed twice); steps the original run never reached run once here.
  const ranFinallyIds: string[] = [...(snapshot.finallyRan ?? [])];
  const finallyResults = await runFinally(input, opts.ctx, pipeCtx, exports, deadline, warnings, snapshot.finallyRan, ranFinallyIds);

  // Save the updated snapshot (with a fresh TTL) so the run can be continued
  // again. Completed prefix steps keep their original projections; newly
  // completed steps are projected the same way as in runPipeline.
  const futureRefs = collectFutureReferences(input);
  const freshSteps: StepSnapshot[] = [];
  for (let i = 0; i < input.steps.length; i++) {
    if (i < fromIndex) {
      const prefix = snapshot.steps[i];
      if (prefix) freshSteps.push(prefix);
      continue;
    }
    const exec = stepResults[i - fromIndex];
    if (!exec) break;
    const step = input.steps[i]!;
    const contract = getContract(step.tool);
    freshSteps.push({
      id: step.id,
      index: i,
      tool: step.tool,
      pipeProjection: exec.success && contract
        ? buildPipeProjection(i, step.id, exec.result, futureRefs, step.exports ?? {}, contract)
        : null,
      exports: stepExportsByIndex[i] ?? {},
      success: exec.success,
      error: exec.error
    });
  }
  const fresh: RunSnapshot = {
    ...snapshot,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    steps: freshSteps,
    exports,
    stoppedAtStep: stoppedAtIndex ?? input.steps.length,
    error: stopError,
    finallyRan: ranFinallyIds,
    capturedState: [...captured.values()].map((c) => ({
      key: c.key,
      ...(c.stepId ? { stepId: c.stepId } : {}),
      state: c.state,
      ...(c.kind ? { kind: c.kind } : {}),
      ...(c.captureFailed ? { captureFailed: true } : {}),
      protected: c.protected,
      readTool: c.readTool,
      readArgs: c.readArgs,
      ...(c.stepTool ? { stepTool: c.stepTool } : {}),
      ...(c.stepArgs ? { stepArgs: c.stepArgs } : {})
    })),
    continuable: false,
    continuationReason: null
  };
  const saved = saveRun(fresh);

  // Pipeline-level interaction report for the continuation segment: re-read
  // the real foreground at the end, aggregate the continued steps AND the
  // completed prefix projections (which carry their interaction reports),
  // plus the restore + finally interactions of this continuation.
  const interaction = await finalizePipelineInteraction(
    opts.ctx,
    stepResults,
    finallyResults,
    restoreResults,
    foregroundBefore,
    warnings
  );
  const prefixInteractions = snapshot.steps
    .slice(0, fromIndex)
    .map((s) => interactionOf(s.pipeProjection))
    .filter((i): i is InteractionReport => i !== undefined);
  if (prefixInteractions.length > 0) {
    const prefixAggregate = aggregateInteractions(prefixInteractions);
    if (prefixAggregate.foregroundChangedDuringRun) interaction.foregroundChangedDuringRun = true;
    if (prefixAggregate.targetActivated) interaction.targetActivated = true;
    if (prefixAggregate.physicalCursorMoved) interaction.physicalCursorMoved = true;
  }

  return {
    schemaVersion: 1,
    success,
    runId,
    status: success ? "completed" : "failed",
    total: input.steps.length,
    completed: success ? input.steps.length : (stoppedAtIndex ?? input.steps.length),
    stoppedAtIndex,
    ...(stoppedAtIndex !== null && input.steps[stoppedAtIndex] !== undefined && input.steps[stoppedAtIndex]!.id ? { stoppedAt: input.steps[stoppedAtIndex]!.id } : {}),
    ...(typeof continueFrom === "number" ? { continuedFrom: String(continueFrom) } : { continuedFrom: continueFrom }),
    completedSteps: completedIds,
    steps: stepResults,
    exports,
    ...(stopError ? { error: stopError } : {}),
    finallyResults,
    restoreResults,
    warnings,
    ...(interaction ? { interaction } : {}),
    continuable: saved.continuable,
    continuationReason: saved.continuationReason
  };
}

// Whether the pipeline's restore mode requires restoring on this outcome.
function restoreRequired(mode: PipelineInput["restore"], success: boolean): boolean {
  return mode === "always" || (mode === "onFailure" && !success);
}

// Every capture key declared by the pipeline (pipeline-level + step-level).
function declaredCaptureKeys(input: PipelineInput): string[] {
  const keys: string[] = [];
  for (const c of input.captureBefore ?? []) keys.push(c.saveAs);
  for (const s of input.steps) {
    if (s.captureBefore?.saveAs) keys.push(s.captureBefore.saveAs);
  }
  for (const f of input.finally ?? []) {
    if (f.captureBefore?.saveAs) keys.push(f.captureBefore.saveAs);
  }
  return keys;
}

function fail(
  runId: string,
  code: string,
  message: string,
  suggestion?: string
): PipelineResult {
  return {
    schemaVersion: 1, success: false, runId, status: "failed", total: 0, completed: 0,
    stoppedAtIndex: null, completedSteps: [], steps: [], exports: {},
    error: { code, message, ...(suggestion ? { details: { suggestion } } : {}) },
    finallyResults: [], restoreResults: [], warnings: [],
    continuable: false,
    continuationReason: null
  };
}

// Re-export for index.ts.
export type { PackWorkflowStep };
