// Fresh-process pipeline stability benchmark (contract-driven first-use
// simulation).
//
// This is a FRESH-PROCESS STABILITY benchmark and a CONTRACT-DRIVEN FIRST-USE
// SIMULATION - NOT a real-LLM autogeneration test. Each iteration spawns a
// brand-new server process and drives it through the public MCP surface
// (tools/list -> app_pack_list -> app_pack_describe -> workflow_catalog ->
// run_workflow / validate_steps + run_steps), without reading server source.
// A real model's autonomous first-attempt success rate requires separate
// evaluation with an actual model.
//
// Metrics are tracked STRICTLY SEPARATELY (spec):
//   workflowFirstAttemptSuccess - first run_workflow call succeeded
//   workflowEventuallySuccess   - succeeded after at most one continue_run
//   continueRecoverySuccess     - a failed first attempt recovered via
//                                 continue_run (NEVER counts as first attempt)
//   pipelineFirstAttemptSuccess - generic pipeline succeeded on first run
//   pipelineEventuallySuccess   - ...or after one continue_run
//   cleanupSuccessRate          - finally steps (independent)
//   validationFailureRate       - validate_steps rejected the pipeline
//   infrastructureFailureRate   - server/transport failures (NOT workflow
//                                 failures)
import assert from "node:assert/strict";

import { startServer, initialize, callTool, listTools } from "./mcp-client.js";

const ITERATIONS = Number(process.env.SMOKE_FIRST_USE_ITERATIONS ?? 20);
const PACK = process.env.SCREENSHOT_MCP_TEST_PACK ?? "notepad";

type IterationStats = {
  workflowFirstAttempt: boolean;
  workflowEventually: boolean;
  continueRecovery: boolean;
  continueAttempts: number;
  pipelineFirstAttempt: boolean;
  pipelineEventually: boolean;
  validationRejected: boolean;
  cleanup: boolean;
  infrastructureFailure: boolean;
  toolCalls: number;
  pipelineSteps: number;
};

