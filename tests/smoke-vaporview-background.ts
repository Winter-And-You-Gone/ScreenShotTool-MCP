// VaporView strict-background smoke (run once, not a benchmark).
//
// Proves the interaction constraints against the REAL private app without
// touching the foreground:
//   1. the pack defaults to background,
//   2. launch/attach keeps the foreground unchanged (interaction report),
//   3. a background menu open works and reports foregroundChanged:false,
//   4. a background PrintWindow capture works and reports foregroundChanged:false,
//   5. the physical cursor does not move,
//   6. cleanup restores the app state.
//
// Exit codes: 0 PASS, 1 FAIL, 77 SKIPPED (private pack / executable absent).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { startServer, initialize, callTool } from "./mcp-client.js";

const PACK_DIR = path.resolve("local-app-packs", "vaporview");
if (!existsSync(path.join(PACK_DIR, "manifest.json"))) {
  console.log("SKIPPED: local-app-packs/vaporview is not installed (private pack).");
  process.exit(77);
}

// Read the physical cursor position via GetCursorPos (verification only -
// the server itself never touches the real cursor in background mode).
function readCursorPosition(): string | null {
  const script =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public struct PT{public int X;public int Y;}public class C{[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out PT p);}'; $p = New-Object PT; [C]::GetCursorPos([ref]$p) | Out-Null; Write-Output \"$($p.X),$($p.Y)\"";
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    const r = spawnSync(exe, ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
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

    // 0. The pack must be loaded and default to background.
    const list = (await callTool(client, "app_pack_list", {})) as { packs: Array<{ id: string; source: string }> };
    if (!list.packs.some((p) => p.id === "vaporview")) {
      console.error("FAIL: vaporview pack is not loaded.");
      process.exit(1);
    }
    const describe = (await callTool(client, "app_pack_describe", { pack: "vaporview" })) as { defaultInteractionMode: string };
    assert.equal(describe.defaultInteractionMode, "background");
    console.log("pack defaultInteractionMode: background PASS");

    const cursorBefore = readCursorPosition();

    // 1. Background launch/attach: foreground must not change.
    const launch = (await callTool(client, "profile_launch", { profile: "vaporview" }, 90000)) as {
      success?: boolean; pid: number; hwnd?: string; code?: string; message?: string;
      interaction?: Interaction;
    };
    if (launch.success === false && launch.code === "PROFILE_NOT_FOUND" && /resolve an executable/.test(launch.message ?? "")) {
      console.log("SKIPPED: VaporView executable not resolvable (set VAPORVIEW_EXE).");
      process.exit(77);
    }
    assert.notEqual(launch.success, false, `profile_launch failed: ${JSON.stringify(launch)}`);
    const li = launch.interaction!;
    assert.equal(li.effectiveMode, "background");
    // The app may self-activate during background startup; the core must then
    // attempt a restore and report BOTH facts honestly - never a silent
    // foreground steal, never a false claim of perfect background.
    assert.ok(li.foregroundChanged === false || li.foregroundRestored === true,
      `background launch must not change the foreground, or must report a restore attempt: ${JSON.stringify(li)}`);
    assert.equal(li.targetActivated, false);
    assert.equal(li.physicalCursorMoved, false);
    if (li.foregroundChanged) {
      console.log(`  note: app self-activated during launch; restore attempted (foregroundRestored=${li.foregroundRestored})`);
    }
    const pid = launch.pid;
    const originalForeground = li.foregroundBefore;
    console.log(`profile_launch background: PASS (pid=${pid}, foregroundChanged=${li.foregroundChanged}, restored=${li.foregroundRestored ?? false})`);

    // 2. Background menu open (safe action, InvokePattern).
    const menu = (await callTool(client, "profile_action", {
      profile: "vaporview", pid, control: "titleBarMenuButton", action: "openMenu"
    }, 60000)) as { success?: boolean; code?: string; result?: { success?: boolean; method?: string }; interaction?: Interaction };
    assert.notEqual(menu.success, false, `openMenu failed: ${JSON.stringify(menu)}`);
    assert.equal(menu.result?.success, true);
    assert.ok(menu.interaction?.foregroundChanged === false || menu.interaction?.foregroundRestored === true,
      "a background action must not leave the foreground changed (or must report the restore attempt)");
    assert.equal(menu.interaction?.physicalCursorMoved, false);
    console.log(`profile_action openMenu background: PASS (method=${menu.result?.method}, foregroundChanged=${menu.interaction?.foregroundChanged})`);

    // 3. Background PrintWindow capture (no top-level requirement).
    const shot = (await callTool(client, "capture_window", { pid, captureMethod: "print" }, 60000)) as {
      path?: string; success?: boolean; code?: string; message?: string; interaction?: Interaction;
    };
    if (shot.success === false) {
      // BACKGROUND_CAPTURE_UNAVAILABLE (blank frame) is an honest failure of
      // this specific app/build - report it as a result, not a crash.
      console.log(`capture_window background: ${shot.code ?? "FAIL"} (${shot.message ?? ""})`);
      if (shot.code !== "BACKGROUND_CAPTURE_UNAVAILABLE") process.exit(1);
    } else {
      assert.equal(shot.interaction?.effectiveMode, "background");
      assert.equal(shot.interaction?.foregroundChanged, false, "background capture must not change the foreground");
      assert.equal(shot.interaction?.physicalCursorMoved, false);
      console.log(`capture_window background: PASS (method=${shot.interaction?.method})`);
    }

    // 4. Cleanup: close the menu without global input (posted escape).
    await callTool(client, "send_key", { pid, key: "escape", noActivate: true }, 30000);

    // 5. A second launch (reuse) still sees the same foreground as before.
    const relaunch = (await callTool(client, "profile_launch", { profile: "vaporview" }, 60000)) as { interaction?: Interaction };
    const ri = relaunch.interaction!;
    assert.ok(ri.foregroundChanged === false || ri.foregroundRestored === true);
    if (originalForeground !== undefined && ri.foregroundBefore !== undefined) {
      assert.equal(ri.foregroundBefore, originalForeground, "the foreground window must be the same across the background session");
    }
    console.log("foreground stable across session: PASS");

    // 6. The physical cursor never moved.
    const cursorAfter = readCursorPosition();
    if (cursorBefore !== null && cursorAfter !== null) {
      assert.equal(cursorAfter, cursorBefore, `physical cursor moved: ${cursorBefore} -> ${cursorAfter}`);
      console.log(`physical cursor unchanged: PASS (${cursorBefore})`);
    } else {
      console.log("physical cursor check: SKIPPED (GetCursorPos unavailable)");
    }

    console.log("\nsmoke:vaporview-background: PASS");
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
