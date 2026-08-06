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
import { getContract, unwrapToolError } from "../contracts.js";
import { isSensitiveFieldName } from "../outputs.js";
import { extractReferenceHeads } from "../piping.js";
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
  "selectByName", "selectByIndex", "getSelection", "openMenu", "openSubmenu", "ensureSelected", "ensureVisible"
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
  validateSemanticMap(pack, errors, warnings, checked);

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
    const selectors = rawSelectors(entry);
    if (selectors.length === 0) {
      errors.push({ file: "controls.json", path: `controls.${name}`, code: "EMPTY_SELECTORS", message: `Control '${name}' has no selectors.`, suggestion: "Provide at least one selector." });
    }
    // Semantic metadata on the entry (pages.json/components.json references).
    const meta = typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
    if (meta) {
      // Absolute screen coordinates are never allowed as a primary selector.
      for (const [index, selector] of selectors.entries()) {
        const sel = selector as Record<string, unknown>;
        if (sel && typeof sel === "object" && "x" in sel && "y" in sel) {
          errors.push({
            file: "controls.json", path: `controls.${name}.selectors.${index}`,
            code: "ABSOLUTE_COORDINATE_SELECTOR",
            message: `Control '${name}' uses absolute screen coordinates as a selector; coordinates are only allowed as a versioned normalized fallback.`,
            suggestion: "Use automationId/name selectors with ancestor scoping; move coordinates into the last fallback slot if unavoidable."
          });
        }
      }
    }
  }
  void warnings;
}

// Extract the selector array from a control entry (bare selector, selector[]
// or full entry object).
function rawSelectors(entry: unknown): unknown[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray((entry as { selectors?: unknown[] }).selectors)) {
    return (entry as { selectors: unknown[] }).selectors;
  }
  return [entry];
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

  // UNIFIED reference scanning: every place a ${...} placeholder can appear
  // (args, expect, captureBefore.read.args, finally, restore reads) is
  // scanned with the SAME reference parser the pipeline uses
  // (extractReferenceHeads) - never a second ad-hoc regex.
  const scan = (value: unknown, path: string): void => {
    for (const ref of extractReferenceHeads(value)) {
      checkReference(ref.head, ref.tail, path);
    }
  };
  const checkReference = (refHead: string, tail: string[], path: string): void => {
    if (refHead === "pack") return; // ${pack.id} is server-injected
    if (refHead === "inputs") return; // ${inputs.x} from workflow inputs
    if (/^\d+$/.test(refHead)) {
      const n = Number(refHead);
      if (n >= index && index >= 0) {
        errors.push({
          file: "workflows.json", path, code: "FORWARD_REFERENCE",
          message: `Step references ${refHead} which is not an earlier step (index ${index}).`,
          suggestion: "Steps may only reference earlier steps."
        });
      } else if (n < index && index >= 0) {
        checkOutputPath(refHead, tail, path);
      }
      return;
    }
    const refIndex = stepIndex.get(refHead);
    if (refIndex === undefined) {
      errors.push({
        file: "workflows.json", path, code: "UNKNOWN_STEP_REFERENCE",
        message: `Step references '${refHead}' which is not a step id in this workflow.`,
        suggestion: "Use an earlier step's id, a numeric index, ${pack.id}, or ${inputs.x}."
      });
    } else if (refIndex >= index && index >= 0) {
      errors.push({
        file: "workflows.json", path, code: "FORWARD_REFERENCE",
        message: `Step references '${refHead}' (step ${refIndex}) which is not before step ${index}.`,
        suggestion: "Steps may only reference earlier steps."
      });
    } else {
      // Validate that the referenced field exists in the referenced tool's
      // outputSchema.
      checkOutputPath(refHead, tail, path);
    }
  };
  const checkOutputPath = (refHead: string, tail: string[], path: string): void => {
    const refIndex = /^\d+$/.test(refHead) ? Number(refHead) : stepIndex.get(refHead);
    if (refIndex === undefined || refIndex < 0) return;
    const refStep = workflow.steps[refIndex];
    const refContract = refStep ? getContract(refStep.tool) : undefined;
    if (refContract && tail.length > 0 && !fieldExistsInSchema(refContract, tail)) {
      errors.push({
        file: "workflows.json", path, code: "UNKNOWN_OUTPUT_PATH",
        message: `Output path '${[refHead, ...tail].join(".")}' does not exist in ${refStep?.tool ?? "?"}'s output schema.`,
        suggestion: suggestionForField(refContract, tail)
      });
    }
  };

  scan(step.args, where("args"));
  scan(step.expect, where("expect"));
  scan(step.captureBefore?.read?.args, where("captureBefore.read.args"));
  // Retry policies carry no references (only error codes), but scanning the
  // whole step object is harmless and future-proof.
  scan(step.retry, where("retry"));

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

