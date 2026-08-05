// Deep App Pack validation.
//
// The loader validates JSON structure (zod). This validator checks CROSS-FILE
// and semantic invariants that a single-file schema cannot:
//
//   - action contracts reference existing controls
//   - workflow tools exist in the contract table
//   - workflow step references are backward-only and reference fields that
//     exist in the referenced tool's outputSchema
//   - export paths exist in the step tool's outputSchema
//   - export names are not sensitive fields
//   - no absolute executable paths / local drive paths in pack data
//   - no unsafe retry (non-idempotent action with automatic retry)
//   - unknown actions / unsupported expect conditions
//   - duplicate step ids within a workflow
//
// Returns structured issues with codes, paths, messages and suggestions.

import type { ToolContract } from "../contracts.js";
import { getContract } from "../contracts.js";
import { isSensitiveFieldName } from "../outputs.js";
import type { LoadedPack, PackWorkflow, PackWorkflowStep } from "./types.js";

export type ValidationIssue = {
  file: string;
  path: string;
  code: string;
  message: string;
  suggestion?: string;
};

export type PackValidationResult = {
  pack: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checked: string[];
};

// Known-composite profile actions (implemented by the profile layer).
const COMPOSITE_ACTIONS = new Set([
  "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected"
]);

// Primitive UIA actions (implemented by the UIA layer).
const PRIMITIVE_ACTIONS = new Set([
  "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
  "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
  "focus", "legacyDefaultAction", "click", "appendText", "clear", "selectAll",
  "getValue", "setChecked", "increment", "decrement"
]);

const RESERVED_STEP_IDS = new Set(["vars", "env", "steps", "results", "run", "pack", "inputs"]);

// Matches drive-letter paths and UNC roots anywhere in the data, tolerating
// JSON escaping (\\ vs \).
const ABSOLUTE_PATH_RE = /([A-Za-z]:[\\/]{1,2}|[\\/]{2,4})/;
const SENSITIVE_VALUE_RE = /password|token|credential|secret|authorization|cookie/i;

export function validatePack(pack: LoadedPack): PackValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const checked: string[] = [];

  validateControls(pack, errors, warnings, checked);
  validateActions(pack, errors, warnings, checked);
  validateWorkflows(pack, errors, warnings, checked);
  validateSensitiveData(pack, errors, warnings, checked);

  return {
    pack: pack.manifest.id,
    valid: errors.length === 0,
    errors,
    warnings,
    checked
  };
}

function validateControls(
  pack: LoadedPack,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  const names = Object.keys(pack.controls.controls);
  checked.push(`controls:${names.length}`);
  for (const [name, entry] of Object.entries(pack.controls.controls)) {
    const selectors = Array.isArray(entry) ? entry : "selectors" in entry && Array.isArray((entry as { selectors?: unknown[] }).selectors)
      ? (entry as { selectors: unknown[] }).selectors
      : [entry];
    if (selectors.length === 0) {
      errors.push({ file: "controls.json", path: `controls.${name}`, code: "EMPTY_SELECTORS", message: `Control '${name}' has no selectors.`, suggestion: "Provide at least one selector." });
    }
  }
  void warnings;
}

