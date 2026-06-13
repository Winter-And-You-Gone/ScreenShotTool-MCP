import assert from "node:assert/strict";

import { closeApp, getWindowState, launchApp, sendKey } from "../src/windows.js";
import { testExePath } from "./helpers.js";

const exePath = await testExePath();

console.log("=== Test 1: get_window_state on normal window ===");
const r = await launchApp({ exePath, waitForWindow: true, timeoutMs: 10000 });
try {
  assert.ok(r.window, "window should be discovered");
  const state = await getWindowState({ hwnd: r.window.hwnd });

  assert.equal(state.hwnd, r.window.hwnd);
  assert.equal(state.visible, true);
  assert.equal(state.minimized, false);
  assert.equal(state.maximized, false);
  assert.equal(state.enabled, true);
  assert.equal(state.foreground, true, "launched window should be foreground");
  assert.equal(state.cloaked, false);
  assert.equal(state.alpha, 255, "normal window alpha=255");
  assert.ok(state.style.startsWith("0x"), "style should be hex");
  assert.ok(state.exStyle.startsWith("0x"), "exStyle should be hex");
  console.log("  normal state OK");

  // Maximize the window via Win+Up shortcut and verify state changes.
  console.log("\n=== Test 2: get_window_state on maximized window ===");
  await sendKey({ hwnd: r.window.hwnd, key: "up", modifiers: ["win"] });
  // Give the OS a moment to process the maximize.
  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  const maxState = await getWindowState({ hwnd: r.window.hwnd });
  console.log("  maximized:", maxState.maximized, "minimized:", maxState.minimized);
  assert.equal(maxState.maximized, true, "window should be maximized after Win+Up");
  assert.equal(maxState.minimized, false);
  assert.equal(maxState.visible, true);
  console.log("  maximized state OK");
} finally {
  await closeApp(r.pid).catch(() => undefined);
}

console.log("\n✅ All window state smoke tests passed.");
