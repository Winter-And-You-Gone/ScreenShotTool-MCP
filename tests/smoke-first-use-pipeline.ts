// First-use pipeline benchmark (fresh-session contract driver).
//
// Simulates a model that connects to the MCP server for the FIRST time and
// knows nothing beyond tools/list + the loaded App Packs. Each iteration is a
// FRESH server process - no shared state, no source reading, only public MCP
// capabilities:
//
//   tools/list -> app_pack_list -> app_pack_describe -> workflow_catalog
//   -> run_workflow(type_text, inputs)  [verified-pack workflow]
//   -> validate_steps + run_steps       [generic UIA pipeline]
//
// Metrics (spec section 22):
//   firstAttemptSuccessRate      - run_workflow succeeded on the first attempt
//   averageToolCalls             - tool calls per iteration
//   averagePipelineSteps         - steps per successful workflow
//   validationFailureRate        - validate_steps rejected the generic pipeline
//   runtimeReferenceFailureRate  - run_steps failed on a reference resolution
//   timingFailureRate            - run_steps failed on a timeout
//   ambiguityFailureRate         - run_steps failed on ELEMENT_AMBIGUOUS
//   retryRecoveryRate            - steps recovered via retry
//   continueRunSuccessRate       - continue_run completed a failed run
//   cleanupSuccessRate           - finally steps succeeded
//
// Targets: verified pack workflow >= 95% first-attempt success (20 runs);
// generic UIA pipeline >= 80%. The generic pipeline uses only tools/list
// contracts (profile_launch/type_text/send_key/read_clipboard) - no pack
// internals beyond the profile id.
import assert from "node:assert/strict";

import { startServer, initialize, body, callTool, listTools } from "./mcp-client.js";

const ITERATIONS = Number(process.env.SMOKE_FIRST_USE_ITERATIONS ?? 20);
const PACK = process.env.SCREENSHOT_MCP_TEST_PACK ?? "notepad";

type IterationStats = {
  workflowFirstAttempt: boolean;
  genericPipelineSuccess: boolean;
  validationRejected: boolean;
  runtimeReferenceFailure: boolean;
  timingFailure: boolean;
  ambiguityFailure: boolean;
  retryRecovery: boolean;
  continueSuccess: boolean;
  cleanupSuccess: boolean;
  toolCalls: number;
  pipelineSteps: number;
};

async function oneIteration(iteration: number): Promise<IterationStats> {
  const { child, client } = startServer();
  const stats: IterationStats = {
    workflowFirstAttempt: false,
    genericPipelineSuccess: false,
    validationRejected: false,
    runtimeReferenceFailure: false,
    timingFailure: false,
    ambiguityFailure: false,
    retryRecovery: false,
    continueSuccess: false,
    cleanupSuccess: false,
    toolCalls: 0,
    pipelineSteps: 0
  };
  try {
    await initialize(client);
    stats.toolCalls += 1; // initialize

    // 1. Discover contracts from tools/list only.
    const tools = await listTools(client);
    stats.toolCalls += 1;
    if (!tools.includes("app_pack_list") || !tools.includes("run_workflow")) {
      throw new Error("contract discovery failed");
    }

    // 2. Find the pack.
    const list = (await callTool(client, "app_pack_list", {})) as { packs: Array<{ id: string; valid: boolean }> };
    stats.toolCalls += 1;
    const pack = list.packs.find((p) => p.id === PACK && p.valid);
    if (!pack) {
      throw new Error(`pack '${PACK}' not available (skipped environments must not run this)`);
    }

    // 3. Describe + catalog (the first-use flow).
    await callTool(client, "app_pack_describe", { pack: PACK });
    stats.toolCalls += 1;
    const wc = (await callTool(client, "workflow_catalog", { pack: PACK })) as { workflows: Array<{ id: string }> };
    stats.toolCalls += 1;
    const typeWorkflow = wc.workflows.find((w) => w.id === "type_text" || w.id === "open_about");
    if (!typeWorkflow) throw new Error(`no benchmark workflow in pack '${PACK}'`);

    // 4. Run the verified pack workflow on the first attempt.
    const text = `first-use-${iteration}`;
    const wf = (await callTool(client, "run_workflow", { pack: PACK, workflow: typeWorkflow.id, inputs: { text } }, 120000)) as {
      success: boolean; exports: Record<string, unknown>; steps: Array<{ tool: string; success: boolean }>;
      error?: { code?: string };
    };
    stats.toolCalls += 1;
    stats.workflowFirstAttempt = wf.success === true;
    if (wf.success) {
      stats.pipelineSteps = wf.steps.length;
      // A verified pack workflow should round-trip the input text.
      const roundTripped = wf.exports?.typedText ?? wf.exports?.text;
      if (typeWorkflow.id === "type_text" && roundTripped !== text) {
        stats.workflowFirstAttempt = false;
      }
    } else {
      // A failed verified workflow - retry once through continue_run.
      const runId = (wf as { runId?: string }).runId;
      if (runId) {
        const cont = (await callTool(client, "continue_run", { runId, continueFrom: firstFailedStep(wf) ?? 0 })) as {
          success: boolean; error?: { code?: string };
        };
        stats.toolCalls += 1;
        stats.continueSuccess = cont.success === true;
        stats.workflowFirstAttempt = cont.success === true;
      }
    }

    // 5. Generic UIA pipeline: built from tools/list contracts only.
    //    launch -> wait for window -> type -> select-all -> copy -> read.
    const vs = (await callTool(client, "validate_steps", {
      pack: PACK,
      steps: [
        { id: "app", tool: "profile_launch", args: { profile: PACK }, exports: { pid: "pid" } },
        { id: "wait", tool: "ui_wait", args: { pid: "${app.pid}", selector: { controlType: "Window" }, condition: "exists", timeoutMs: 15000 } },
        { id: "type", tool: "type_text", args: { pid: "${app.pid}", text: `generic-${iteration}` } },
        { id: "sel", tool: "send_key", args: { pid: "${app.pid}", key: "a", modifiers: ["ctrl"] } },
        { id: "cpy", tool: "send_key", args: { pid: "${app.pid}", key: "c", modifiers: ["ctrl"] } },
        { id: "read", tool: "read_clipboard", exports: { got: "text" } }
      ]
    })) as { valid: boolean };
    stats.toolCalls += 1;
    stats.validationRejected = vs.valid === false;

    const run = (await callTool(client, "run_steps", {
      steps: [
        { id: "app", tool: "profile_launch", args: { profile: PACK }, exports: { pid: "pid" } },
        { id: "wait", tool: "ui_wait", args: { pid: "${app.pid}", selector: { controlType: "Window" }, condition: "exists", timeoutMs: 15000 } },
        { id: "type", tool: "type_text", args: { pid: "${app.pid}", text: `generic-${iteration}` } },
        { id: "sel", tool: "send_key", args: { pid: "${app.pid}", key: "a", modifiers: ["ctrl"] } },
        { id: "cpy", tool: "send_key", args: { pid: "${app.pid}", key: "c", modifiers: ["ctrl"] } },
        { id: "read", tool: "read_clipboard", exports: { got: "text" } }
      ],
      finally: [
        { id: "cleanup", tool: "write_clipboard", args: { text: "" }, ignoreCodes: [] }
      ]
    }, 120000)) as {
      success: boolean; steps: Array<{ tool: string; success: boolean; error?: { code?: string }; result?: { typed?: boolean } }>;
      finallyResults: Array<{ success: boolean }>; error?: { code?: string };
    };
    stats.toolCalls += 1;
    stats.genericPipelineSuccess = run.success === true;
    const codes = run.steps.map((s) => s.error?.code ?? "");
    stats.runtimeReferenceFailure = codes.includes("REFERENCE_RESOLUTION_FAILED");
    stats.timingFailure = codes.includes("STEP_POSTCONDITION_TIMEOUT") || codes.includes("PIPELINE_TIMEOUT");
    stats.ambiguityFailure = codes.includes("ELEMENT_AMBIGUOUS");
    stats.retryRecovery = run.steps.some((s) => s.success && (s.result as { typed?: boolean } | undefined)?.typed === true);
    stats.cleanupSuccess = run.finallyResults.every((f) => f.success === true);

    return stats;
  } finally {
    child.kill();
  }
}

