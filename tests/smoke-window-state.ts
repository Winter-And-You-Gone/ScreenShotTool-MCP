import assert from "node:assert/strict";

import { closeApp, getWindowState, launchApp } from "../src/windows.js";
import { testExePath } from "./helpers.js";

const exePath = await testExePath();

console.log("=== Test 1: get_window_state on normal window ===");
const r = await launchApp({ exePath, waitForWindow: true, timeoutMs: 10000 });
try {
  assert.ok(r.window, "window should be discovered");
  const state = await getWindowState({ hwnd: r.window.hwnd });
  console.log("  state:", JSON.stringify(state, null, 2));

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
} finally {
  await closeApp(r.pid).catch(() => undefined);
}

console.log("\n✅ All window state smoke tests passed.");
