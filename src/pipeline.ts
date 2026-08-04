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
import { evaluateExpect, type ExpectContext, type ExpectResult } from "./expect.js";
import { extractReferenceHeads, resolvePlaceholdersEx, validateReferences, type PipeContext } from "./piping.js";
import { estimateJsonBytes, isSensitiveFieldName, MAX_PIPELINE_RESULT_BYTES, MAX_STEP_RESULT_BYTES, validateAgainstSchema } from "./outputs.js";
import { createRunId, saveRun, type RunSnapshot } from "./runs.js";

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
  inputs?: Record<string, unknown>;
  autoContext?: { profile?: string; pid?: number; hwnd?: string; title?: string };
  expectDeps: ExpectContext;
};

type CapturedValue = { tool: string; args: Record<string, unknown>; value: unknown; protected: boolean };

export async function runPipeline(input: PipelineInput, ctx: ExecutionContext): Promise<PipelineResult> {
  const runId = createRunId();
  const maxTotalMs = input.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const deadline = Date.now() + maxTotalMs;
  const warnings: string[] = [];
  const exports: Record<string, unknown> = {};
  const byId = new Map<string, unknown>();
  const byIndex: unknown[] = [];
  const stepResults: StepExecutionResult[] = [];
  const captured = new Map<string, CapturedValue>();
  const completedIds: string[] = [];

  // Structural pre-check before any step runs.
  const refCheck = validateReferences(input.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args ?? {} })), { pack: ctx.pack ? { id: ctx.pack.id } : undefined, inputs: ctx.inputs });
  if (!refCheck.ok) {
    return pipelineFailure(runId, input, stepResults, exports, 0, undefined, { code: "INVALID_REFERENCES", message: refCheck.message }, [], warnings, undefined);
  }

  let stoppedAtIndex: number | null = null;
  let stopError: { code?: string; message: string; details?: unknown } | undefined;

  // Pipeline-level captureBefore: read values before the main steps.
  for (const entry of input.captureBefore ?? []) {
    const capturedValue = await captureValue(entry, ctx, byId, byIndex);
    if (capturedValue) captured.set(entry.saveAs, capturedValue);
  }

  const pipeCtx: PipeContext = {
    byId,
    byIndex,
    pack: ctx.pack ? { id: ctx.pack.id } : undefined,
    inputs: ctx.inputs
  };

  for (let i = 0; i < input.steps.length; i++) {
    if (Date.now() > deadline) {
      stoppedAtIndex = i;
      stopError = { code: "PIPELINE_TIMEOUT", message: `Pipeline exceeded the total time budget of ${maxTotalMs}ms at step ${i}.` };
      break;
    }
    const step = input.steps[i]!;

    // Step-level captureBefore: read the control's value before acting.
    if (step.captureBefore?.saveAs) {
      const capturedValue = await captureValue(step.captureBefore, ctx, byId, byIndex);
      if (capturedValue) captured.set(step.captureBefore.saveAs, capturedValue);
    }

    const exec = await executeStep(step, i, ctx, pipeCtx, deadline, captured, warnings);
    stepResults.push(exec);
    if (exec.success) {
      byIndex.push(exec.result);
      if (step.id) {
        byId.set(step.id, exec.result);
        completedIds.push(step.id);
      }
      // Validate exports.
      const exportErrors = applyExports(step, exec.result!, exports);
      for (const err of exportErrors) {
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
  const restoreResults = await runRestore(input, success, captured, ctx, byId, byIndex, deadline);
  const finallyResults = await runFinally(input, ctx, pipeCtx, exports, deadline, warnings);

  // Persist a snapshot for continue_run.
  const snapshot: RunSnapshot = {
    runId,
    kind: "run_steps",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    input: input as unknown,
    packId: ctx.pack?.id,
    packVersion: ctx.pack?.version,
    pid: ctx.autoContext?.pid,
    hwnd: ctx.autoContext?.hwnd,
    title: ctx.autoContext?.title,
    profile: ctx.autoContext?.profile,
    resolvedArgs: input.steps.map((s) => ({ tool: s.tool, args: s.args })),
    results: input.steps.map((s, i) => ({ id: s.id, tool: s.tool, success: stepResults[i]?.success ?? false, result: stepResults[i]?.result, error: stepResults[i]?.error })),
    exports,
    stoppedAtStep: stoppedAtIndex ?? input.steps.length,
    error: stopError,
    inputs: ctx.inputs,
    maxSteps: input.steps.length,
    totalTimeoutMs: maxTotalMs
  };
  saveRun(snapshot);

  return {
    schemaVersion: 1,
    success,
    runId,
    status: success ? "completed" : "failed",
    total: input.steps.length,
    completed: success ? input.steps.length : (stoppedAtIndex ?? input.steps.length),
    stoppedAtIndex,
    ...(stoppedAtIndex !== null && input.steps[stoppedAtIndex] !== undefined && input.steps[stoppedAtIndex]!.id ? { stoppedAt: input.steps[stoppedAtIndex]!.id } : {}),
    completedSteps: completedIds,
    steps: stepResults,
    exports,
    ...(stopError ? { error: stopError } : {}),
    finallyResults,
    restoreResults,
    warnings
  };
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
  restoreResults: Array<{ key: string; success: boolean; message?: string; valueCaptured?: boolean }> | undefined
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
    warnings
  };
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

    // Validate the result against the tool's outputSchema before it can be
    // used by later steps.
    const outputCheck = validateAgainstSchema(result, contract.outputSchema);
    if (!outputCheck.ok) {
      lastError = { code: "TOOL_OUTPUT_SCHEMA_MISMATCH", message: `${step.tool} result failed its output schema: ${outputCheck.reason}` };
      if (shouldRetry(lastError.code, onlyCodes, step, ctx)) {
        await sleep(delayMs * Math.pow(backoff, attempt));
        continue;
      }
      return { tool: step.tool, success: false, error: lastError };
    }

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

function applyExports(step: PipelineStepInput, result: unknown, exports: Record<string, unknown>): Array<{ code?: string; message: string; details?: unknown }> {
  const errors: Array<{ code?: string; message: string; details?: unknown }> = [];
  const entries = Object.entries(step.exports ?? {});
  if (entries.length > MAX_EXPORTS_PER_STEP) {
    errors.push({ code: "TOO_MANY_EXPORTS", message: `Step '${step.id ?? ""}' declares ${entries.length} exports; the limit is ${MAX_EXPORTS_PER_STEP}.` });
    return errors;
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
  }
  return errors;
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
async function captureValue(
  entry: CaptureEntry,
  ctx: ExecutionContext,
  byId: Map<string, unknown>,
  byIndex: unknown[]
): Promise<CapturedValue | undefined> {
  const read = entry.read ?? { tool: "ui_get", args: {} };
  let args: unknown;
  try {
    const resolution = resolvePlaceholdersEx(read.args ?? {}, { byId, byIndex, pack: ctx.pack ? { id: ctx.pack.id } : undefined, inputs: ctx.inputs });
    if (!resolution.ok) return undefined;
    args = resolution.value;
  } catch {
    return undefined;
  }
  try {
    const result = await ctx.dispatch(read.tool ?? "ui_get", args);
    const element = (result as { element?: { value?: unknown; valueProtected?: boolean } }).element;
    if (!element) return undefined;
    if (element.valueProtected) {
      return { tool: read.tool ?? "ui_get", args: (read.args ?? {}) as Record<string, unknown>, value: undefined, protected: true };
    }
    if (element.value === null || element.value === undefined) return undefined;
    return { tool: read.tool ?? "ui_get", args: (read.args ?? {}) as Record<string, unknown>, value: element.value, protected: false };
  } catch {
    return undefined;
  }
}

async function runRestore(
  input: PipelineInput,
  success: boolean,
  captured: Map<string, CapturedValue>,
  ctx: ExecutionContext,
  byId: Map<string, unknown>,
  byIndex: unknown[],
  deadline: number
): Promise<Array<{ key: string; success: boolean; message?: string; valueCaptured?: boolean }>> {
  const mode = input.restore ?? "never";
  if (mode === "never" || (mode === "onFailure" && success)) return [];
  const results: Array<{ key: string; success: boolean; message?: string; valueCaptured?: boolean }> = [];
  for (const [key, entry] of captured) {
    if (entry.protected) {
      results.push({ key, success: false, message: "Value not captured (password-protected); nothing to restore.", valueCaptured: false });
      continue;
    }
    if (Date.now() > deadline) {
      results.push({ key, success: false, message: "Restore skipped: pipeline time budget exceeded." });
      continue;
    }
    try {
      const args = { ...entry.args } as Record<string, unknown>;
      const readTool = entry.tool;
      if (readTool === "ui_get") {
        const restoreArgs = { ...args, action: "setValue", value: entry.value };
        await ctx.dispatch("ui_action", restoreArgs);
      } else if (readTool === "profile_action") {
        await ctx.dispatch("profile_action", { ...args, action: "setValue", value: entry.value });
      } else if (readTool === "profile_resolve") {
        await ctx.dispatch("profile_action", { ...args, action: "setValue", value: entry.value });
      } else {
        results.push({ key, success: false, message: `Cannot restore a value captured with tool '${readTool}'.` });
        continue;
      }
      // Verify the restore by reading again.
      const verifyArgs = readTool === "ui_get" ? args : args;
      const after = await ctx.dispatch(readTool, verifyArgs);
      const afterValue = (after as { element?: { value?: unknown; valueProtected?: boolean } }).element?.value;
      const restored = afterValue === entry.value;
      results.push({
        key,
        success: restored,
        message: restored ? undefined : `Restore did not verify: expected '${String(entry.value).slice(0, 40)}', read '${String(afterValue).slice(0, 40)}'.`,
        valueCaptured: true
      });
    } catch (error) {
      results.push({ key, success: false, message: `Restore failed: ${error instanceof Error ? error.message : String(error)}`, valueCaptured: true });
    }
  }
  return results;
}

async function runFinally(
  input: PipelineInput,
  ctx: ExecutionContext,
  pipeCtx: PipeContext,
  exports: Record<string, unknown>,
  deadline: number,
  warnings: string[]
): Promise<StepExecutionResult[]> {
  const results: StepExecutionResult[] = [];
  for (const step of input.finally ?? []) {
    if (Date.now() > deadline) {
      results.push({ tool: step.tool, success: false, error: { code: "PIPELINE_TIMEOUT", message: "Finally skipped: pipeline time budget exceeded." } });
      continue;
    }
    const resolution = resolvePlaceholdersEx(step.args ?? {}, pipeCtx);
    if (!resolution.ok) {
      results.push({ tool: step.tool, success: false, error: { code: "REFERENCE_RESOLUTION_FAILED", message: resolution.reason } });
      continue;
    }
    try {
      const result = await ctx.dispatch(step.tool, resolution.value);
      const contract = getContract(step.tool);
      const outputCheck = contract ? validateAgainstSchema(result, contract.outputSchema) : { ok: true as const };
      if (!outputCheck.ok) {
        results.push({ tool: step.tool, success: false, error: { code: "TOOL_OUTPUT_SCHEMA_MISMATCH", message: outputCheck.reason } });
        continue;
      }
      results.push({ tool: step.tool, success: true, result });
    } catch (error) {
      const normalized = normalizeStepError(error);
      const ignoreCodes = step.ignoreCodes ?? [];
      if (normalized.code && ignoreCodes.includes(normalized.code)) {
        warnings.push(`Finally step '${step.id ?? ""}' ignored error ${normalized.code} (ignoreCodes).`);
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
    if (typeof e.code === "string" || typeof e.message === "string") {
      return {
        ...(typeof e.code === "string" ? { code: e.code } : {}),
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
      finallyResults: [], restoreResults: [], warnings: []
    };
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
  for (const r of snapshot.results) {
    const res = r.result as { pid?: number; hwnd?: string | number } | undefined;
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

  // Re-execute from the continuation point, reusing stored results for the
  // completed prefix. The stored results act as the pipe context, so steps
  // before fromIndex are NOT re-run.
  const results: unknown[] = [];
  const byId = new Map<string, unknown>();
  const completedIds: string[] = [];
  for (let i = 0; i < fromIndex; i++) {
    const stored = snapshot.results[i];
    if (!stored) return fail(runId, "RUN_STATE_STALE", `Missing stored result for step ${i}; cannot continue.`);
    results.push(stored.result);
    if (stored.id) {
      byId.set(stored.id, stored.result);
      completedIds.push(stored.id);
    }
  }

  const stepResults: StepExecutionResult[] = [];
  const exports = { ...snapshot.exports };
  let stoppedAtIndex: number | null = null;
  let stopError: { code?: string; message: string; details?: unknown } | undefined;

  const pipeCtx: PipeContext = {
    byId,
    byIndex: results,
    pack: opts.ctx.pack ? { id: opts.ctx.pack.id } : undefined,
    inputs: snapshot.inputs
  };

  for (let i = fromIndex; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    const exec = await executeStep(step, i, opts.ctx, pipeCtx, Date.now() + (snapshot.totalTimeoutMs ?? DEFAULT_MAX_TOTAL_MS), new Map(), []);
    stepResults.push(exec);
    if (exec.success) {
      results.push(exec.result);
      if (step.id) {
        byId.set(step.id, exec.result);
        completedIds.push(step.id);
      }
      const exportErrors = applyExports(step, exec.result!, exports);
      if (exportErrors.length > 0) {
        stoppedAtIndex = i;
        stopError = exportErrors[0]!;
        break;
      }
    } else {
      stoppedAtIndex = i;
      stopError = exec.error;
      break;
    }
  }

  // Save the updated snapshot (with a fresh TTL) so the run can be continued
  // again.
  const fresh: RunSnapshot = {
    ...snapshot,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 10 * 60 * 1000,
    results: input.steps.map((s, i) => ({ id: s.id, tool: s.tool, success: stepResults[i]?.success ?? snapshot.results[i]?.success ?? false, result: stepResults[i]?.result ?? snapshot.results[i]?.result, error: stepResults[i]?.error ?? snapshot.results[i]?.error })),
    exports,
    stoppedAtStep: stoppedAtIndex ?? input.steps.length,
    error: stopError
  };
  saveRun(fresh);

  const success = stoppedAtIndex === null;
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
    finallyResults: [],
    restoreResults: [],
    warnings: []
  };
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
    finallyResults: [], restoreResults: [], warnings: []
  };
}

// Re-export for index.ts.
export type { PackWorkflowStep };