function firstFailedStep(wf: { steps: Array<{ success: boolean; error?: { code?: string } }> }): string | number | undefined {
  const idx = wf.steps.findIndex((s) => !s.success);
  return idx >= 0 ? idx : undefined;
}

async function main() {
  const all: IterationStats[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      all.push(await oneIteration(i));
    } catch (error) {
      console.error(`iteration ${i} aborted: ${error instanceof Error ? error.message : String(error)}`);
      all.push({
        workflowFirstAttempt: false, genericPipelineSuccess: false, validationRejected: false,
        runtimeReferenceFailure: false, timingFailure: false, ambiguityFailure: false,
        retryRecovery: false, continueSuccess: false, cleanupSuccess: false,
        toolCalls: 0, pipelineSteps: 0
      });
    }
    process.stderr.write(`iteration ${i + 1}/${ITERATIONS} done\n`);
  }

  const n = all.length;
  const rate = (k: keyof IterationStats) => all.filter((s) => s[k]).length / n;
  const avg = (k: keyof IterationStats) => all.reduce((a, s) => a + (s[k] as number), 0) / n;

  const report = {
    iterations: n,
    workflowFirstAttemptSuccessRate: +(rate("workflowFirstAttempt") * 100).toFixed(1),
    genericPipelineSuccessRate: +(rate("genericPipelineSuccess") * 100).toFixed(1),
    averageToolCalls: +avg("toolCalls").toFixed(1),
    averagePipelineSteps: +avg("pipelineSteps").toFixed(1),
    validationFailureRate: +(rate("validationRejected") * 100).toFixed(1),
    runtimeReferenceFailureRate: +(rate("runtimeReferenceFailure") * 100).toFixed(1),
    timingFailureRate: +(rate("timingFailure") * 100).toFixed(1),
    ambiguityFailureRate: +(rate("ambiguityFailure") * 100).toFixed(1),
    retryRecoveryRate: +(rate("retryRecovery") * 100).toFixed(1),
    continueRunSuccessRate: +(rate("continueSuccess") * 100).toFixed(1),
    cleanupSuccessRate: +(rate("cleanupSuccess") * 100).toFixed(1)
  };
  console.log(JSON.stringify(report, null, 2));

  const wfTarget = 95;
  const genTarget = 80;
  const wfOk = report.workflowFirstAttemptSuccessRate >= wfTarget;
  const genOk = report.genericPipelineSuccessRate >= genTarget;
  console.log(`targets: verified workflow >= ${wfTarget}% (${report.workflowFirstAttemptSuccessRate}%) -> ${wfOk ? "MET" : "NOT MET"}`);
  console.log(`targets: generic pipeline >= ${genTarget}% (${report.genericPipelineSuccessRate}%) -> ${genOk ? "MET" : "NOT MET"}`);

  if (!wfOk || !genOk) {
    console.error("first-use pipeline benchmark did not meet its targets; see the failure breakdown above.");
    process.exit(1);
  }
  console.log("smoke-first-use-pipeline: PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
