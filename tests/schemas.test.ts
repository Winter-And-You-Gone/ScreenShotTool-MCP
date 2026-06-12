import assert from "node:assert/strict";
import test from "node:test";

import {
  captureScreenRegionSchema,
  captureWindowSchema,
  clickMenuItemSchema,
  clickWindowSchema,
  closeAppSchema,
  launchAppSchema,
  listWindowsSchema,
  moveMouseWindowSchema,
  sendKeySchema,
  typeTextSchema
} from "../src/schemas.js";
import { ensureOutputPath, getDefaultOutputDir, launchApp } from "../src/windows.js";

test("launch_app requires a non-empty exePath and accepts defaults", () => {
  const parsed = launchAppSchema.parse({ exePath: "C:\\Windows\\System32\\notepad.exe" });

  assert.equal(parsed.waitForWindow, true);
  assert.equal(parsed.timeoutMs, 10000);
  assert.deepEqual(parsed.args, []);
});

test("schemas reject invalid capture dimensions", () => {
  assert.throws(() => captureScreenRegionSchema.parse({
    region: { x: 0, y: 0, width: 0, height: 100 }
  }));

  assert.throws(() => captureWindowSchema.parse({
    pid: 1234,
    region: { x: 0, y: 0, width: 100, height: -1 }
  }));
});

test("capture_window requires at least one target selector", () => {
  assert.throws(() => captureWindowSchema.parse({
    region: { x: 0, y: 0, width: 100, height: 100 }
  }));
});

test("click_window requires a target and accepts click defaults", () => {
  const parsed = clickWindowSchema.parse({
    titleContains: "VaporView",
    x: 10,
    y: 20
  });

  assert.equal(parsed.button, "left");
  assert.equal(parsed.doubleClick, false);
  assert.equal(parsed.delayMs, 200);
  assert.throws(() => clickWindowSchema.parse({ x: 10, y: 20 }));
});

test("move_mouse_window requires a target and accepts move defaults", () => {
  const parsed = moveMouseWindowSchema.parse({
    titleContains: "VaporView",
    x: 10,
    y: 20
  });

  assert.equal(parsed.delayMs, 200);
  assert.throws(() => moveMouseWindowSchema.parse({ x: 10, y: 20 }));
});

test("ensureOutputPath creates png paths in the default output directory", async () => {
  const first = await ensureOutputPath();
  const second = await ensureOutputPath();

  assert.match(first, /\.png$/i);
  assert.match(second, /\.png$/i);
  assert.notEqual(first, second);
  assert.equal(first.startsWith(getDefaultOutputDir()), true);
});

test("ensureOutputPath rejects non-png output", async () => {
  await assert.rejects(() => ensureOutputPath("C:\\Temp\\capture.jpg"), /must end with \.png/);
});

test("ensureOutputPath rejects relative output paths", async () => {
  await assert.rejects(() => ensureOutputPath("outputs\\capture.png"), /absolute path/);
});

test("launch_app rejects missing exePath", () => {
  assert.throws(() => launchAppSchema.parse({}));
});

test("launch_app rejects negative timeout", () => {
  assert.throws(() => launchAppSchema.parse({
    exePath: "C:\\test.exe",
    timeoutMs: -1
  }));
});

test("launch_app rejects a missing cwd before spawning", async () => {
  await assert.rejects(() => launchApp({
    exePath: "C:\\Windows\\System32\\notepad.exe",
    args: [],
    cwd: "C:\\definitely-missing-screenshottool-cwd",
    waitForWindow: false,
    timeoutMs: 10000
  }), /cwd does not exist/);
});

test("list_windows accepts empty object and all filter combos", () => {
  const parsed = listWindowsSchema.parse({});
  assert.equal(parsed.pid, undefined);
  assert.equal(parsed.processName, undefined);
  assert.equal(parsed.titleContains, undefined);

  const withPid = listWindowsSchema.parse({ pid: 1234 });
  assert.equal(withPid.pid, 1234);

  const withName = listWindowsSchema.parse({ processName: "notepad" });
  assert.equal(withName.processName, "notepad");

  const withTitle = listWindowsSchema.parse({ titleContains: "test" });
  assert.equal(withTitle.titleContains, "test");
});

test("close_app requires pid and rejects invalid", () => {
  const parsed = closeAppSchema.parse({ pid: 5678 });
  assert.equal(parsed.pid, 5678);

  assert.throws(() => closeAppSchema.parse({}));
  assert.throws(() => closeAppSchema.parse({ pid: 0 }));
  assert.throws(() => closeAppSchema.parse({ pid: -1 }));
});

