import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { captureWindow, clickWindow, closeApp, launchApp, readClipboard, sendKey, typeText, writeClipboard } from "../src/windows.js";
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

  // Step 1: click inside the editor area, below the title/menu/toolbar chrome.
  const clickX = 140;
  const clickY = 170;
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
  assert.equal(typeResult.skipped.length, 0, "no characters should be skipped");

  // Step 3: select all (Ctrl+A) and copy (Ctrl+C), then read clipboard
  // to verify the text was actually received by the window.
  // Clear clipboard first so stale content doesn't pass.
  await writeClipboard({ text: "" });
  await sendKey({ hwnd: launched.window.hwnd, key: "a", modifiers: ["ctrl"], delayMs: 200 });
  await sendKey({ hwnd: launched.window.hwnd, key: "c", modifiers: ["ctrl"], delayMs: 200 });
  const clipboardResult = await readClipboard();
  assert.equal(clipboardResult.available, true, "clipboard should contain copied text after Ctrl+A/Ctrl+C");
  assert.ok(clipboardResult.text.includes("111"), `clipboard should contain "111", got: ${JSON.stringify(clipboardResult.text)}`);
  console.log(`Clipboard verification passed: "${clipboardResult.text}"`);

  // Step 4: take a screenshot to verify
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
    skipped: typeResult.skipped,
    screenshot: screenshot.path,
  }, null, 2));
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
