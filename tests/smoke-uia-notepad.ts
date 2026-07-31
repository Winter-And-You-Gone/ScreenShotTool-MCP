import assert from "node:assert/strict";
import { access, constants as fsConstants } from "node:fs/promises";

import {
  inspectUiTree,
  queryUi,
  getUiElement,
  performUiAction,
  waitForUi,
  launchApp,
  closeApp,
  HelperError
} from "../src/windows.js";

// A system GUI app with a stable UIA tree. WordPad exposes a RICHEDIT50W
// Document with ValuePattern (cleanest setValue/get path). Falls back to
// notepad.exe if WordPad is absent.
async function pickExe(): Promise<string> {
  const wordpad = "C:/Program Files/Windows NT/Accessories/wordpad.exe";
  try {
    await access(wordpad, fsConstants.X_OK);
    return wordpad;
  } catch {
    return "C:/Windows/System32/notepad.exe";
  }
}

// Record physical cursor position before/after to prove the test never moved
// the real mouse. Uses GetCursorPos via a tiny PowerShell script file to
// avoid quoting pain in -Command.
async function getPhysicalCursorPos(): Promise<{ x: number; y: number }> {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const script = join(tmpdir(), `screenshottool-cursor-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(script, `
Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace ScreenshotToolCursor {
  public static class C {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  }
}
"@
$p = New-Object ScreenshotToolCursor+C+POINT
[ScreenshotToolCursor+C]::GetCursorPos([ref]$p) | Out-Null
"$($p.X),$($p.Y)"
`);
  try {
    const res = spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    const [x, y] = (res.stdout.trim() || "0,0").split(",").map((s) => Number.parseInt(s, 10));
    return { x: Number.isNaN(x) ? 0 : x, y: Number.isNaN(y) ? 0 : y };
  } finally {
    try { unlinkSync(script); } catch { /* ignore */ }
  }
}

async function getForegroundHwnd(): Promise<string> {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const script = join(tmpdir(), `screenshottool-fg-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(script, `
Add-Type "using System; using System.Runtime.InteropServices; namespace ScreenshotToolFg { public static class C { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); } }"
[ScreenshotToolFg+C]::GetForegroundWindow().ToInt64().ToString()
`);
  try {
    const res = spawnSync("pwsh.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8" });
    return res.stdout.trim() || "0";
  } finally {
    try { unlinkSync(script); } catch { /* ignore */ }
  }
}

const exePath = await pickExe();
const beforeCursor = await getPhysicalCursorPos();
const beforeForeground = await getForegroundHwnd();

const launched = await launchApp({
  exePath,
  args: [],
  waitForWindow: true,
  timeoutMs: 15000,
  noActivate: true
});

