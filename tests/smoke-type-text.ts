import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { captureWindow, clickWindow, closeApp, launchApp, typeText } from "../src/windows.js";
import { testExePath } from "./helpers.js";

const exePath = await testExePath();
const launched = await launchApp({
  exePath,
  args: [],
  waitForWindow: true,
  timeoutMs: 10000,
});

try {
  assert.ok(launched.pid > 0, "notepad pid should be positive");
  assert.ok(launched.window, "notepad window should be discovered");
  console.log(`Notepad launched. PID=${launched.pid}, hwnd=${launched.window.hwnd}, title="${launched.window.title}"`);

  // Step 1: click on the text input area (roughly center-left of the window)
  const clickX = 50;
  const clickY = 50;
  const clickResult = await clickWindow({
    hwnd: launched.window.hwnd,
    x: clickX,
    y: clickY,
    button: "left",
    doubleClick: false,
    delayMs: 300,
  });
  console.log(`Clicked at (${clickX}, ${clickY}): ${clickResult.clicked}, method=${clickResult.method}`);
  assert.ok(clickResult.clicked);

  // Step 2: type "111"
  const typeResult = await typeText({
    hwnd: launched.window.hwnd,
    text: "111",
    delayMs: 50,
    pressMs: 30,
  });
  console.log(`Typed "${"111"}", ${typeResult.textLength} characters`);
  assert.equal(typeResult.typed, true);
  assert.equal(typeResult.textLength, 3);

  // Step 3: take a screenshot to verify
  const screenshot = await captureWindow({
    hwnd: launched.window.hwnd,
    region: { x: 0, y: 0, width: Math.min(400, launched.window.rect.width), height: Math.min(300, launched.window.rect.height) },
  });
  const ssStats = await stat(screenshot.path);
  assert.ok(ssStats.size > 0, "screenshot should not be empty");
  console.log(`Screenshot saved: ${screenshot.path} (${ssStats.size} bytes)`);

  console.log(JSON.stringify({
    pid: launched.pid,
    window: launched.window,
    clicked: clickResult.clicked,
    typed: typeResult.typed,
    screenshot: screenshot.path,
  }, null, 2));
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