test("type_text requires text and target selector", () => {
  assert.throws(() => typeTextSchema.parse({ text: "hello" }));

  const parsed = typeTextSchema.parse({ hwnd: "123", text: "hello" });
  assert.equal(parsed.text, "hello");
  assert.equal(parsed.delayMs, 50);
  assert.equal(parsed.pressMs, 30);
});

test("send_key requires key and target selector", () => {
  assert.throws(() => sendKeySchema.parse({ key: "f" }));

  const parsed = sendKeySchema.parse({ hwnd: "123", key: "f" });
  assert.equal(parsed.key, "f");
  assert.deepEqual(parsed.modifiers, []);
  assert.equal(parsed.delayMs, 50);
});

test("send_key accepts modifiers and validates enum", () => {
  const parsed = sendKeySchema.parse({ hwnd: "123", key: "f", modifiers: ["alt", "ctrl"] });
  assert.deepEqual(parsed.modifiers, ["alt", "ctrl"]);

  assert.throws(() => sendKeySchema.parse({ hwnd: "123", key: "f", modifiers: ["super"] }));
});

test("send_key accepts supported key values and rejects ambiguous strings", () => {
  assert.equal(sendKeySchema.parse({ hwnd: "123", key: "A" }).key, "A");
  assert.equal(sendKeySchema.parse({ hwnd: "123", key: "!" }).key, "!");
  assert.equal(sendKeySchema.parse({ hwnd: "123", key: "enter" }).key, "enter");

  assert.throws(() => sendKeySchema.parse({ hwnd: "123", key: "hello" }));
  assert.throws(() => sendKeySchema.parse({ hwnd: "123", key: "é" }));
});

test("capture_window accepts hwnd as number and string", () => {
  const byNum = captureWindowSchema.parse({ hwnd: 123456 });
  assert.equal(byNum.hwnd, 123456);

  const byStr = captureWindowSchema.parse({ hwnd: "123456" });
  assert.equal(byStr.hwnd, "123456");
});

test("capture_window accepts focus false for transient UI screenshots", () => {
  const parsed = captureWindowSchema.parse({ hwnd: "123456", focus: false });
  assert.equal(parsed.focus, false);
});

test("click_window validates button without cursor mode options", () => {
  const parsed = clickWindowSchema.parse({
    hwnd: "123",
    x: 10,
    y: 20
  });
  assert.equal(parsed.button, "left");

  assert.throws(() => clickWindowSchema.parse({
    hwnd: "123",
    x: 10,
    y: 20,
    button: "x"
  }));
});

test("click_menu_item requires a target and menu path", () => {
  const parsed = clickMenuItemSchema.parse({
    hwnd: "123",
    path: ["帮助", "关于"]
  });

  assert.deepEqual(parsed.path, ["帮助", "关于"]);
  assert.equal(parsed.delayMs, 500);
  assert.throws(() => clickMenuItemSchema.parse({ hwnd: "123", path: [] }));
  assert.throws(() => clickMenuItemSchema.parse({ path: ["帮助"] }));
});

test("launch_app accepts startMinimized and defaults to false", () => {
  const without = launchAppSchema.parse({ exePath: "C:\\Windows\\System32\\notepad.exe" });
  assert.equal(without.startMinimized, false);

  const withFlag = launchAppSchema.parse({
    exePath: "C:\\Windows\\System32\\notepad.exe",
    startMinimized: true
  });
  assert.equal(withFlag.startMinimized, true);
});

test("capture_window accepts captureMethod and defaults to screen", () => {
  const fallback = captureWindowSchema.parse({ hwnd: "1" });
  assert.equal(fallback.captureMethod, "screen");

  const print = captureWindowSchema.parse({ hwnd: "1", captureMethod: "print" });
  assert.equal(print.captureMethod, "print");

  assert.throws(() => captureWindowSchema.parse({ hwnd: "1", captureMethod: "invalid" }));
});

test("noActivate defaults to false on launch_app, capture_window, type_text, send_key", () => {
  assert.equal(launchAppSchema.parse({ exePath: "C:\\x.exe" }).noActivate, false);
  assert.equal(captureWindowSchema.parse({ hwnd: "1" }).noActivate, false);
  assert.equal(typeTextSchema.parse({ hwnd: "1", text: "a" }).noActivate, false);
  assert.equal(sendKeySchema.parse({ hwnd: "1", key: "a" }).noActivate, false);
});