let exitCode = 0;
try {
  assert.ok(launched.pid > 0, "launched pid should be positive");
  assert.ok(launched.window, "main window should be discovered");
  const pid = launched.pid;

  // 1. ui_inspect_tree returns nodes.
  const tree = await inspectUiTree({ pid, maxDepth: 5, maxNodes: 200, includeProcessPopups: true, timeoutMs: 15000 });
  assert.ok(tree.nodes.length > 0, "inspect tree should return nodes");
  assert.ok(tree.roots.length >= 1, "at least one root window");
  assert.equal(typeof tree.elapsedMs, "number");
  console.log(`inspect_tree: ${tree.nodes.length} nodes, ${tree.roots.length} roots, ${tree.elapsedMs}ms`);

  // 2. Find an editable control (Document for WordPad; Edit/Document for notepad).
  // Try Document first, then Edit.
  let editSelector = { controlType: "Document" as const };
  let found: { found: boolean; element: unknown } = { found: false, element: null };
  try {
    found = await getUiElement({ pid, selector: editSelector, timeoutMs: 10000 });
  } catch (e) {
    // not found is fine, ambiguity is not expected
  }
  if (!found.found) {
    editSelector = { controlType: "Edit" as const };
    try {
      found = await getUiElement({ pid, selector: editSelector, timeoutMs: 10000 });
    } catch (e) {
      // ignore - will be handled below
    }
  }

  if (found.found) {
    // 3. setValue via ValuePattern (WordPad). For notepad/Scintilla without
    // ValuePattern, this throws PATTERN_NOT_SUPPORTED - we catch and skip.
    const element = found.element as { patterns?: string[]; value?: string | null };
    const hasValuePattern = (element.patterns || []).some((p) => p.includes("ValuePattern"));
    if (hasValuePattern) {
      const act = await performUiAction({
        pid,
        selector: editSelector,
        action: "setValue",
        value: "Hello from UIA smoke test",
        allowCoordinateFallback: false
      });
      assert.equal(act.success, true, "setValue should succeed via ValuePattern");
      assert.equal(act.method, "ValuePattern");

      // 4. Read the value back.
      const after = await getUiElement({ pid, selector: editSelector, timeoutMs: 10000 });
      const afterEl = after.element as { value?: string | null };
      assert.ok(typeof afterEl.value === "string");
      assert.ok(afterEl.value!.includes("Hello from UIA smoke test"), "value should contain written text");
      console.log(`setValue OK, value=${JSON.stringify(afterEl.value!.slice(0, 40))}...`);
    } else {
      console.log("Edit control lacks ValuePattern (e.g. Scintilla) - skipping setValue");
    }
  } else {
    console.log("No Document/Edit control found - skipping setValue");
  }

  // 5. Find a Button with InvokePattern and invoke it. WordPad exposes
  // Minimize/Maximize/Close (automationId). Invoking Close closes the window.
  // To keep the test going, we invoke Minimize then wait, then restore is not
  // needed. Actually closing is the cleanest cleanup. We invoke Close last.
  // First, prove we can find a button.
  try {
    const closeBtn = await getUiElement({ pid, selector: { controlType: "Button", automationId: "Close" }, timeoutMs: 10000 });
    if (closeBtn.found) {
      // Don't click Close yet - we want to test ui_wait first.
      console.log("Found Close button (InvokePattern available)");
    }
  } catch (e) {
    // WordPad not present; that's fine.
  }

  // 6. ui_wait: close the window via Close button, then wait for notExists.
  let closedViaUia = false;
  try {
    const closeAct = await performUiAction({
      pid,
      selector: { controlType: "Button", automationId: "Close" },
      action: "invoke",
      allowCoordinateFallback: false,
      timeoutMs: 10000
    });
    if (closeAct.success) {
      closedViaUia = true;
      console.log(`Invoked Close button via ${closeAct.method}`);
    }
  } catch (e) {
    if (e instanceof HelperError) {
      console.log(`Close-button invoke skipped: ${e.code}`);
    }
  }

  if (closedViaUia) {
    // 7. Wait for the window to disappear. WordPad may pop a save-changes
    // dialog; if so, the Window still "exists" - countEquals not needed, we
    // just wait a short time and accept either outcome.
    const w = await waitForUi({
      pid,
      selector: { controlType: "Window" },
      condition: "notExists",
      timeoutMs: 4000,
      pollIntervalMs: 200
    });
    console.log(`ui_wait notExists: matched=${w.matched} elapsed=${w.elapsedMs}ms`);
    // If a save dialog appeared, dismiss it by closing that window too.
    if (!w.matched) {
      try {
        await performUiAction({
          pid,
          selector: { controlType: "Button", name: "不保存" },
          action: "invoke",
          allowCoordinateFallback: false,
          timeoutMs: 5000
        });
      } catch {
        try {
          await performUiAction({
            pid,
            selector: { controlType: "Button", name: "Don't Save" },
            action: "invoke",
            allowCoordinateFallback: false,
            timeoutMs: 5000
          });
        } catch {
          // best-effort
        }
      }
    }
  }
} catch (e) {
  exitCode = 1;
  console.error("SMOKE TEST FAILED:", e instanceof Error ? e.message : String(e));
} finally {
  // Always clean up the process we started.
  await closeApp(launched.pid).catch(() => undefined);

  // Verify physical cursor did not move.
  const afterCursor = await getPhysicalCursorPos();
  if (afterCursor.x !== beforeCursor.x || afterCursor.y !== beforeCursor.y) {
    console.error(`WARNING: physical cursor moved! before=(${beforeCursor.x},${beforeCursor.y}) after=(${afterCursor.x},${afterCursor.y})`);
    exitCode = 1;
  } else {
    console.log("Physical cursor unchanged - no real mouse movement.");
  }

  // Verify foreground window was not permanently changed (best-effort: allow
  // it to differ briefly during the test, but it should not be our launched
  // app which we just killed).
  const afterForeground = await getForegroundHwnd();
  if (afterForeground === (launched.window?.hwnd ?? "0")) {
    console.error("WARNING: foreground window is still the killed app.");
    exitCode = 1;
  } else {
    console.log("Foreground window not left on the killed app.");
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
console.log("smoke:uia-notepad PASSED");
