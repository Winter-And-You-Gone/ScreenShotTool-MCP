// Private App Pack smoke driver (generic entry point - no app-specific data).
//
// Reads only environment variables (spec section 21.4):
//   SCREENSHOT_MCP_TEST_PACK   - the private pack id to exercise
//   SCREENSHOT_MCP_APP_PACK_DIRS - additional pack source dirs (path-separated)
//   SCREENSHOT_MCP_TEST_EXE    - optional exe path override (passed to
//                                profile_launch exePath)
//
// Exercises the private pack through PUBLIC MCP capabilities only:
//   app_pack_list/describe/validate/reload, workflow_catalog, run_workflow
//   (every tested workflow), profile_run_steps, validate_steps, run_steps
//   with named steps + exports + expect, continue_run preconditions
//   (RUN_PROCESS_EXITED), and the no-physical-mouse invariant (no step result
//   reports physicalCursorMoved:true).
//
// Exit codes: 0 PASS, 1 FAIL, 77 SKIPPED (test pack not configured/loaded).
import assert from "node:assert/strict";

import { startServer, initialize, callTool } from "./mcp-client.js";

const PACK = process.env.SCREENSHOT_MCP_TEST_PACK;
const EXE = process.env.SCREENSHOT_MCP_TEST_EXE;
const PACK_DIRS = process.env.SCREENSHOT_MCP_APP_PACK_DIRS;

if (!PACK) {
  console.log("SKIPPED: SCREENSHOT_MCP_TEST_PACK is not set.");
  process.exit(77);
}

const serverArgs: string[] = [];
if (PACK_DIRS) {
  serverArgs.push("--app-pack-dir", PACK_DIRS.split(";").filter(Boolean)[0]!);
}

type WorkflowReport = { id: string; success: boolean; error?: unknown; steps: number };