async function oneIteration(iteration: number): Promise<IterationStats> {
  const stats: IterationStats = {
    workflowFirstAttempt: false,
    workflowEventually: false,
    continueRecovery: false,
    continueAttempts: 0,
    pipelineFirstAttempt: false,
    pipelineEventually: false,
    validationRejected: false,
    cleanup: false,
    infrastructureFailure: false,
    toolCalls: 0,
    pipelineSteps: 0
  };
  const { child, client } = startServer();
  try {
    await initialize(client);
    stats.toolCalls += 1;

    const tools = await listTools(client);
    stats.toolCalls += 1;
    if (!tools.includes("app_pack_list") || !tools.includes("run_workflow") || !tools.includes("validate_steps")) {
      stats.infrastructureFailure = true;
      return stats;
    }

    const list = (await callTool(client, "app_pack_list", {})) as { packs: Array<{ id: string; valid: boolean }> };
    stats.toolCalls += 1;
    const pack = list.packs.find((p) => p.id === PACK && p.valid);
    if (!pack) {
      stats.infrastructureFailure = true;
      return stats;
    }

    await callTool(client, "app_pack_describe", { pack: PACK });
    stats.toolCalls += 1;
    const wc = (await callTool(client, "workflow_catalog", { pack: PACK })) as { workflows: Array<{ id: string }> };
    stats.toolCalls += 1;
    const typeWorkflow = wc.workflows.find((w) => w.id === "type_text" || w.id === "open_about");
    if (!typeWorkflow) {
      stats.infrastructureFailure = true;
      return stats;
    }

    // 1. Verified pack workflow: FIRST attempt is the run_workflow call.
    const text = `first-use-${iteration}`;
    const wf = (await callTool(client, "run_workflow", { pack: PACK, workflow: typeWorkflow.id, inputs: { text } }, 120000)) as {
      success: boolean; exports: Record<string, unknown>; steps: Array<{ tool: string; success: boolean }>;
      runId?: string; error?: { code?: string };
    };
    stats.toolCalls += 1;
    stats.workflowFirstAttempt = wf.success === true;
    stats.workflowEventually = wf.success === true;
    if (wf.success) {
      stats.pipelineSteps = wf.steps.length;
      const roundTripped = wf.exports?.typedText ?? wf.exports?.text;
      if (typeWorkflow.id === "type_text" && roundTripped !== text) {
        console.error(`iteration ${iteration} workflow roundtrip mismatch: expected '${text}', got '${String(roundTripped).slice(0, 60)}'`);
        stats.workflowFirstAttempt = false;
        stats.workflowEventually = false;
      }
    } else {
      console.error(`iteration ${iteration} workflow first attempt failed: ${JSON.stringify(wf.error ?? wf).slice(0, 400)}`);
      // Retry ONCE through continue_run. A successful recovery counts toward
      // eventually + continueRecovery ONLY - never toward firstAttempt.
      const runId = wf.runId;
      if (runId) {
        stats.continueAttempts += 1;
        const cont = (await callTool(client, "continue_run", { runId, continueFrom: firstFailedStep(wf) ?? 0 })) as {
          success: boolean; error?: { code?: string };
        };
        stats.toolCalls += 1;
        stats.continueRecovery = cont.success === true;
        stats.workflowEventually = cont.success === true;
      }
    }

    // 2. Generic UIA pipeline: built from tools/list contracts only.
    const pipelineSteps = [
      { id: "app", tool: "profile_launch", args: { profile: PACK }, exports: { pid: "pid" } },
      { id: "wait", tool: "ui_wait", args: { pid: "${app.pid}", selector: { controlType: "Window" }, condition: "exists", timeoutMs: 15000 } },
      { id: "type", tool: "type_text", args: { pid: "${app.pid}", text: `generic-${iteration}` } },
      { id: "sel", tool: "send_key", args: { pid: "${app.pid}", key: "a", modifiers: ["ctrl"] } },
      { id: "cpy", tool: "send_key", args: { pid: "${app.pid}", key: "c", modifiers: ["ctrl"] } },
      { id: "read", tool: "read_clipboard", exports: { got: "text" } }
    ];
    const vs = (await callTool(client, "validate_steps", { pack: PACK, steps: pipelineSteps })) as { valid: boolean };
    stats.toolCalls += 1;
    stats.validationRejected = vs.valid === false;

    const run = (await callTool(client, "run_steps", {
      steps: pipelineSteps,
      finally: [
        { id: "cleanup", tool: "write_clipboard", args: { text: "" }, ignoreCodes: [] }
      ]
    }, 120000)) as {
      success: boolean; runId?: string; steps: Array<{ tool: string; success: boolean; error?: { code?: string } }>;
      finallyResults: Array<{ success: boolean }>; error?: { code?: string };
    };
    stats.toolCalls += 1;
    stats.pipelineFirstAttempt = run.success === true;
    stats.pipelineEventually = run.success === true;
    stats.cleanup = run.finallyResults.every((f) => f.success === true);
    if (!run.success && run.runId) {
      stats.continueAttempts += 1;
      const cont = (await callTool(client, "continue_run", { runId: run.runId, continueFrom: 0 })) as { success: boolean };
      stats.toolCalls += 1;
      stats.continueRecovery = stats.continueRecovery || cont.success === true;
      stats.pipelineEventually = cont.success === true;
    }

    return stats;
  } catch (error) {
    // Server/transport failure: NOT a workflow failure.
    console.error(`iteration ${iteration} infrastructure failure: ${error instanceof Error ? error.message : String(error)}`);
    stats.infrastructureFailure = true;
    return stats;
  } finally {
    child.kill();
  }
}

function firstFailedStep(wf: { steps: Array<{ success: boolean; error?: { code?: string } }> }): string | number | undefined {
  const idx = wf.steps.findIndex((s) => !s.success);
  return idx >= 0 ? idx : undefined;
}

// ── statistics (pure, unit-testable) ──
//
// continueRecoverySuccessRate = continueRecoverySuccessCount /
// continueAttempts (the REAL number of continue_run calls), and is `null`
// when no continue was attempted - never 0, which would read as "all
// recoveries failed".
export type BenchmarkReport = {
  iterations: number;
  workflowFirstAttemptSuccessCount: number;
  workflowFirstAttemptSuccessRate: number;
  workflowEventuallySuccessCount: number;
  workflowEventuallySuccessRate: number;
  pipelineFirstAttemptSuccessCount: number;
  pipelineFirstAttemptSuccessRate: number;
  pipelineEventuallySuccessCount: number;
  pipelineEventuallySuccessRate: number;
  continueAttempts: number;
  continueRecoverySuccessCount: number;
  continueRecoverySuccessRate: number | null;
  cleanupSuccessCount: number;
  cleanupSuccessRate: number;
  validationFailureRate: number;
  infrastructureFailureCount: number;
  averageToolCalls: number;
  averagePipelineSteps: number;
};

