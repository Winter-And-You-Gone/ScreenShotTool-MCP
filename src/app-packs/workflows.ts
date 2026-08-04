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

export type WorkflowCatalogEntry = {
  id: string;
  description: string;
  safe: boolean;
  tested: boolean;
  restoresState: boolean;
  requiredInputs: string[];
  visibility: string;
};

export function listWorkflows(pack: LoadedPack, includeInternal = false): WorkflowCatalogEntry[] {
  return pack.workflows.workflows
    .filter((w) => includeInternal || (w.visibility ?? "session") !== "internal")
    .map((w) => ({
      id: w.id,
      description: w.description ?? "",
      safe: w.safe ?? false,
      tested: w.tested ?? false,
      restoresState: w.restoresState ?? false,
      requiredInputs: w.inputSchema?.required ?? [],
      visibility: w.visibility ?? "session"
    }));
}

export function getWorkflow(pack: LoadedPack, id: string): PackWorkflow | undefined {
  return pack.workflows.workflows.find((w) => w.id === id);
}

// Validate workflow inputs against its inputSchema (a simple object schema).
export function validateWorkflowInputs(workflow: PackWorkflow, inputs: unknown): string[] {
  const errors: string[] = [];
  const schema = workflow.inputSchema ?? { type: "object", properties: {}, required: [] as string[], additionalProperties: false };
  if (inputs === undefined || inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    return ["inputs must be an object"];
  }
  const record = inputs as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (record[key] === undefined) {
      errors.push(`Missing required input '${key}'.`);
    }
  }
  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(record)) {
      if (!known.has(key)) {
        errors.push(`Unknown input '${key}' (additionalProperties=false).`);
      }
    }
  }
  return errors;
}

export type RunWorkflowOptions = {
  pack: LoadedPack;
  workflow: PackWorkflow;
  inputs: Record<string, unknown>;
  profile: import("../profiles/types.js").AppProfile;
  dispatch: ExecutionContext["dispatch"];
  expectDeps: ExecutionContext["expectDeps"];
  autoContext?: ExecutionContext["autoContext"];
};

export async function runWorkflow(opts: RunWorkflowOptions): Promise<PipelineResult> {
  const { pack, workflow, inputs } = opts;

  const inputErrors = validateWorkflowInputs(workflow, inputs);
  if (inputErrors.length > 0) {
    throw new McpUiError("INVALID_WORKFLOW_INPUTS", `Workflow '${workflow.id}' inputs are invalid: ${inputErrors.join(" ")}`, { workflow: workflow.id, errors: inputErrors });
  }

  // Internal workflows can only be invoked from within the pack's own
  // workflows (enforced here: direct run_workflow calls are rejected).
  if ((workflow.visibility ?? "session") === "internal") {
    throw new McpUiError("WORKFLOW_INTERNAL", `Workflow '${workflow.id}' is marked internal; it can only be invoked by another workflow of pack '${pack.manifest.id}'.`, { workflow: workflow.id, pack: pack.manifest.id });
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

  return runPipeline(pipelineInput, {
    dispatch: opts.dispatch,
    pack: { id: pack.manifest.id, actions: pack.actions, profile: opts.profile, version: pack.manifest.version },
    inputs,
    autoContext: opts.autoContext,
    expectDeps: opts.expectDeps
  });
}
