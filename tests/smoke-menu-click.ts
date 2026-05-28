import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { captureWindow, clickWindow, closeApp, launchApp, typeText } from "../src/windows.js";

const exePath = "C:\\Windows\\System32\\notepad.exe";
const launched = await launchApp({
  exePath,
  args: [],
  waitForWindow: true,
  timeoutMs: 10000,
});

try {
  assert.ok(launched.pid > 0);
  assert.ok(launched.window);
  console.log(`Notepad 启动。标题="${launched.window.title}"`);

  // 步骤1: 用窗口消息模拟鼠标点击输入区，不移动主机鼠标
  const inputX = 150;
  const inputY = 150;
  console.log(`\n步骤1: 模拟鼠标点击输入区 (${inputX}, ${inputY})`);
  const click = await clickWindow({
    hwnd: launched.window.hwnd,
    x: inputX,
    y: inputY,
    button: "left",
    doubleClick: false,
    delayMs: 300,
  });
  console.log(`  结果: clicked=${click.clicked}, method=${click.method}`);
  assert.ok(click.clicked);

  // 步骤2: 输入 "111"
  console.log(`\n步骤2: 输入 "111"`);
  const typeResult = await typeText({
    hwnd: launched.window.hwnd,
    text: "111",
    delayMs: 50,
    pressMs: 30,
  });
  console.log(`  结果: typed=${typeResult.typed}, textLength=${typeResult.textLength}`);
  assert.equal(typeResult.typed, true);
  assert.equal(typeResult.textLength, 3);

  // 截图
  const screenshot = await captureWindow({
    hwnd: launched.window.hwnd,
    region: { x: 0, y: 0, width: Math.min(400, launched.window.rect.width), height: Math.min(300, launched.window.rect.height) },
  });
  const ssStats = await stat(screenshot.path);
  assert.ok(ssStats.size > 0);
  console.log(`\n截图: ${screenshot.path} (${ssStats.size} bytes)`);
  console.log(`\n✅ 全部步骤完成，截图保存在 ${screenshot.path}`);
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
