import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { captureWindow, closeApp, launchApp } from "../src/windows.js";
import { testExePath } from "./helpers.js";

const exePath = await testExePath();
const launched = await launchApp({
  exePath,
  args: [],
  waitForWindow: true,
  timeoutMs: 10000
});

try {
  assert.ok(launched.pid > 0, "notepad pid should be positive");
  assert.ok(launched.window, "notepad window should be discovered");

  const fullWindow = await captureWindow({ hwnd: launched.window.hwnd });
  const fullStats = await stat(fullWindow.path);
  assert.ok(fullStats.size > 0, "full-window screenshot should not be empty");

  const region = await captureWindow({
    hwnd: launched.window.hwnd,
    region: { x: 0, y: 0, width: Math.min(300, fullWindow.width), height: Math.min(200, fullWindow.height) }
  });
  const regionStats = await stat(region.path);
  assert.ok(regionStats.size > 0, "region screenshot should not be empty");

  console.log(JSON.stringify({ pid: launched.pid, window: launched.window, screenshots: [fullWindow.path, region.path] }, null, 2));
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
