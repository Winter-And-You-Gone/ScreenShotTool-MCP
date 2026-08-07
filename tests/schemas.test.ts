import assert from "node:assert/strict";
import test from "node:test";

import {
  captureScreenRegionSchema,
  captureWindowSchema,
  chainableToolNames,
  clickMenuItemSchema,
  clickWindowSchema,
  closeAppSchema,
  launchAppSchema,
  listWindowsSchema,
  moveMouseWindowSchema,
  runStepsSchema,
  sendKeySchema,
  typeTextSchema,
  readClipboardSchema,
  writeClipboardSchema,
  getWindowStateSchema,
  toolInputSchemas,
  waitForWindowSchema
} from "../src/schemas.js";
import { ensureOutputPath, getDefaultOutputDir, launchApp } from "../src/windows.js";

test("launch_app requires a non-empty exePath and accepts defaults", () => {
  const parsed = launchAppSchema.parse({ exePath: "C:\\Windows\\System32\\notepad.exe" });

  assert.equal(parsed.waitForWindow, true);
  assert.equal(parsed.timeoutMs, 10000);
  assert.deepEqual(parsed.args, []);
});

test("schemas reject invalid capture dimensions", () => {
  assert.deepEqual(captureScreenRegionSchema.parse({
    region: { x: 0, y: 0, width: 800, height: 600 }
  }).region, { x: 0, y: 0, width: 800, height: 600 });

  assert.throws(() => captureScreenRegionSchema.parse({
    region: { x: 0, y: 0, width: 0, height: 100 }
  }));

  assert.throws(() => captureWindowSchema.parse({
    pid: 1234,
    region: { x: 0, y: 0, width: 100, height: -1 }
  }));

  assert.throws(() => captureScreenRegionSchema.parse({
    region: { x: 0, y: 0, width: 16_385, height: 100 }
  }));

  assert.throws(() => captureWindowSchema.parse({
    pid: 1234,
    region: { x: 0, y: 0, width: 16_384, height: 4097 }
  }), /area/i);
});

test("capture_window requires at least one target selector", () => {
  assert.throws(() => captureWindowSchema.parse({
    region: { x: 0, y: 0, width: 100, height: 100 }
  }));
});

