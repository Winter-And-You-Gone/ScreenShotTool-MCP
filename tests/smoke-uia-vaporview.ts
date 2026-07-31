import assert from "node:assert/strict";
import { access, constants as fsConstants } from "node:fs/promises";

import {
  inspectUiTree,
  queryUi,
  getUiElement,
  waitForUi,
  launchApp,
  closeApp
} from "../src/windows.js";
import { profileList, resolveProfileControl } from "../src/profiles/registry.js";

const exePath = process.env.VAPORVIEW_EXE;
const args = process.env.VAPORVIEW_ARGS ? process.env.VAPORVIEW_ARGS.split(" ") : [];

if (!exePath) {
  console.log("SKIPPED: VAPORVIEW_EXE is not set. Set it to the VaporView.exe path to run this smoke test.");
  console.log("Example: $env:VAPORVIEW_EXE='T:\\VaporView\\VaporView.exe'; npm run smoke:uia-vaporview");
  process.exit(0);
}

// Path must exist.
try {
  await access(exePath, fsConstants.X_OK);
} catch {
  console.error(`FAIL: VAPORVIEW_EXE path does not exist or is not executable: ${exePath}`);
  process.exit(1);
}

console.log(`Launching VaporView: ${exePath} ${args.join(" ")}`);
const launched = await launchApp({
  exePath,
  args,
  waitForWindow: true,
  timeoutMs: 30000,
  noActivate: true
});

let exitCode = 0;
const pid = launched.pid;
const startedByUs = new Set<number>([pid]);

try {
  assert.ok(pid > 0, "VaporView pid should be positive");
  assert.ok(launched.window, "VaporView main window should be discovered");
  console.log(`VaporView launched: pid=${pid} hwnd=${launched.window?.hwnd} title=${launched.window?.title}`);

  // 1. ui_inspect_tree returns nodes.
  const tree = await inspectUiTree({
    pid,
    maxDepth: 8,
    maxNodes: 800,
    includeProcessPopups: true,
    timeoutMs: 30000
  });
  console.log(`inspect_tree: ${tree.nodes.length} nodes, ${tree.roots.length} roots, truncated=${tree.truncated}, ${tree.elapsedMs}ms`);
  assert.ok(tree.nodes.length > 0, "VaporView should expose UIA nodes");

  // 2. Identify the Qt framework.
  const qtNodes = tree.nodes.filter((n) => n.frameworkId === "Qt");
  console.log(`Qt-framework nodes: ${qtNodes.length}`);
  if (qtNodes.length === 0) {
    console.log("DIAGNOSTIC: no Qt-framework nodes found. VaporView may expose a different FrameworkId, or the UIA bridge is not loaded.");
  }

  // 3. Identify at least one interactive control.
  const interactive = tree.nodes.filter((n) => {
    const pats = n.patterns || [];
    return pats.some((p) => p.includes("Invoke") || p.includes("Toggle") || p.includes("Value") || p.includes("SelectionItem"));
  });
  console.log(`Interactive controls (with patterns): ${interactive.length}`);
  if (interactive.length === 0) {
    console.log("ADAPTATION LIMIT: VaporView exposes no controls with standard UIA patterns in this tree slice. Custom-painted Qt widgets may be inaccessible.");
  }

  // 4. Try the VaporView profile: resolve mainWindow.
  const profiles = profileList();
  assert.ok(profiles.profiles.some((p) => p.id === "vaporview"), "vaporview profile should be registered");
  try {
    const resolved = await resolveProfileControl({
      profile: "vaporview",
      control: "mainWindow",
      pid,
      timeoutMs: 15000
    });
    console.log(`profile_resolve mainWindow: found=${resolved.found} candidateIndex=${resolved.candidateIndex ?? "n/a"} candidatesTried=${resolved.candidatesTried.length}`);
    if (!resolved.found) {
      console.log("ADAPTATION LIMIT: mainWindow profile selector did not resolve against the live tree. Source-derived selectors may need adjustment - run ui_inspect_tree to confirm.");
    }
  } catch (e) {
    console.log(`profile_resolve mainWindow error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 5. ui_wait: verify the window stays present (exists) for a short window.
  const w = await waitForUi({
    pid,
    selector: { controlType: "Window" },
    condition: "exists",
    timeoutMs: 2000,
    pollIntervalMs: 200
  });
  console.log(`ui_wait exists: matched=${w.matched} elapsed=${w.elapsedMs}ms`);

  // 6. Identify same-PID popups (dialogs/menus). We don't trigger any here to
  // avoid side effects; just report how many top-level windows the PID has.
  console.log(`Same-PID top-level windows in tree roots: ${tree.roots.length} (isMain=1, popups=${tree.roots.length - 1})`);

  console.log("\nVaporView UIA smoke test completed. No dangerous actions were performed.");
} catch (e) {
  exitCode = 1;
  console.error("VAPORVIEW SMOKE TEST FAILED:", e instanceof Error ? e.message : String(e));
  console.error("(If this is a UIA access error, ensure the MCP server runs at the SAME integrity level as VaporView, which requires administrator elevation.)");
} finally {
  // Close only the process we started. Do NOT close any pre-existing
  // VaporView the user may have had open.
  for (const p of startedByUs) {
    await closeApp(p).catch(() => undefined);
  }
  console.log(`Cleaned up started process pid=${pid}.`);
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log("smoke:uia-vaporview PASSED");
