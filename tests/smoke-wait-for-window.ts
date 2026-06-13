import assert from "node:assert/strict";

import { closeApp, launchApp, listWindows, waitForWindow } from "../src/windows.js";
import { testExePath } from "./helpers.js";

const exePath = await testExePath();

console.log("=== Test 1: wait_for_window appear (already-open) ===");
{
  // Launch synchronously, then assert wait_for_window returns immediately.
  const r = await launchApp({ exePath, waitForWindow: true, timeoutMs: 10000 });
  try {
    const t0 = Date.now();
    const result = await waitForWindow({
      pid: r.pid,
      mode: "appear",
      timeoutMs: 5000,
      pollIntervalMs: 100
    });
    const elapsed = Date.now() - t0;
    console.log("  found:", result.found, "elapsedMs:", result.elapsedMs, "(host elapsed:", elapsed, ")");
    assert.equal(result.found, true);
    assert.equal(result.mode, "appear");
    assert.ok(result.window, "window should be returned");
    assert.equal(result.window!.pid, r.pid);
  } finally {
    await closeApp(r.pid).catch(() => undefined);
  }
}

console.log("\n=== Test 2: wait_for_window appear (timeout) ===");
{
  const t0 = Date.now();
  const result = await waitForWindow({
    titleContains: "this-title-definitely-does-not-exist-zzzzz",
    mode: "appear",
    timeoutMs: 800,
    pollIntervalMs: 100
  });
  const elapsed = Date.now() - t0;
  console.log("  found:", result.found, "elapsedMs:", result.elapsedMs, "(host elapsed:", elapsed, ")");
  assert.equal(result.found, false);
  assert.equal(result.window, null);
  assert.ok(result.elapsedMs >= 700, "should wait at least until timeout");
}

console.log("\n=== Test 3: wait_for_window disappear ===");
{
  const r = await launchApp({ exePath, waitForWindow: true, timeoutMs: 10000 });
  // Confirm window exists first.
  const visBefore = await listWindows({ pid: r.pid });
  assert.ok(visBefore.length > 0, "window should be visible before close");

  // Schedule a close in the background.
  setTimeout(() => {
    closeApp(r.pid).catch(() => undefined);
  }, 300);

  const t0 = Date.now();
  const result = await waitForWindow({
    pid: r.pid,
    mode: "disappear",
    timeoutMs: 10000,
    pollIntervalMs: 100
  });
  const elapsed = Date.now() - t0;
  console.log("  found:", result.found, "elapsedMs:", result.elapsedMs, "(host elapsed:", elapsed, ")");
  assert.equal(result.found, true);
  assert.equal(result.mode, "disappear");
  assert.equal(result.window, null);
}

console.log("\n✅ All wait_for_window smoke tests passed.");
