// Workflow catalog + execution.
//
// Workflows come ONLY from loaded App Packs (or public example packs) - the
// core never hardcodes a business workflow. run_workflow validates inputs
// against the workflow's inputSchema, injects ${pack.id} server-side, applies
// pack defaultExpect through the pipeline engine, and returns named step
// results plus a runId for continue_run.

import type { LoadedPack, PackWorkflow } from "./types.js";
import { runPipeline, type ExecutionContext, type PipelineInput, type PipelineResult } from "../pipeline.js";
import { McpUiError } from "../uia/results.js";
import { getContract } from "../contracts.js";
import {
  backgroundUnsafePipelineSteps,
  stepBackgroundPolicy,
  type BackgroundPolicy,
  type InteractionMode,
  type InteractionOptions
} from "../interaction.js";

export type WorkflowCatalogEntry = {
  id: string;
  description: string;
  safe: boolean;
  tested: boolean;
  restoresState: boolean;
  requiredInputs: string[];
  visibility: string;
  // Declared background capability of the workflow (aggregated over its
  // steps): foregroundRequired when any step is (those workflows need
  // interactionMode=foregroundDemo), bestEffort when a step may fail in
  // background, safe when every step is verified background-safe.
  backgroundPolicy: BackgroundPolicy;
  // The steps that block background execution (foregroundRequired).
  foregroundRequiredSteps: Array<{ stepId?: string; backgroundPolicy: BackgroundPolicy; suggestedMode: "foregroundDemo" }>;
};

export function listWorkflows(pack: LoadedPack): WorkflowCatalogEntry[] {
  return pack.workflows.workflows
    .map((w) => {
      // The catalog's background capability MUST be computed with the SAME
      // logic the runtime uses (backgroundUnsafePipelineSteps: main steps AND
      // finally), so workflow_catalog and the background preflight can never
      // disagree.
      const unsafe = backgroundUnsafePipelineSteps(w.steps, w.finally ?? [], () => undefined, pack.actions);
      const allSteps = [...w.steps, ...(w.finally ?? [])];
      const policies = allSteps.map((s) => stepBackgroundPolicy(pack.actions, s));
      const backgroundPolicy: BackgroundPolicy = unsafe.length > 0
        ? "foregroundRequired"
        : policies.some((p) => p === "bestEffort")
          ? "bestEffort"
          : "safe";
      return {
        id: w.id,
        description: w.description ?? "",
        safe: w.safe ?? false,
        tested: w.tested ?? false,
        restoresState: w.restoresState ?? false,
        requiredInputs: w.inputSchema?.required ?? [],
        visibility: w.visibility ?? "session",
        backgroundPolicy,
        foregroundRequiredSteps: unsafe.map((s) => ({
          ...(s.stepId ? { stepId: s.stepId } : {}),
          ...(s.section ? { section: s.section } : {}),
          backgroundPolicy: s.backgroundPolicy,
          suggestedMode: s.suggestedMode
        }))
      };
    });
}

export function getWorkflow(pack: LoadedPack, id: string): PackWorkflow | undefined {
  return pack.workflows.workflows.find((w) => w.id === id);
}

// Validate workflow inputs against its inputSchema using the SAME structural
// JSON-Schema subset validator as the tool output contracts (type / required /
// enum / minimum / maximum / minLength / maxLength / pattern / nested objects
// / arrays / additionalProperties). There is no separate hand-written
// workflow-validator; the error shape mirrors the output validator's
// ({path, message}) so clients can map failures to input fields.
import { validateAgainstSchema } from "../outputs.js";
import type { JsonSchema } from "../contracts.js";

export type WorkflowInputValidationError = { path: string; message: string };

export function validateWorkflowInputs(workflow: PackWorkflow, inputs: unknown): WorkflowInputValidationError[] {
  const schema = (workflow.inputSchema ?? { type: "object", properties: {}, required: [] as string[], additionalProperties: false }) as unknown as JsonSchema;
  if (inputs === undefined || inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    return [{ path: "inputs", message: "Expected an object" }];
  }
  const check = validateAgainstSchema(inputs, schema);
  if (check.ok) return [];
  return check.errors;
}

export type RunWorkflowOptions = {
  pack: LoadedPack;
  workflow: PackWorkflow;
  inputs: Record<string, unknown>;
  profile: import("../profiles/types.js").AppProfile;
  // The full pipeline ExecutionContext (dispatch, pack, expectDeps, and the
  // resolved interaction context), built by the SINGLE context factory in
  // index.ts. runWorkflow itself never hand-assembles context.
  ctx: ExecutionContext;
};

export async function runWorkflow(opts: RunWorkflowOptions): Promise<PipelineResult> {
  const { pack, workflow, inputs, ctx } = opts;

  const inputErrors = validateWorkflowInputs(workflow, inputs);
  if (inputErrors.length > 0) {
    throw new McpUiError(
      "WORKFLOW_INPUT_INVALID",
      `Workflow '${workflow.id}' inputs are invalid (${inputErrors.length} error(s)).`,
      { workflow: workflow.id, validationErrors: inputErrors.slice(0, 20) }
    );
  }

  // "internal" visibility was removed from the pack schema (no composition
  // engine), so an unreachable internal workflow is impossible by
  // construction. The guard remains as a runtime backstop for packs created
  // by older server versions that still carry the declaration.
  if ((workflow.visibility as string) === "internal") {
    throw new McpUiError("WORKFLOW_INTERNAL", `Workflow '${workflow.id}' is marked internal; internal workflows were removed (no composition engine). Remove the visibility declaration from workflows.json.`, { workflow: workflow.id, pack: pack.manifest.id });
  }

  // Cross-check every workflow step tool against the contract table.
  for (const step of workflow.steps) {
    if (!getContract(step.tool)) {
      throw new McpUiError("UNKNOWN_TOOL", `Workflow '${workflow.id}' references unknown tool '${step.tool}'.`, { workflow: workflow.id, tool: step.tool });
    }
  }

  const pipelineInput: PipelineInput = {
    steps: workflow.steps.map((s) => ({
      id: s.id,
      tool: s.tool,
      args: s.args ?? {},
      exports: s.exports,
      expect: s.expect,
      retry: s.retry,
      captureBefore: s.captureBefore,
      ignoreCodes: s.ignoreCodes
    })),
    finally: workflow.finally,
    captureBefore: workflow.captureBefore,
    restore: workflow.restore,
    maxTotalMs: 120_000
  };

  return runPipeline(pipelineInput, ctx);
}