async function main() {
  const { child, client } = startServer(serverArgs);
  try {
    await initialize(client);

    // 1. The pack is loaded from an external directory.
    const list = (await callTool(client, "app_pack_list", {})) as { packs: Array<{ id: string; source: string; valid: boolean }> };
    const pack = list.packs.find((p) => p.id === PACK);
    if (!pack) {
      console.error(`FAIL: pack '${PACK}' is not loaded. Loaded: ${list.packs.map((p) => p.id).join(", ")}`);
      process.exit(1);
    }
    console.log(`app_pack_list: ${PACK} source=${pack.source} valid=${pack.valid}`);

    // 2. Describe + validate + reload.
    const desc = (await callTool(client, "app_pack_describe", { pack: PACK })) as {
      version: string; controls: unknown[]; workflows: Array<{ id: string }>; limitations: string[];
    };
    console.log(`app_pack_describe: ${desc.controls.length} controls, ${desc.workflows.length} workflows, ${desc.limitations.length} limitations`);
    const v = (await callTool(client, "app_pack_validate", { pack: PACK })) as { valid: boolean; errors: unknown[]; warnings: unknown[] };
    console.log(`app_pack_validate: valid=${v.valid} errors=${v.errors.length} warnings=${v.warnings.length}`);
    if (!v.valid) {
      console.error("FAIL: pack validation errors:", JSON.stringify(v.errors, null, 2));
      process.exit(1);
    }
    const reload = (await callTool(client, "app_pack_reload", {})) as { reloaded: boolean };
    assert.equal(reload.reloaded, true);
    console.log("app_pack_reload: PASS");

    // 3. workflow_catalog + run every tested workflow.
    const wc = (await callTool(client, "workflow_catalog", { pack: PACK })) as {
      workflows: Array<{ id: string; tested: boolean; requiredInputs: string[] }>;
    };
    const tested = wc.workflows.filter((w) => w.tested);
    console.log(`workflow_catalog: ${tested.length}/${wc.workflows.length} tested workflows to run`);

    const reports: WorkflowReport[] = [];
    for (const wf of tested) {
      const inputs: Record<string, unknown> = {};
      if (wf.requiredInputs.includes("control")) inputs.control = "sidebarTemperature";
      if (wf.requiredInputs.includes("text")) inputs.text = "private-pack-marker";
      const r = (await callTool(client, "run_workflow", { pack: PACK, workflow: wf.id, inputs }, 180000)) as {
        success: boolean; steps: Array<{ tool: string; success: boolean; result?: { physicalCursorMoved?: boolean } }>;
        error?: { code?: string; message?: string };
      };
      reports.push({ id: wf.id, success: r.success, error: r.error, steps: r.steps.length });
      console.log(`  run_workflow ${wf.id}: ${r.success ? "PASS" : `FAIL ${r.error?.code ?? ""} ${r.error?.message ?? ""}`} (${r.steps} steps)`);
      // No-physical-mouse invariant.
      const moved = r.steps.some((s) => s.result?.physicalCursorMoved === true);
      if (moved) {
        console.error(`  FAIL: ${wf.id} reports physicalCursorMoved=true`);
        process.exit(1);
      }
    }
    const failedWorkflows = reports.filter((r) => !r.success);
    if (failedWorkflows.length > 0) {
      console.error(`FAIL: ${failedWorkflows.length} tested workflow(s) failed.`);
      process.exit(1);
    }

    // 4. profile_run_steps with a {control, action} step (server injects pid).
    const prs = (await callTool(client, "profile_run_steps", {
      profile: PACK,
      steps: [
        { id: "openMenu", control: "titleBarMenuButton", action: "openMenu" }
      ]
    }, 120000)) as { success: boolean; profile: string; pid: number; steps: Array<{ tool: string }> };
    if (prs.success) {
      assert.equal(prs.profile, PACK);
      assert.equal(typeof prs.pid, "number");
      assert.ok(prs.steps.every((s) => s.tool === "profile_action"));
      console.log(`profile_run_steps: PASS (pid=${prs.pid})`);
    } else {
      console.error(`profile_run_steps: step failed - ${JSON.stringify((prs as { error?: unknown }).error ?? (prs as { steps?: unknown }).steps)}`);
      process.exit(1);
    }

    // 5. validate_steps + run_steps with named steps, exports and expect.
    const vs = (await callTool(client, "validate_steps", {
      pack: PACK,
      steps: [
        { id: "app", tool: "profile_launch", args: { profile: PACK, ...(EXE ? { exePath: EXE } : {}) }, exports: { pid: "pid", hwnd: "hwnd" } },
        { id: "menu", tool: "profile_action", args: { profile: PACK, pid: "${app.pid}", control: "titleBarMenuButton", action: "openMenu" }, exports: { items: "result.itemCount" } },
        { id: "closeMenu", tool: "send_key", args: { pid: "${app.pid}", key: "escape", noActivate: true } }
      ]
    })) as { valid: boolean; errors: Array<{ code: string; message: string }> };
    if (!vs.valid) {
      console.error("validate_steps unexpected errors:", JSON.stringify(vs.errors, null, 2));
      process.exit(1);
    }
    const run = (await callTool(client, "run_steps", {
      steps: [
        { id: "app", tool: "profile_launch", args: { profile: PACK, ...(EXE ? { exePath: EXE } : {}) }, exports: { pid: "pid", hwnd: "hwnd" } },
        { id: "menu", tool: "profile_action", args: { profile: PACK, pid: "${app.pid}", control: "titleBarMenuButton", action: "openMenu" }, exports: { items: "result.itemCount" } },
        { id: "closeMenu", tool: "send_key", args: { pid: "${app.pid}", key: "escape", noActivate: true } }
      ]
    }, 180000)) as {
      success: boolean; runId: string; exports: Record<string, unknown>; completedSteps: string[];
      error?: { code?: string; message?: string };
    };
    if (!run.success) {
      console.error("run_steps failed:", JSON.stringify(run.error ?? run));
      process.exit(1);
    }
    assert.equal(typeof run.exports.pid, "number");
    assert.equal(typeof run.exports.items, "number", "menu item count exported");
    assert.deepEqual(run.completedSteps, ["app", "menu", "closeMenu"]);
    console.log(`run_steps named+exports: PASS (items=${run.exports.items})`);

    // 6. continue_run precondition: kill the app, then continuing a run that
    //    needs it reports RUN_PROCESS_EXITED (the process-alive check).
    const launch = (await callTool(client, "run_steps", {
      steps: [
        { id: "app", tool: "profile_launch", args: { profile: PACK, ...(EXE ? { exePath: EXE } : {}) }, exports: { pid: "pid" } }
      ]
    })) as { success: boolean; runId: string; exports: { pid: number } };
    assert.equal(launch.success, true);
    const pid = launch.exports.pid;
    await callTool(client, "close_app", { pid });
    await new Promise((r) => setTimeout(r, 800));
    const cont = (await callTool(client, "continue_run", {
      runId: launch.runId,
      continueFrom: 0
    })) as { success: boolean; error?: { code?: string } };
    assert.equal(cont.success, false);
    assert.equal(cont.error?.code, "RUN_PROCESS_EXITED");
    console.log("continue_run RUN_PROCESS_EXITED precondition: PASS");

    console.log(`\nsmoke-private-pack (${PACK}): PASS`);
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