// Best-effort field existence check against a JSON Schema: returns true when
// the schema does not declare properties (can't verify), or the field exists.
function fieldExistsInSchema(contract: ToolContract, segments: string[]): boolean {
  // Unwrap the withToolError wrapper: reference/export paths point at the
  // SUCCESS result, never at the error envelope.
  let node: import("../contracts.js").JsonSchema = unwrapToolError(contract.outputSchema) ?? {};
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

// ── Semantic map validation (pages.json / components.json + control meta) ──

const SCREEN_COORD_KEYS = new Set(["x", "y"]);

function validateSemanticMap(
  pack: LoadedPack,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  checked: string[]
): void {
  const controls = pack.controls.controls;
  const known = new Set(Object.keys(controls));
  const pageIds = new Set<string>();
  const groupIds = new Set<string>();
  const componentIds = new Set<string>();

  // Unique page ids.
  for (const page of pack.pages?.pages ?? []) {
    if (pageIds.has(page.id)) {
      errors.push({ file: "pages.json", path: `pages.${page.id}`, code: "DUPLICATE_PAGE_ID", message: `Duplicate page id '${page.id}'.`, suggestion: "Use unique page ids." });
    }
    pageIds.add(page.id);
  }

  // Unique selection-group ids.
  for (const group of pack.pages?.selectionGroups ?? []) {
    if (groupIds.has(group.id)) {
      errors.push({ file: "pages.json", path: `selectionGroups.${group.id}`, code: "DUPLICATE_GROUP_ID", message: `Duplicate selection group id '${group.id}'.`, suggestion: "Use unique selection group ids." });
    }
    groupIds.add(group.id);
  }

  // Unique component ids.
  for (const component of pack.components?.components ?? []) {
    if (componentIds.has(component.id)) {
      errors.push({ file: "components.json", path: `components.${component.id}`, code: "DUPLICATE_COMPONENT_ID", message: `Duplicate component id '${component.id}'.`, suggestion: "Use unique component ids." });
    }
    componentIds.add(component.id);
  }

  // ── pages.json ──
  for (const page of pack.pages?.pages ?? []) {
    const where = `pages.${page.id}`;
    if (page.navigationControl && !known.has(page.navigationControl)) {
      errors.push({ file: "pages.json", path: `${where}.navigationControl`, code: "UNKNOWN_NAVIGATION_CONTROL", message: `Page '${page.id}' navigationControl '${page.navigationControl}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
    }
    if (page.rootControl && !known.has(page.rootControl)) {
      errors.push({ file: "pages.json", path: `${where}.rootControl`, code: "UNKNOWN_ROOT_CONTROL", message: `Page '${page.id}' rootControl '${page.rootControl}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
    }
    for (const marker of page.readyMarkers ?? []) {
      if (!known.has(marker.profileControl)) {
        errors.push({ file: "pages.json", path: `${where}.readyMarkers`, code: "UNKNOWN_READY_MARKER", message: `Page '${page.id}' readyMarker references control '${marker.profileControl}' which is not defined in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
    for (const scroll of page.scrollContainers ?? []) {
      if (!known.has(scroll)) {
        errors.push({ file: "pages.json", path: `${where}.scrollContainers`, code: "UNKNOWN_SCROLL_CONTAINER", message: `Page '${page.id}' scrollContainer '${scroll}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
    for (const component of page.components ?? []) {
      if (!componentIds.has(component)) {
        errors.push({ file: "pages.json", path: `${where}.components`, code: "UNKNOWN_COMPONENT", message: `Page '${page.id}' references component '${component}' which is not defined in components.json.`, suggestion: "Add the component or fix the reference." });
      }
    }
  }

  // ── selectionGroups ──
  for (const group of pack.pages?.selectionGroups ?? []) {
    const where = `selectionGroups.${group.id}`;
    if (group.parent && !known.has(group.parent) && !componentIds.has(group.parent)) {
      errors.push({ file: "pages.json", path: `${where}.parent`, code: "UNKNOWN_GROUP_PARENT", message: `Selection group '${group.id}' parent '${group.parent}' is neither a control nor a component.`, suggestion: "Reference an existing control or component." });
    }
    for (const member of group.members) {
      if (!known.has(member)) {
        errors.push({ file: "pages.json", path: `${where}.members`, code: "UNKNOWN_GROUP_MEMBER", message: `Selection group '${group.id}' member '${member}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
  }

  // ── components.json ──
  for (const component of pack.components?.components ?? []) {
    const where = `components.${component.id}`;
    if (component.page && !pageIds.has(component.page)) {
      errors.push({ file: "components.json", path: `${where}.page`, code: "UNKNOWN_COMPONENT_PAGE", message: `Component '${component.id}' page '${component.page}' is not defined in pages.json.`, suggestion: "Add the page or fix the reference." });
    }
    if (component.rootControl && !known.has(component.rootControl)) {
      errors.push({ file: "components.json", path: `${where}.rootControl`, code: "UNKNOWN_COMPONENT_ROOT", message: `Component '${component.id}' rootControl '${component.rootControl}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
    }
    for (const child of component.children ?? []) {
      if (!known.has(child)) {
        errors.push({ file: "components.json", path: `${where}.children`, code: "UNKNOWN_COMPONENT_CHILD", message: `Component '${component.id}' child '${child}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
  }

  // ── per-control semantic metadata (controls.json) ──
  for (const [name, entry] of Object.entries(controls)) {
    if (Array.isArray(entry) || !(typeof entry === "object") || !("selectors" in entry)) continue;
    const meta = entry as {
      page?: string; parent?: string; group?: string; role?: string;
      search?: { rootControl?: string }; visibility?: { scrollContainer?: string };
      postconditions?: Array<{ profileControl: string }>;
      controlState?: { any?: Array<{ profileControl?: string }>; all?: Array<{ profileControl?: string }> };
      fallbackPolicy?: { enabled?: boolean; methods?: string[]; forbidden?: string[] };
      supportedActions?: string[]; selectionGroup?: string;
    };
    const where = `controls.${name}`;
    if (meta.page && !pageIds.has(meta.page)) {
      errors.push({ file: "controls.json", path: `${where}.page`, code: "UNKNOWN_CONTROL_PAGE", message: `Control '${name}' page '${meta.page}' is not defined in pages.json.`, suggestion: "Add the page or fix the reference." });
    }
    if (meta.parent && !known.has(meta.parent) && !componentIds.has(meta.parent)) {
      errors.push({ file: "controls.json", path: `${where}.parent`, code: "UNKNOWN_CONTROL_PARENT", message: `Control '${name}' parent '${meta.parent}' is neither a control nor a component.`, suggestion: "Reference an existing control or component." });
    }
    if (meta.group && !groupIds.has(meta.group)) {
      errors.push({ file: "controls.json", path: `${where}.group`, code: "UNKNOWN_CONTROL_GROUP", message: `Control '${name}' group '${meta.group}' is not defined in pages.json selectionGroups.`, suggestion: "Add the selection group or fix the reference." });
    }
    if (meta.group && meta.selectionGroup && meta.group !== meta.selectionGroup) {
      errors.push({ file: "controls.json", path: `${where}.selectionGroup`, code: "GROUP_CONFLICT", message: `Control '${name}' declares conflicting groups: meta.group '${meta.group}' vs legacy selectionGroup '${meta.selectionGroup}'.`, suggestion: "Use the semantic group in pages.json only." });
    }
    if (meta.search?.rootControl && !known.has(meta.search.rootControl)) {
      errors.push({ file: "controls.json", path: `${where}.search.rootControl`, code: "UNKNOWN_SEARCH_ROOT", message: `Control '${name}' search.rootControl '${meta.search.rootControl}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
    }
    if (meta.visibility?.scrollContainer && !known.has(meta.visibility.scrollContainer)) {
      errors.push({ file: "controls.json", path: `${where}.visibility.scrollContainer`, code: "UNKNOWN_SCROLL_CONTAINER", message: `Control '${name}' visibility.scrollContainer '${meta.visibility.scrollContainer}' is not a control in controls.json.`, suggestion: "Add the control or fix the reference." });
    }
    for (const post of meta.postconditions ?? []) {
      if (!known.has(post.profileControl)) {
        errors.push({ file: "controls.json", path: `${where}.postconditions`, code: "UNKNOWN_POSTCONDITION_CONTROL", message: `Control '${name}' postcondition references control '${post.profileControl}' which is not defined in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
    for (const req of [...(meta.controlState?.any ?? []), ...(meta.controlState?.all ?? [])]) {
      if (req.profileControl && !known.has(req.profileControl)) {
        errors.push({ file: "controls.json", path: `${where}.controlState`, code: "UNKNOWN_CONTROL_STATE_CONTROL", message: `Control '${name}' controlState references control '${req.profileControl}' which is not defined in controls.json.`, suggestion: "Add the control or fix the reference." });
      }
    }
    if (meta.fallbackPolicy) {
      const f = meta.fallbackPolicy;
      // PhysicalMouse/GlobalKeyboard are ALWAYS forbidden by the core; a pack
      // may declare them in `forbidden` as an explicit statement (allowed),
      // but may never ENABLE them in `methods`.
      const alwaysForbidden = new Set(["PhysicalMouse", "GlobalKeyboard"]);
      for (const method of f.methods ?? []) {
        if (alwaysForbidden.has(method)) {
          errors.push({ file: "controls.json", path: `${where}.fallbackPolicy.methods`, code: "FORBIDDEN_FALLBACK_METHOD", message: `Control '${name}' lists '${method}' in fallbackPolicy.methods - it is never allowed (the core never moves the physical cursor or uses global keyboard input).`, suggestion: `Remove '${method}' from methods; declare it in forbidden instead if you want to state it explicitly.` });
          continue;
        }
        if (!["SelectionItemPattern", "TogglePattern", "InvokePattern", "WindowMessageElementClick", "KeyboardNavigation"].includes(method)) {
          errors.push({ file: "controls.json", path: `${where}.fallbackPolicy.methods`, code: "INVALID_FALLBACK_METHOD", message: `Control '${name}' fallback method '${method}' is not a known method.`, suggestion: "Valid: SelectionItemPattern, TogglePattern, InvokePattern, WindowMessageElementClick, KeyboardNavigation." });
        }
      }
    }
  }

  // ── relationship cycles (components -> children, controls -> parent) ──
  // A cycle is only a cycle WITHIN one kind: a component whose children chain
  // leads back to itself, or a control whose parent chain leads back to
  // itself. Component <-> control cross-references (a component lists a
  // control in children while the control declares the component as parent)
  // are legitimate redundant declarations and are NOT cycles: the walk stops
  // at cross-kind references.
  const visit = new Set<string>();
  const stack = new Set<string>();
  const cycleRefs = new Map<string, string>(); // node -> referenced node on the cycle
  for (const component of pack.components?.components ?? []) {
    collectRefs(component.id, component.children ?? [], true);
  }
  for (const [name, entry] of Object.entries(controls)) {
    if (!(typeof entry === "object") || Array.isArray(entry) || !("selectors" in entry)) continue;
    const parent = (entry as { parent?: string }).parent;
    if (parent) collectRefs(name, [parent], false);
  }
  for (const [node, ref] of cycleRefs) {
    errors.push({
      file: "components.json", path: `relationships.${node}`, code: "RELATIONSHIP_CYCLE",
      message: `Semantic relationship cycle detected at '${node}' (references '${ref}').`,
      suggestion: "Break the cycle; parent/children relationships must form a DAG."
    });
  }

  // fromComponent=true when walking a component's children (follow only
  // component references); false when walking a control's parent chain
  // (follow only control references).
  function collectRefs(node: string, refs: string[], fromComponent: boolean): void {
    if (stack.has(node)) {
      cycleRefs.set(node, refs[0] ?? "");
      return;
    }
    if (visit.has(node)) return;
    visit.add(node);
    stack.add(node);
    for (const ref of refs) {
      if (ref === node) {
        cycleRefs.set(node, ref);
        continue;
      }
      if (fromComponent) {
        // Component children: continue only into other components.
        if (componentIds.has(ref)) {
          const childComp = pack.components?.components.find((c) => c.id === ref);
          if (childComp) collectRefs(ref, childComp.children ?? [], true);
        }
        // Control children terminate the walk (their parent back-reference is
        // a cross-kind declaration, not a cycle).
      } else {
        // Control parent chain: continue only into other controls.
        if (known.has(ref)) {
          const refEntry = controls[ref] as { parent?: string } | undefined;
          const refParent = refEntry && typeof refEntry === "object" && !Array.isArray(refEntry) && "selectors" in refEntry ? (refEntry as { parent?: string }).parent : undefined;
          if (refParent) collectRefs(ref, [refParent], false);
        }
        // A control whose parent is a component terminates the walk.
      }
    }
    stack.delete(node);
  }

  checked.push(`semantic:pages:${pageIds.size},groups:${groupIds.size},components:${componentIds.size}`);
}
