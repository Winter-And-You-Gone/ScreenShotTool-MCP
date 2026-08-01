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

  // 1b. Zero-result contracts: query/get return found:false, action throws ELEMENT_NOT_FOUND.
  const missingQuery = await queryUi({
    pid,
    selector: { automationId: `missing-control-${Date.now()}` },
    timeoutMs: 5000
  });
  assert.equal(missingQuery.found, false);
  assert.equal(missingQuery.count, 0);
  assert.deepEqual(missingQuery.elements, []);
  console.log("query zero-result: found=false");

  const missingGet = await getUiElement({
    pid,
    selector: { automationId: `missing-control-${Date.now()}` },
    timeoutMs: 5000
  });
  assert.equal(missingGet.found, false);
  assert.equal(missingGet.element, null);
  console.log("get zero-result: found=false");

  await assert.rejects(
    () => performUiAction({
      pid,
      selector: { automationId: `missing-control-${Date.now()}` },
      action: "invoke",
      allowCoordinateFallback: false,
      timeoutMs: 5000
    }),
    (error: unknown) => {
      assert.ok(error instanceof HelperError);
      assert.equal(error.code, "ELEMENT_NOT_FOUND");
      return true;
    }
  );
  console.log("action zero-result: ELEMENT_NOT_FOUND");

  // 1c. Ambiguity: bare controlType Button usually matches multiple title-bar buttons.
  // ui_get must refuse multi-match without index; ui_query may return many.
  const buttons = await queryUi({
    pid,
    selector: { controlType: "Button" },
    maxResults: 20,
    timeoutMs: 10000
  });
  console.log(`button query count=${buttons.count}`);
  if (buttons.count >= 2) {
    await assert.rejects(
      () => getUiElement({
        pid,
        selector: { controlType: "Button" },
        timeoutMs: 10000
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelperError);
        assert.equal(error.code, "ELEMENT_AMBIGUOUS");
        return true;
      }
    );
    const indexed = await getUiElement({
      pid,
      selector: { controlType: "Button", index: 1 },
      timeoutMs: 10000
    });
    assert.equal(indexed.found, true);
    console.log("ambiguity + index>=1: ELEMENT_AMBIGUOUS then indexed get succeeds");
  } else {
    console.log("DIAGNOSTIC: fewer than 2 Button controls; skipping ambiguity/index live check");
  }

  // 1d. ui_wait exists should match even when multiple Window roots exist; timedOut false.
  const existsWait = await waitForUi({
    pid,
    selector: { controlType: "Window" },
    condition: "exists",
    timeoutMs: 2000,
    pollIntervalMs: 100
  });
  assert.equal(existsWait.matched, true);
  assert.equal(existsWait.timedOut, false);
  console.log(`ui_wait exists: matched=${existsWait.matched} timedOut=${existsWait.timedOut}`);

  // 1e. A missing element on a live process is a normal notExists match.
  const absentWait = await waitForUi({
    pid,
    selector: { automationId: `missing-control-${Date.now()}` },
    condition: "notExists",
    timeoutMs: 2000,
    pollIntervalMs: 100
  });
  assert.equal(absentWait.matched, true);
  assert.equal(absentWait.timedOut, false);
  console.log(`ui_wait element notExists: matched=${absentWait.matched} timedOut=${absentWait.timedOut}`);

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

  // 6. Invoke the Close button (action test). WordPad may pop a save-changes
  // dialog since we wrote text; dismiss it best-effort so the process exits.
  // We do NOT ui_wait notExists on controlType:Window here - once the window
  // closes the resolver raises WINDOW_NOT_FOUND, which by contract must
  // propagate (not be swallowed as a match). Element-level notExists on a live
  // window is already covered by step 1e.
  try {
    const closeAct = await performUiAction({
      pid,
      selector: { controlType: "Button", automationId: "Close" },
      action: "invoke",
      allowCoordinateFallback: false,
      timeoutMs: 10000
    });
    if (closeAct.success) {
      console.log(`Invoked Close button via ${closeAct.method}`);
    }
  } catch (e) {
    if (e instanceof HelperError) {
      console.log(`Close-button invoke skipped: ${e.code}`);
    }
  }

  // Dismiss a possible save-changes dialog (best-effort cleanup).
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
      // best-effort; closeApp in finally handles the rest
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
