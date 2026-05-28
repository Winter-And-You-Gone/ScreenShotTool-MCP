import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { clickMenuItem, clickWindow, closeApp, launchApp, listWindows } from "../src/windows.js";

function cursorPosition(): string {
  const script = "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; [Console]::Write($p.X.ToString()+','+$p.Y.ToString())";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Failed to read cursor position.").trim());
  }

  return result.stdout.trim();
}

const launched = await launchApp({
  exePath: "C:\\Windows\\System32\\notepad.exe",
  args: [],
  waitForWindow: true,
  timeoutMs: 10000
});

try {
  assert.ok(launched.window, "notepad window should be discovered");
  const before = cursorPosition();

  const click = await clickWindow({
    hwnd: launched.window.hwnd,
    x: 120,
    y: 120,
    button: "left",
    delayMs: 100
  });
  assert.equal(click.method, "post_message");

  const menu = await clickMenuItem({
    hwnd: launched.window.hwnd,
    path: ["帮助", "关于"],
    delayMs: 500
  });
  assert.equal(menu.method, "native_menu_command");
  assert.match(menu.menuPath.at(-1)?.normalizedText ?? "", /关于|About/i);

  const windows = await listWindows({ pid: launched.pid });
  assert.ok(windows.some((window) => /关于|about/i.test(window.title)), "about dialog should be visible");

  const after = cursorPosition();
  assert.equal(after, before, "MCP mouse simulation must not move the physical cursor");

  console.log(JSON.stringify({ before, after, click, menu }, null, 2));
} finally {
  await closeApp(launched.pid).catch(() => undefined);
}