function validateActions(
  pack: LoadedPack,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  checked.push(`actions:${pack.actions.contracts.length}`);
  const known = new Set(Object.keys(pack.controls.controls));
  const seen = new Set<string>();
  for (const contract of pack.actions.contracts) {
    const key = `${contract.control}|${contract.action}`;
    if (seen.has(key)) {
      warnings.push({ file: "actions.json", path: `contracts.${key}`, code: "DUPLICATE_CONTRACT", message: `Duplicate action contract for '${key}'.` });
    }
    seen.add(key);
    if (!known.has(contract.control)) {
      errors.push({
        file: "actions.json",
        path: `contracts.${key}`,
        code: "UNKNOWN_CONTROL",
        message: `Action contract references control '${contract.control}' which is not defined in controls.json.`,
        suggestion: "Add the control to controls.json or fix the contract name."
      });
    }
    if (!PRIMITIVE_ACTIONS.has(contract.action) && !COMPOSITE_ACTIONS.has(contract.action)) {
      errors.push({
        file: "actions.json",
        path: `contracts.${key}`,
        code: "UNKNOWN_ACTION",
        message: `Action '${contract.action}' is not a supported UIA action.`,
        suggestion: `Supported: ${[...PRIMITIVE_ACTIONS].join(", ")} plus composites ${[...COMPOSITE_ACTIONS].join(", ")}.`
      });
    }
    // Unsafe retry: an action that is not idempotent must not be marked
    // retrySafe (automatic retry could double-fire the action).
    if (!contract.idempotent && contract.retrySafe) {
      errors.push({
        file: "actions.json",
        path: `contracts.${key}`,
        code: "UNSAFE_RETRY",
        message: `Action '${contract.action}' on '${contract.control}' is retrySafe but NOT idempotent; retrying could fire the action twice.`,
        suggestion: "Mark the action idempotent, or remove retrySafe, or rely on defaultExpect verification."
      });
    }
  }
}

function validateWorkflows(
  pack: LoadedPack,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  checked.push(`workflows:${pack.workflows.workflows.length}`);
  const ids = new Set<string>();
  for (const workflow of pack.workflows.workflows) {
    if (ids.has(workflow.id)) {
      errors.push({ file: "workflows.json", path: `workflows.${workflow.id}`, code: "DUPLICATE_ID", message: `Duplicate workflow id '${workflow.id}'.`, suggestion: "Use unique workflow ids." });
    }
    ids.add(workflow.id);
    validateWorkflow(pack, workflow, errors, warnings, checked);
  }
}

// Parse "tool.field.path" / "N.field.path" / "stepId.field.path" references.
export function parseReference(ref: string): { head: string; tail: string[] } {
  const dot = ref.indexOf(".");
  if (dot < 0) return { head: ref, tail: [] };
  return { head: ref.slice(0, dot), tail: ref.slice(dot + 1).split(".") };
}

function validateWorkflow(
  pack: LoadedPack,
  workflow: PackWorkflow,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  const stepIds = new Set<string>();
  const stepIndex = new Map<string, number>();
  workflow.steps.forEach((step, index) => {
    if (step.id) {
      if (RESERVED_STEP_IDS.has(step.id)) {
        errors.push({
          file: "workflows.json", path: `workflows.${workflow.id}.steps.${index}.id`,
          code: "RESERVED_STEP_ID", message: `Step id '${step.id}' is reserved.`,
          suggestion: `Reserved: ${[...RESERVED_STEP_IDS].join(", ")}.`
        });
      } else if (stepIds.has(step.id)) {
        errors.push({
          file: "workflows.json", path: `workflows.${workflow.id}.steps.${index}.id`,
          code: "DUPLICATE_STEP_ID", message: `Duplicate step id '${step.id}'.`,
          suggestion: "Step ids must be unique within a workflow."
        });
      } else {
        stepIds.add(step.id);
        stepIndex.set(step.id, index);
      }
    }
  });

  workflow.steps.forEach((step, index) => {
    validateStep(pack, workflow, step, index, stepIndex, errors, warnings, "steps");
  });
  for (const step of workflow.finally ?? []) {
    validateStep(pack, workflow, step, -1, stepIndex, errors, warnings, "finally");
  }
}

