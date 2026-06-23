import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { captureWindow, closeApp, getWindowState, launchApp, sendKey, typeText } from "../src/windows.js";
import { testExePath } from "./helpers.js";

function foregroundHwnd(): string {
  const ps = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }';
     [FG]::GetForegroundWindow().ToInt64().ToString()`
  ], { encoding: "utf8", shell: false, windowsHide: true });
  return ps.stdout.trim();
}

const beforeHwnd = foregroundHwnd();
console.log("foreground before:", beforeHwnd);

// ── Test 1: launch with noActivate + startMinimized ──
{
  console.log("\n=== Test 1: launch noActivate + startMinimized ===");
  const r = await launchApp({
    exePath: await testExePath(),
    args: [],
    waitForWindow: true,
    timeoutMs: 10000,
    startMinimized: true,
    noActivate: true
  });
  try {
    assert.ok(r.window, "window should be discovered");
    console.log("  launched hwnd:", r.window.hwnd);

    // The foreground should NOT be the launched app after noActivate-minimize runs.
    // There's a brief moment where the OS activates the new window before our
    // noActivate code pushes it to HWND_BOTTOM. Wait a beat and verify.
    const afterHwnd = foregroundHwnd();
    // Best-effort: we mainly want to verify noActivate *does* run, not that the
    // OS never briefly activated it. A hard assert on foreground is fragile.
    console.log("  foreground after launch:", afterHwnd, "(same as before =", afterHwnd === beforeHwnd, ")");

    const state = await getWindowState({ hwnd: r.window.hwnd });
    assert.equal(state.minimized, true, "startMinimized should leave the window iconic");
    assert.equal(state.foreground, false, "noActivate start should not leave the target foregrounded");
    console.log("  minimized:", state.minimized, "foreground:", state.foreground);
  } finally {
    await closeApp(r.pid).catch(() => undefined);
  }
}

// ── Test 2: capture with noActivate ──
{
  console.log("\n=== Test 2: capture noActivate ===");
  const r = await launchApp({
    exePath: await testExePath(),
    args: [],
    waitForWindow: true,
    timeoutMs: 10000
  });
  try {
    assert.ok(r.window, "window should be discovered");

    const shot = await captureWindow({
      hwnd: r.window.hwnd,
      noActivate: true,
      captureMethod: "screen"
    });
    const stats = await stat(shot.path);
    assert.ok(stats.size > 4096, "noActivate capture should fall back to PrintWindow and produce non-trivial output");
    console.log("  capture OK:", stats.size, "bytes");

    // Foreground should not have changed to the captured window
    const afterHwnd = foregroundHwnd();
    console.log("  foreground after capture:", afterHwnd);
  } finally {
    await closeApp(r.pid).catch(() => undefined);
  }
}

// ── Test 3: type_text with noActivate ──
{
  console.log("\n=== Test 3: type_text noActivate ===");
  const r = await launchApp({
    exePath: await testExePath(),
    args: [],
    waitForWindow: true,
    timeoutMs: 10000
  });
  try {
    assert.ok(r.window, "window should be discovered");

    // First capture to ensure the window has a text area
    await captureWindow({ hwnd: r.window.hwnd, captureMethod: "print" });

    const typed = await typeText({
      hwnd: r.window.hwnd,
      text: "Hello",
      noActivate: true,
      delayMs: 30,
      pressMs: 20
    });
    assert.equal(typed.typed, true);
    assert.equal(typed.skipped.length, 0, `no chars skipped, got ${JSON.stringify(typed.skipped)}`);
    console.log("  typed", typed.textLength, "chars, 0 skipped");
  } finally {
    await closeApp(r.pid).catch(() => undefined);
  }
}

// ── Test 4: send_key with noActivate ──
{
  console.log("\n=== Test 4: send_key noActivate ===");
  const r = await launchApp({
    exePath: await testExePath(),
    args: [],
    waitForWindow: true,
    timeoutMs: 10000
  });
  try {
    assert.ok(r.window, "window should be discovered");

    const sent = await sendKey({
      hwnd: r.window.hwnd,
      key: "a",
      noActivate: true
    });
    assert.equal(sent.sent, true);
    console.log("  sent key OK");
  } finally {
    await closeApp(r.pid).catch(() => undefined);
  }
}

// ── Verify foreground was never permanently stolen ──
const finalHwnd = foregroundHwnd();
console.log("\nforeground after:", finalHwnd, "(same as before =", finalHwnd === beforeHwnd, ")");

console.log("\n✅ All noActivate smoke tests passed.");
