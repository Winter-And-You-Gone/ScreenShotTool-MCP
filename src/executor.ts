// Unified tool execution outlet.
//
// EVERY tool invocation - plain tools/call, run_steps, profile_run_steps,
// run_workflow, continue_run, finally steps and restore - goes through
// executeValidatedTool:
//
//   read ToolContract → validate input → dispatch → validate output
//
// There is exactly one dispatch path, so plain calls and pipeline steps
// behave identically. Outputs that fail their outputSchema never reach the
// client, structuredContent, run snapshots, exports, or later steps: they
// raise TOOL_OUTPUT_SCHEMA_MISMATCH with structured validationErrors.
//
// Business failures (McpUiError etc.) are NOT validated against the success
// outputSchema - they propagate as-is and surface as isError results.

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { getContract } from "./contracts.js";
import { validateAgainstSchema, type ValidationError } from "./outputs.js";
import { McpUiError } from "./uia/results.js";

export type InputParseResult = { ok: true; value: unknown } | { ok: false; message: string };

export type ToolExecutorContext = {
  // Parse/validate tool input args (zod). Called with the raw args.
  parseInput: (tool: string, args: unknown) => InputParseResult;
  // Dispatch a tool with ALREADY-PARSED input.
  dispatch: (tool: string, input: unknown) => Promise<unknown>;
};

export class ToolOutputSchemaMismatchError extends McpUiError {
  readonly tool: string;
  readonly schemaVersion: number;
  readonly validationErrors: ValidationError[];
  constructor(tool: string, schemaVersion: number, validationErrors: ValidationError[]) {
    super(
      "TOOL_OUTPUT_SCHEMA_MISMATCH",
      `${tool} result failed its output schema (${validationErrors.length} error(s)); the result was discarded and not passed on.`,
      {
        tool,
        schemaVersion,
        validationErrors: validationErrors.slice(0, 20)
      }
    );
    this.tool = tool;
    this.schemaVersion = schemaVersion;
    this.validationErrors = validationErrors;
  }
}

export async function executeValidatedTool(
  toolName: string,
  args: unknown,
  ctx: ToolExecutorContext
): Promise<unknown> {
  const contract = getContract(toolName);
  if (!contract) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }

  // 1. Input validation (identical for plain calls and pipeline steps).
  const parsed = ctx.parseInput(toolName, args ?? {});
  if (!parsed.ok) {
    throw new McpError(ErrorCode.InvalidParams, parsed.message);
  }

  // 2. Dispatch. Business errors propagate untouched (they are not success
  //    values and must not be forced through the success outputSchema).
  const result = await ctx.dispatch(toolName, parsed.value);

  // 3. Output validation. A malformed SUCCESS value must never flow onward.
  const check = validateAgainstSchema(result, contract.outputSchema);
  if (!check.ok) {
    throw new ToolOutputSchemaMismatchError(toolName, contract.schemaVersion, check.errors);
  }

  return result;
}