test("click_window requires a target and accepts click defaults", () => {
  const parsed = clickWindowSchema.parse({
    titleContains: "ExampleApp",
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
    titleContains: "ExampleApp",
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

test("type_text rejects oversized or too-slow single requests", () => {
  assert.throws(() => typeTextSchema.parse({
    hwnd: "123",
    text: "x".repeat(1001)
  }));

  assert.throws(() => typeTextSchema.parse({
    hwnd: "123",
    text: "x".repeat(1000),
    delayMs: 50,
    pressMs: 30
  }), /Estimated type_text duration/);

  const parsed = typeTextSchema.parse({
    hwnd: "123",
    text: "x".repeat(1000),
    delayMs: 20,
    pressMs: 20
  });
  assert.equal(parsed.text.length, 1000);
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

test("capture_window accepts captureMethod and defaults to print", () => {
  const fallback = captureWindowSchema.parse({ hwnd: "1" });
  assert.equal(fallback.captureMethod, "print");

  const screen = captureWindowSchema.parse({ hwnd: "1", captureMethod: "screen" });
  assert.equal(screen.captureMethod, "screen");

  assert.throws(() => captureWindowSchema.parse({ hwnd: "1", captureMethod: "invalid" }));
});

test("noActivate defaults to false on launch_app, capture_window, type_text, send_key", () => {
  assert.equal(launchAppSchema.parse({ exePath: "C:\\x.exe" }).noActivate, false);
  assert.equal(captureWindowSchema.parse({ hwnd: "1" }).noActivate, false);
  assert.equal(typeTextSchema.parse({ hwnd: "1", text: "a" }).noActivate, false);
  assert.equal(sendKeySchema.parse({ hwnd: "1", key: "a" }).noActivate, false);
});

test("read_clipboard accepts empty input object", () => {
  const parsed = readClipboardSchema.parse({});
  assert.deepEqual(parsed, {});
});

test("write_clipboard requires text and accepts empty string", () => {
  const empty = writeClipboardSchema.parse({ text: "" });
  assert.equal(empty.text, "");

  const nonEmpty = writeClipboardSchema.parse({ text: "hello 你好\nworld" });
  assert.equal(nonEmpty.text, "hello 你好\nworld");

  assert.throws(() => writeClipboardSchema.parse({}));
});

test("write_clipboard rejects oversized payloads", () => {
  // Exactly at the cap is accepted, one character over is rejected. Keeps the
  // GlobalAlloc + Marshal.Copy path bounded so a runaway caller can't OOM
  // the worker or the clipboard.
  const atCap = writeClipboardSchema.parse({ text: "x".repeat(1_000_000) });
  assert.equal(atCap.text.length, 1_000_000);

  assert.throws(() => writeClipboardSchema.parse({ text: "x".repeat(1_000_001) }));
});

test("get_window_state requires a target selector", () => {
  assert.throws(() => getWindowStateSchema.parse({}));

  const byHwnd = getWindowStateSchema.parse({ hwnd: "12345" });
  assert.equal(byHwnd.hwnd, "12345");

  const byPid = getWindowStateSchema.parse({ pid: 1234 });
  assert.equal(byPid.pid, 1234);
});

test("wait_for_window requires a target and accepts mode + timeout defaults", () => {
  assert.throws(() => waitForWindowSchema.parse({}));

  const withDefaults = waitForWindowSchema.parse({ processName: "notepad" });
  assert.equal(withDefaults.mode, "appear");
  assert.equal(withDefaults.timeoutMs, 30_000);
  assert.equal(withDefaults.pollIntervalMs, 100);

  const disappear = waitForWindowSchema.parse({ hwnd: "1", mode: "disappear", timeoutMs: 5000 });
  assert.equal(disappear.mode, "disappear");
  assert.equal(disappear.timeoutMs, 5000);

  assert.throws(() => waitForWindowSchema.parse({ pid: 1, mode: "invalid" }));
  assert.throws(() => waitForWindowSchema.parse({ pid: 1, timeoutMs: 50 }));
  assert.throws(() => waitForWindowSchema.parse({ pid: 1, timeoutMs: 999_999 }));
});

test("schemas reject unknown fields to match additionalProperties:false", () => {
  // Typos like outputpath instead of outputPath should be surfaced loudly,
  // not silently dropped (which would route output to the default path).
  assert.throws(() => captureWindowSchema.parse({
    hwnd: "1",
    outputpath: "C:\\Temp\\foo.png"
  }), /unrecognized/i);

  assert.throws(() => captureScreenRegionSchema.parse({
    region: { x: 0, y: 0, width: 10, height: 10 },
    outputpath: "C:\\Temp\\foo.png"
  }), /unrecognized/i);

  assert.throws(() => clickWindowSchema.parse({
    hwnd: "1",
    x: 0,
    y: 0,
    extra: true
  }), /unrecognized/i);

  assert.throws(() => typeTextSchema.parse({
    hwnd: "1",
    text: "x",
    delay: 100
  }), /unrecognized/i);

  assert.throws(() => launchAppSchema.parse({
    exePath: "C:\\x.exe",
    extraField: "value"
  }), /unrecognized/i);

  assert.throws(() => readClipboardSchema.parse({
    text: "not allowed"
  }), /unrecognized/i);

  assert.throws(() => captureWindowSchema.parse({
    hwnd: "1",
    region: { x: 0, y: 0, width: 10, height: 10, extra: true }
  }), /unrecognized/i);
});

test("tool JSON schemas expose runtime selector and enum constraints", () => {
  assert.deepEqual(toolInputSchemas.capture_window.anyOf, [
    { required: ["targetRef"] },
    { required: ["hwnd"] },
    { required: ["pid"] },
    { required: ["processName"] },
    { required: ["titleContains"] }
  ]);
  assert.deepEqual(toolInputSchemas.capture_window.properties.hwnd.anyOf, [
    { type: "string" },
    { type: "integer", minimum: 1 }
  ]);
  assert.equal(toolInputSchemas.capture_window.properties.region.properties.width.maximum, 16_384);
  assert.equal(toolInputSchemas.capture_screen_region.properties.region.properties.height.maximum, 16_384);
  assert.deepEqual(toolInputSchemas.click_window.properties.button.enum, ["left", "right", "middle"]);
  // targetRef is accepted by every targetRef-aware tool and preferred over
  // pid/hwnd. Since the target-session hardening, EVERY window-target tool
  // resolves targetRef at runtime (lifecycle consistency: click_window /
  // get_window_state / type_text / ... reuse the profile_launch session
  // identity, so a stale hwnd never forces a manual relaunch).
  assert.ok(toolInputSchemas.capture_window.properties.targetRef, "capture_window accepts targetRef");
  assert.ok(toolInputSchemas.ui_query.properties.targetRef, "ui_query accepts targetRef");
  assert.ok(toolInputSchemas.profile_action.properties.targetRef, "profile_action accepts targetRef");
  assert.ok(toolInputSchemas.ui_inspect_tree.properties.targetRef, "ui_inspect_tree accepts targetRef");
  assert.ok(toolInputSchemas.ui_get.properties.targetRef, "ui_get accepts targetRef");
  assert.ok(toolInputSchemas.ui_action.properties.targetRef, "ui_action accepts targetRef");
  assert.ok(toolInputSchemas.ui_wait.properties.targetRef, "ui_wait accepts targetRef");
  assert.ok(toolInputSchemas.profile_resolve.properties.targetRef, "profile_resolve accepts targetRef");
  assert.ok(toolInputSchemas.ui_catalog.properties.targetRef, "ui_catalog accepts targetRef");
  assert.ok(toolInputSchemas.click_window.properties.targetRef, "click_window accepts targetRef");
  assert.ok(toolInputSchemas.move_mouse_window.properties.targetRef, "move_mouse_window accepts targetRef");
  assert.ok(toolInputSchemas.type_text.properties.targetRef, "type_text accepts targetRef");
  assert.ok(toolInputSchemas.send_key.properties.targetRef, "send_key accepts targetRef");
  assert.ok(toolInputSchemas.click_menu_item.properties.targetRef, "click_menu_item accepts targetRef");
  assert.ok(toolInputSchemas.get_window_state.properties.targetRef, "get_window_state accepts targetRef");
  assert.ok(toolInputSchemas.wait_for_window.properties.targetRef, "wait_for_window accepts targetRef");
  assert.deepEqual(toolInputSchemas.click_window.anyOf, [
    { required: ["targetRef"] },
    { required: ["hwnd"] },
    { required: ["pid"] },
    { required: ["processName"] },
    { required: ["titleContains"] }
  ]);
  assert.deepEqual([...(toolInputSchemas.click_window.properties.coordinateSpace.enum ?? [])], ["client", "window"]);
});

test("run_steps accepts a valid steps array and defaults args to {}", () => {
  const parsed = runStepsSchema.parse({
    steps: [
      { tool: "launch_app", args: { exePath: "C:\\test.exe" } },
      { tool: "list_windows" },
      { tool: "read_clipboard" }
    ]
  });

  assert.equal(parsed.steps.length, 3);
  assert.equal(parsed.steps[0]!.tool, "launch_app");
  assert.deepEqual(parsed.steps[0]!.args, { exePath: "C:\\test.exe" });
  // args omitted -> defaults to empty object.
  assert.deepEqual(parsed.steps[1]!.args, {});
  assert.deepEqual(parsed.steps[2]!.args, {});
});

test("run_steps rejects empty, oversized, and misshapen step arrays", () => {
  assert.throws(() => runStepsSchema.parse({ steps: [] }));
  assert.throws(() => runStepsSchema.parse({}));
  assert.throws(() => runStepsSchema.parse({
    steps: Array.from({ length: 51 }, () => ({ tool: "read_clipboard" }))
  }));
  // A step without a tool field is invalid.
  assert.throws(() => runStepsSchema.parse({ steps: [{ args: {} }] }));
  // A step id that is not a valid identifier is rejected.
  assert.throws(() => runStepsSchema.parse({ steps: [{ tool: "read_clipboard", id: "bad id!" }] }));
  // Reserved step ids are not enforced by the schema (validated statically),
  // but the schema accepts named steps with exports/expect.
  const named = runStepsSchema.parse({
    steps: [
      { id: "app", tool: "read_clipboard", exports: { text: "text" } }
    ]
  });
  assert.equal(named.steps[0]!.id, "app");
});

test("run_steps rejects unknown tool names, including run_steps itself", () => {
  assert.throws(() => runStepsSchema.parse({ steps: [{ tool: "not_a_tool" }] }));
  // Nesting run_steps inside run_steps is forbidden by the enum.
  assert.throws(() => runStepsSchema.parse({ steps: [{ tool: "run_steps" }] }));
});

test("run_steps rejects unknown fields on the step object", () => {
  assert.throws(() => runStepsSchema.parse({
    steps: [{ tool: "read_clipboard", extra: true }]
  }), /unrecognized/i);
});

test("run_steps JSON schema enum mirrors chainableToolNames and excludes run_steps", () => {
  assert.deepEqual(toolInputSchemas.run_steps.properties.steps.items.properties.tool.enum, [...chainableToolNames]);
  assert.equal(toolInputSchemas.run_steps.properties.steps.maxItems, 50);
  assert.equal(toolInputSchemas.run_steps.properties.steps.minItems, 1);
  assert.equal(
    toolInputSchemas.run_steps.properties.steps.items.properties.tool.enum.includes("run_steps"),
    false
  );
});