export function computeBenchmarkStats(all: IterationStats[]): BenchmarkReport {
  const n = all.length;
  const count = (k: keyof IterationStats) => all.filter((s) => s[k]).length;
  const rate = (k: keyof IterationStats) => count(k) / n;
  const avg = (k: keyof IterationStats) => all.reduce((a, s) => a + (s[k] as number), 0) / n;
  const continueAttempts = all.reduce((a, s) => a + s.continueAttempts, 0);
  const continueRecoverySuccessCount = count("continueRecovery");
  return {
    iterations: n,
    workflowFirstAttemptSuccessCount: count("workflowFirstAttempt"),
    workflowFirstAttemptSuccessRate: +rate("workflowFirstAttempt").toFixed(3),
    workflowEventuallySuccessCount: count("workflowEventually"),
    workflowEventuallySuccessRate: +rate("workflowEventually").toFixed(3),
    pipelineFirstAttemptSuccessCount: count("pipelineFirstAttempt"),
    pipelineFirstAttemptSuccessRate: +rate("pipelineFirstAttempt").toFixed(3),
    pipelineEventuallySuccessCount: count("pipelineEventually"),
    pipelineEventuallySuccessRate: +rate("pipelineEventually").toFixed(3),
    continueAttempts,
    continueRecoverySuccessCount,
    // denominator = actual continue attempts; null when none happened.
    continueRecoverySuccessRate: continueAttempts === 0 ? null : +(continueRecoverySuccessCount / continueAttempts).toFixed(3),
    cleanupSuccessCount: count("cleanup"),
    cleanupSuccessRate: +rate("cleanup").toFixed(3),
    validationFailureRate: +rate("validationRejected").toFixed(3),
    infrastructureFailureCount: count("infrastructureFailure"),
    averageToolCalls: +avg("toolCalls").toFixed(1),
    averagePipelineSteps: +avg("pipelineSteps").toFixed(1)
  };
}

async function main() {
  const all: IterationStats[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    all.push(await oneIteration(i));
    process.stderr.write(`iteration ${i + 1}/${ITERATIONS} done\n`);
  }

  const report = computeBenchmarkStats(all);
  console.log(JSON.stringify(report, null, 2));

  // Targets use the TRUE first-attempt rates only. A continue_run recovery
  // must never count as a first attempt.
  const wfTarget = 95;
  const genTarget = 80;
  const wfOk = report.workflowFirstAttemptSuccessRate * 100 >= wfTarget;
  const genOk = report.pipelineFirstAttemptSuccessRate * 100 >= genTarget;
  const noInfra = report.infrastructureFailureCount === 0;
  console.log(`targets (first attempt only): verified workflow >= ${wfTarget}% (${(report.workflowFirstAttemptSuccessRate * 100).toFixed(1)}%) -> ${wfOk ? "MET" : "NOT MET"}`);
  console.log(`targets (first attempt only): generic pipeline >= ${genTarget}% (${(report.pipelineFirstAttemptSuccessRate * 100).toFixed(1)}%) -> ${genOk ? "MET" : "NOT MET"}`);
  console.log(`infrastructure failures: ${report.infrastructureFailureCount} -> ${noInfra ? "OK" : "FAIL"}`);
  console.log(`continue attempts: ${report.continueAttempts}, continue recovery rate: ${report.continueRecoverySuccessRate === null ? "null (no attempts)" : report.continueRecoverySuccessRate}`);

  if (!wfOk || !genOk || !noInfra) {
    console.error("first-use benchmark did not meet its targets; see the breakdown above.");
    process.exit(1);
  }
  console.log("smoke-first-use-pipeline: PASS");
}

// Only run the benchmark when this file is executed directly (unit tests
// import computeBenchmarkStats without spawning servers).
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