function validateStep(
  pack: LoadedPack,
  workflow: PackWorkflow,
  step: PackWorkflowStep,
  index: number,
  stepIndex: Map<string, number>,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  section: string
): void {
  const where = (suffix: string) => `workflows.${workflow.id}.${section}.${index >= 0 ? index : "finally"}.${suffix}`;

  const contract = getContract(step.tool);
  if (!contract) {
    errors.push({
      file: "workflows.json", path: where("tool"), code: "UNKNOWN_TOOL",
      message: `Tool '${step.tool}' is not an MCP tool of this server.`,
      suggestion: "Check the tool name against tools/list."
    });
    return;
  }

  // Step ids referenced by ${id.path} must be earlier steps.
  const refs = collectPlaceholderHeads(step.args);
  for (const refHead of refs) {
    if (refHead === "pack") continue; // ${pack.id} is server-injected
    if (refHead === "inputs") continue; // ${inputs.x} from workflow inputs
    if (/^\d+$/.test(refHead)) {
      const n = Number(refHead);
      if (n >= index && index >= 0) {
        errors.push({
          file: "workflows.json", path: where("args"), code: "FORWARD_REFERENCE",
          message: `Step references ${refHead} which is not an earlier step (index ${index}).`,
          suggestion: "Steps may only reference earlier steps."
        });
      }
      continue;
    }
    const refIndex = stepIndex.get(refHead);
    if (refIndex === undefined) {
      errors.push({
        file: "workflows.json", path: where("args"), code: "UNKNOWN_STEP_REFERENCE",
        message: `Step references '${refHead}' which is not a step id in this workflow.`,
        suggestion: "Use an earlier step's id, a numeric index, ${pack.id}, or ${inputs.x}."
      });
    } else if (refIndex >= index && index >= 0) {
      errors.push({
        file: "workflows.json", path: where("args"), code: "FORWARD_REFERENCE",
        message: `Step references '${refHead}' (step ${refIndex}) which is not before step ${index}.`,
        suggestion: "Steps may only reference earlier steps."
      });
    } else {
      // Validate that the referenced field exists in the referenced tool's
      // outputSchema.
      const refStep = workflow.steps[refIndex];
      const refContract = refStep ? getContract(refStep.tool) : undefined;
      if (refContract && refIndex >= 0) {
        const tail = collectPlaceholderPaths(step.args, refHead);
        for (const t of tail) {
          if (t.length > 0 && !fieldExistsInSchema(refContract, t)) {
            errors.push({
              file: "workflows.json", path: where("args"), code: "UNKNOWN_OUTPUT_PATH",
              message: `Output path '${[refHead, ...t].join(".")}' does not exist in ${refStep?.tool ?? "?"}'s output schema.`,
              suggestion: suggestionForField(refContract, t)
            });
          }
        }
      }
    }
  }

  // Exports: paths must exist in the step tool's outputSchema, names must not
  // be sensitive.
  for (const [exportName, exportPath] of Object.entries(step.exports ?? {})) {
    if (isSensitiveFieldName(exportName.split("."))) {
      errors.push({
        file: "workflows.json", path: where("exports"), code: "EXPORT_SENSITIVE_VALUE_BLOCKED",
        message: `Export name '${exportName}' matches a sensitive field (password/token/credential/secret/authorization/cookie).`,
        suggestion: "Rename the export; sensitive values are never piped."
      });
    }
    // Export paths are relative to the result root (optional "$" prefix).
    const exportSegments = exportPath.split(".").filter((s) => s !== "$" && s !== "");
    if (exportSegments.length > 0 && !fieldExistsInSchema(contract, exportSegments)) {
      errors.push({
        file: "workflows.json", path: where("exports"), code: "EXPORT_PATH_NOT_FOUND",
        message: `Export '${exportName}' path '${exportPath}' does not exist in ${step.tool}'s output schema.`,
        suggestion: suggestionForField(contract, exportSegments)
      });
    }
  }

  // Async actions (ui_action / profile_action / click_window) without expect
  // are warned: the model should verify the outcome.
  if (contract.annotations?.needsExpect && step.expect === undefined && !isExpectCoveredByPack(pack, step)) {
    warnings.push({
      file: "workflows.json", path: where("expect"), code: "MISSING_EXPECT",
      message: `'${step.tool}' fires an action; no expect postcondition is set and the pack has no defaultExpect for this step.`,
      suggestion: "Add an expect (e.g. profileControl/condition) or expect:false to acknowledge."
    });
  }

  // Retry on non-idempotent steps is unsafe unless the pack contract marks
  // the action idempotent.
  if (step.retry && !isStepIdempotent(pack, step)) {
    errors.push({
      file: "workflows.json", path: where("retry"), code: "UNSAFE_RETRY",
      message: `Step '${step.tool}' has retry configured but is not idempotent; automatic retry could double-fire the action.`,
      suggestion: "Mark the action idempotent in actions.json, or verify with expect before retrying."
    });
  }
}

