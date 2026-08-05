// VaporView explicit foregroundDemo smoke (run once).
//
// Proves that ONLY an explicit interactionMode=foregroundDemo puts the app in
// the foreground, and that the previous foreground window is restored when
// the demo pipeline finishes:
//   1. record the current foreground (via the background launch report),
//   2. run a short demo pipeline (launch + open menu) with foregroundDemo,
//   3. the run reports targetActivated + foregroundChanged + restored,
//   4. after the run, the foreground is back to the original window.
//
// Exit codes: 0 PASS, 1 FAIL, 77 SKIPPED (private pack / executable absent).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";

import { startServer, initialize, callTool } from "./mcp-client.js";

const PACK_DIR = path.resolve("local-app-packs", "vaporview");
if (!existsSync(path.join(PACK_DIR, "manifest.json"))) {
  console.log("SKIPPED: local-app-packs/vaporview is not installed (private pack).");
  process.exit(77);
}

type Interaction = {
  requestedMode: string;
  effectiveMode: string;
  foregroundBefore?: string;
  foregroundAfter?: string;
  foregroundChanged: boolean;
  foregroundRestored?: boolean;
  targetActivated: boolean;
  physicalCursorMoved: boolean;
};

async function main() {
  const { child, client } = startServer();
  try {
    await initialize(client);

    // 0. Baseline: the pack defaults to background (a plain launch must NOT
    //    touch the foreground) - the demo mode only happens when explicit.
    const baseline = (await callTool(client, "profile_launch", { profile: "vaporview" }, 90000)) as {
      success?: boolean; pid?: number; code?: string; message?: string; interaction?: Interaction;
    };
    if (baseline.success === false && baseline.code === "PROFILE_NOT_FOUND" && /resolve an executable/.test(baseline.message ?? "")) {
      console.log("SKIPPED: VaporView executable not resolvable (set VAPORVIEW_EXE).");
      process.exit(77);
    }
    assert.notEqual(baseline.success, false, `baseline launch failed: ${JSON.stringify(baseline)}`);
    assert.equal(baseline.interaction?.effectiveMode, "background");
    const originalForeground = baseline.interaction?.foregroundAfter;
    console.log(`baseline background launch: PASS (foreground=${originalForeground})`);

    // 1. Explicit foregroundDemo pipeline: launch (activates) + open menu;
    //    the previous foreground must be restored when the run finishes.
    const demo = (await callTool(client, "profile_run_steps", {
      profile: "vaporview",
      interactionMode: "foregroundDemo",
      foregroundDemo: { restorePreviousForeground: true, stepDelayMs: 150 },
      steps: [{ id: "openMenu", control: "titleBarMenuButton", action: "openMenu" }]
    }, 120000)) as {
      success: boolean;
      interaction?: Interaction;
      steps: Array<{ tool: string; success: boolean; result?: { interaction?: Interaction } }>;
      error?: { code?: string; message?: string };
    };
    assert.equal(demo.success, true, `foregroundDemo pipeline failed: ${JSON.stringify(demo.error)}`);
    assert.equal(demo.interaction?.requestedMode, "foregroundDemo");
    assert.equal(demo.interaction?.effectiveMode, "foregroundDemo");
    assert.equal(demo.interaction?.targetActivated, true, "foregroundDemo must activate the target window");
    assert.equal(demo.interaction?.foregroundChanged, true, "foregroundDemo must bring the target to the foreground");
    assert.equal(demo.interaction?.foregroundRestored, true, "foregroundDemo must restore the previous foreground window by default");
    if (originalForeground !== undefined && demo.interaction?.foregroundBefore !== undefined) {
      assert.equal(demo.interaction.foregroundBefore, originalForeground, "the demo must save the pre-demo foreground window");
    }
    if (demo.interaction?.foregroundBefore !== undefined && demo.interaction?.foregroundAfter !== undefined) {
      assert.equal(demo.interaction.foregroundAfter, demo.interaction.foregroundBefore, "after the demo the foreground must be the original window");
    }
    // The launch step inside the pipeline activated the app (visible on top).
    const launchStep = demo.steps.find((s) => s.tool === "profile_launch");
    if (launchStep) {
      assert.equal(launchStep.result?.interaction?.targetActivated, true);
    }
    console.log(`foregroundDemo pipeline: PASS (foregroundChanged=${demo.interaction.foregroundChanged}, restored=${demo.interaction.foregroundRestored})`);

    // 2. The default (background) mode is untouched by the demo: a plain
    //    launch still stays background and sees the restored foreground.
    const after = (await callTool(client, "profile_launch", { profile: "vaporview" }, 60000)) as { interaction?: Interaction };
    assert.equal(after.interaction?.effectiveMode, "background");
    assert.equal(after.interaction?.foregroundChanged, false);
    if (originalForeground !== undefined && after.interaction?.foregroundBefore !== undefined) {
      assert.equal(after.interaction.foregroundBefore, originalForeground, "foreground must be back to the original window after the demo");
    }
    console.log("foreground restored after demo: PASS");

    // 3. Cleanup: close the menu (posted escape, no foreground needed).
    if (baseline.pid) {
      await callTool(client, "send_key", { pid: baseline.pid, key: "escape", noActivate: true }, 10000).catch(() => undefined);
    }

    console.log("\nsmoke:vaporview-foreground-demo: PASS");
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
