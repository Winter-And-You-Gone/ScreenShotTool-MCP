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
  assert.ok(launched.window, "notepad window should be discovered");

  const full = await captureWindow({
    hwnd: launched.window.hwnd,
    captureMethod: "print"
  });
  const fullStats = await stat(full.path);
  assert.ok(fullStats.size > 4096, `print full capture should be non-trivial (got ${fullStats.size} bytes)`);
  assert.equal(full.width, launched.window.rect.width);
  assert.equal(full.height, launched.window.rect.height);

  const region = await captureWindow({
    hwnd: launched.window.hwnd,
    captureMethod: "print",
    region: { x: 0, y: 0, width: Math.min(200, full.width), height: Math.min(150, full.height) }
  });
  const regionStats = await stat(region.path);
  assert.ok(regionStats.size > 1024, `print region capture should be non-trivial (got ${regionStats.size} bytes)`);
  assert.equal(region.width, Math.min(200, full.width));
  assert.equal(region.height, Math.min(150, full.height));

  console.log(JSON.stringify({
    hwnd: launched.window.hwnd,
    full: { path: full.path, bytes: fullStats.size, w: full.width, h: full.height },
    region: { path: region.path, bytes: regionStats.size, w: region.width, h: region.height }
  }, null, 2));
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