// ── helpers ──

function collectPlaceholderHeads(args: unknown): string[] {
  const heads = new Set<string>();
  walk(args);
  return [...heads];

  function walk(v: unknown): void {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([A-Za-z0-9_]+)(?:\.[\w.]+)*\}/g)) {
        heads.add(m[1]!);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  }
}

function collectPlaceholderPaths(args: unknown, head: string): string[][] {
  const paths: string[][] = [];
  walk(args);
  return paths;

  function walk(v: unknown): void {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([A-Za-z0-9_]+)(\.[\w.]+)*\}/g)) {
        if (m[1] === head && m[2]) {
          paths.push(m[2]!.slice(1).split("."));
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  }
}

// Best-effort field existence check against a JSON Schema: returns true when
// the schema does not declare properties (can't verify), or the field exists.
function fieldExistsInSchema(contract: ToolContract, segments: string[]): boolean {
  let node: import("../contracts.js").JsonSchema = contract.outputSchema;
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
    // Unverifiable schema node (any / no declared properties): assume deeper
    // paths may exist.
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

function isExpectCoveredByPack(pack: LoadedPack, step: PackWorkflowStep): boolean {
  if (!pack.actions.contracts.some((c) => c.control === step.args.control && c.action === step.args.action && c.defaultExpect)) {
    return false;
  }
  return true;
}

function isStepIdempotent(pack: LoadedPack, step: PackWorkflowStep): boolean {
  if (step.tool === "ui_wait" || step.tool === "ui_get" || step.tool === "ui_query" || step.tool === "read_clipboard" || step.tool === "list_windows" || step.tool === "get_window_state") {
    return true;
  }
  const contract = getContract(step.tool);
  if (contract?.annotations?.idempotent) return true;
  const control = step.args.control as string | undefined;
  const action = step.args.action as string | undefined;
  if (control && action) {
    const c = pack.actions.contracts.find((x) => x.control === control && x.action === action);
    if (c) return c.idempotent === true;
  }
  return false;
}

function validateSensitiveData(
  pack: LoadedPack,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  const serialized = JSON.stringify({ profile: pack.profile, controls: pack.controls.controls, actions: pack.actions.contracts });
  checked.push("sensitive-data");
  if (ABSOLUTE_PATH_RE.test(serialized)) {
    errors.push({
      file: "profile.json", path: "*", code: "ABSOLUTE_PATH",
      message: "Pack data contains an absolute path (drive letter or UNC). Packs must not store machine-specific absolute paths.",
      suggestion: "Use executableEnv (an env var name) for the executable location."
    });
  }
  if (SENSITIVE_VALUE_RE.test(serialized)) {
    warnings.push({
      file: "*", path: "*", code: "SENSITIVE_VALUE",
      message: "Pack data contains a string matching password/token/credential/secret/authorization/cookie. Credentials must never be stored in packs.",
      suggestion: "Remove the value; secrets belong in the environment, not the pack."
    });
  }
  // Profile id must match the manifest id (consistency).
  if (pack.profile.id !== pack.manifest.id) {
    errors.push({
      file: "profile.json", path: "id", code: "ID_MISMATCH",
      message: `profile.json id '${pack.profile.id}' does not match manifest.json id '${pack.manifest.id}'.`,
      suggestion: "Both files must use the same pack id."
    });
  }
}
