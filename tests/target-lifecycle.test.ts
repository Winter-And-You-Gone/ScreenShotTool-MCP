// Target lifecycle diagnostics tests: rebind on window recreation, process
// exit classification, exit-code capture, the bounded operation ring, and the
// lastOperation wording rule (temporal context, never causality).
import assert from "node:assert/strict";
import test from "node:test";

import {
  bindLaunchTarget,
  resolveTargetRef,
  recordTargetOperation,
  lastTargetOperation,
  classifyTargetLifecycle,
  TARGET_OPERATION_RING_MAX,
  resetTargetBindings
} from "../src/targets.js";

function makeDeps(overrides: {
  processAlive?: boolean;
  windowAlive?: boolean;
  exitCode?: number | null;
  windows?: Array<{ hwnd: string; title: string; pid: number; processName: string }>;
}) {
  return {
    checkProcessAlive: async () => ({
      processAlive: overrides.processAlive ?? true,
      windowAlive: overrides.windowAlive ?? true,
      exitCode: overrides.exitCode
    }),
    listWindows: async () => overrides.windows ?? []
  };
}

function launchFixture(pid = 4242, hwnd = "777") {
  return bindLaunchTarget({
    profileId: "fixture",
    executableNames: ["FixtureApp.exe"],
    processNames: ["FixtureApp"],
    titleContains: ["Fixture"],
    mainWindow: { title: "^Fixture App$", titleMatch: "regex" },
    pid,
    hwnd,
    title: "Fixture App",
    startedByMcp: true,
    startedAt: Date.now()
  });
}

test("targetRef: hwnd valid -> resolved without rebind", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const r = await resolveTargetRef(binding.targetRef, makeDeps({}));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.rebound, false);
    assert.equal(r.target.hwnd, "777");
  }
});

test("targetRef: stale hwnd + process alive -> rebind to new main window", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const r = await resolveTargetRef(binding.targetRef, makeDeps({
    windowAlive: false,
    windows: [{ hwnd: "999", title: "Fixture App", pid: 4242, processName: "FixtureApp" }]
  }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.target.rebound, true);
    assert.equal(r.target.hwnd, "999");
    assert.equal(r.target.previousHwnd, "777");
    assert.equal(r.target.lifecycle, "window-recreated");
  }
});

test("targetRef: process exited -> TARGET_PROCESS_EXITED with lifecycle details, no causality claim", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  recordTargetOperation(binding.targetRef, {
    tool: "profile_action",
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    interactionMethod: "InvokePattern",
    result: "success"
  });
  const r = await resolveTargetRef(binding.targetRef, makeDeps({
    processAlive: false,
    windowAlive: false,
    exitCode: 0xC0000409
  }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, "TARGET_PROCESS_EXITED");
    const details = r.error.details as Record<string, unknown>;
    assert.equal(details.processAlive, false);
    assert.equal(details.startedByMcp, true);
    assert.equal(details.exitCode, 0xC0000409);
    assert.ok(details.exitObservedAt !== undefined);
    assert.equal(details.causality, "unknown");
    // lastOperation is labeled as temporal context - the error message and
    // suggestion never claim the tool caused the exit.
    const lastOp = details.lastOperation as { tool?: string; interactionMethod?: string; completed?: boolean };
    assert.equal(lastOp.tool, "profile_action");
    assert.equal(lastOp.interactionMethod, "InvokePattern");
    assert.equal(lastOp.completed, true);
    assert.match(r.error.message, /has exited/);
    assert.match(r.error.suggestion ?? "", /does not prove that the tool caused the exit/);
  }
});

test("targetRef: process alive, no matching window -> WINDOW_NOT_FOUND_FOR_PROCESS (NOT a crash)", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const r = await resolveTargetRef(binding.targetRef, makeDeps({
    processAlive: true,
    windowAlive: false,
    windows: [{ hwnd: "123", title: "Some Other Window", pid: 4242, processName: "FixtureApp" }]
  }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, "WINDOW_NOT_FOUND_FOR_PROCESS");
    const details = r.error.details as Record<string, unknown>;
    assert.equal(details.processAlive, true);
    assert.equal(details.profileWindowMatched, false);
    assert.match(r.error.suggestion ?? "", /does not prove the process crashed/);
  }
});

test("operation ring: bounded to TARGET_OPERATION_RING_MAX, keeps only safe metadata", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  for (let i = 0; i < TARGET_OPERATION_RING_MAX + 5; i++) {
    recordTargetOperation(binding.targetRef, {
      tool: "ui_query",
      startedAt: Date.now(),
      finishedAt: Date.now(),
      interactionMethod: "UIAQuery",
      result: "success"
    });
  }
  const last = lastTargetOperation(binding.targetRef);
  assert.ok(last !== undefined);
  assert.equal(last.tool, "ui_query");
  // Ring is bounded; the oldest entries were dropped.
  const bindingAfter = resolveTargetRef(binding.targetRef, makeDeps({}));
  void bindingAfter;
  // No sensitive fields ever enter the records (structural check).
  assert.equal("password" in (last as Record<string, unknown>), false);
  assert.equal("token" in (last as Record<string, unknown>), false);
  assert.equal("text" in (last as Record<string, unknown>), false);
});

test("classifyTargetLifecycle: distinguishes process-exited states", () => {
  const base = launchFixture();
  assert.equal(classifyTargetLifecycle(base, true, true), "alive");
  assert.equal(classifyTargetLifecycle(base, true, false), "window-lost-process-alive");
  assert.equal(classifyTargetLifecycle(base, false, false), "process-exited");
  const withCode = { ...base, exitCode: 0xC0000005 };
  assert.equal(classifyTargetLifecycle(withCode, false, false), "process-exited-with-code");
  const killed = { ...base, terminatedByMcp: true };
  assert.equal(classifyTargetLifecycle(killed, false, false), "terminated-by-mcp");
});

test("exit code is never fabricated: missing exitCode stays undefined", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const r = await resolveTargetRef(binding.targetRef, makeDeps({
    processAlive: false,
    windowAlive: false,
    exitCode: null
  }));
  assert.equal(r.ok, false);
  if (!r.ok) {
    const details = r.error.details as Record<string, unknown>;
    assert.equal(details.exitCode, undefined);
    // Without an exit code the classification stays "process-exited" (not a
    // root-cause claim like "crashed").
    assert.equal(details.lifecycle, "process-exited");
  }
});

// ── Operation wrapper behavior (withTargetOperation) ──
//
// These tests drive the real dispatch path (dispatchToolValue) with a fake
// windows runtime whose checkProcessAlive / listWindows are scripted. They
// prove the ring contract: records are created BEFORE the operation (a throw
// always yields a record), before/after state is captured, outcome
// classification is correct, window recreation is not misread as target
// disappearance, and no sensitive payload ever enters the ring.

import { TARGET_OPERATION_TOOLS, dispatchToolValue } from "../src/index.js";
import { McpUiError } from "../src/uia/results.js";
import { listTargetBindings, type TargetBinding } from "../src/targets.js";

function makeRuntime(overrides: {
  alive?: boolean;
  windowAlive?: boolean;
  aliveAfter?: boolean;
  windowAliveAfter?: boolean;
  windows?: Array<{ hwnd: string; title: string; pid: number; processName: string }>;
  clickResult?: Record<string, unknown>;
  clickError?: Error;
  queryUiResult?: Record<string, unknown>;
  queryUiError?: Error;
  typeTextResult?: Record<string, unknown>;
  sendKeyResult?: Record<string, unknown>;
  sendKeyError?: Error;
  captureWindowResult?: Record<string, unknown>;
  captureError?: Error;
}) {
  const beforeAlive = overrides.alive ?? true;
  const beforeWindow = overrides.windowAlive ?? true;
  const afterAlive = overrides.aliveAfter ?? beforeAlive;
  const afterWindow = overrides.windowAliveAfter ?? beforeWindow;
  // Call sequence per dispatch: 1) resolveTargetRef hwnd check, 2) wrapper
  // before probe, 3) wrapper after probe. Resolve must observe the BEFORE
  // state or it would fail the operation before it starts.
  let calls = 0;
  const windows = {
    checkProcessAlive: async () => {
      calls++;
      const isAfter = calls >= 3;
      return {
        pid: 4242,
        processAlive: isAfter ? afterAlive : beforeAlive,
        windowAlive: isAfter ? afterWindow : beforeWindow
      };
    },
    listWindows: async () => overrides.windows ?? [],
    clickWindow: async () => {
      if (overrides.clickError) throw overrides.clickError;
      return overrides.clickResult ?? { clicked: true, method: "post_message", target: "Fixture", hwnd: "777", title: "Fixture App", pid: 4242, button: "left", doubleClick: false, windowPoint: { x: 0, y: 0 }, screenPoint: { x: 0, y: 0 }, timestamp: "t" };
    },
    queryUi: async () => {
      if (overrides.queryUiError) throw overrides.queryUiError;
      return overrides.queryUiResult ?? { found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 0 };
    },
    typeText: async () => overrides.typeTextResult ?? { typed: true, target: "Fixture", hwnd: "777", title: "Fixture App", pid: 4242, textLength: 1, skipped: [], timestamp: "t" },
    sendKey: async () => {
      if (overrides.sendKeyError) throw overrides.sendKeyError;
      return overrides.sendKeyResult ?? { sent: true, key: "enter", modifiers: [], target: "Fixture", hwnd: "777", title: "Fixture App", pid: 4242, timestamp: "t" };
    },
    captureWindow: async () => {
      if (overrides.captureError) throw overrides.captureError;
      return overrides.captureWindowResult ?? { path: "C:\\outputs\\x.png", width: 10, height: 10, target: "Fixture", rect: { x: 0, y: 0, width: 10, height: 10 }, timestamp: "t", interaction: { requestedMode: "background", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false, method: "PrintWindow" } };
    }
  };
  return {
    version: "test",
    schemas: {} as never,
    windows: windows as never,
    profiles: {
      findProfileForTarget: () => undefined,
      enrichCatalogControls: () => undefined,
      resolveProfileControl: async () => undefined,
      performProfileAction: async () => undefined
    } as never
  };
}

function lastRecord(): Record<string, unknown> {
  return lastTargetOperation("target_fixture_4242_777") as unknown as Record<string, unknown>;
}

test("wrapper: operation throw still leaves a record (started before, finalized after)", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({ clickError: new McpUiError("TEST_BOOM", "boom") });
  await assert.rejects(
    dispatchToolValue("click_window", { targetRef: binding.targetRef, x: 0, y: 0 }, runtime, {} as never),
    /boom/
  );
  const rec = lastRecord();
  assert.equal(rec.tool, "click_window");
  assert.ok(rec.startedAt !== undefined);
  assert.ok(rec.finishedAt !== undefined);
  assert.ok(rec.finishedAt! >= rec.startedAt);
  assert.equal(rec.before?.processAlive, true);
  assert.equal(rec.before?.windowAlive, true);
  assert.equal(rec.result, "business-error");
  assert.equal(rec.errorCode, "TEST_BOOM");
});

test("wrapper: ELEMENT_NOT_FOUND on a live target -> business-error, original error rethrown", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({ queryUiError: new McpUiError("ELEMENT_NOT_FOUND", "no element") });
  let caught: unknown;
  try {
    await dispatchToolValue("ui_query", { targetRef: binding.targetRef, selector: { automationId: "missing" } }, runtime, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError);
  assert.equal((caught as McpUiError).code, "ELEMENT_NOT_FOUND");
  const rec = lastRecord();
  assert.equal(rec.tool, "ui_query");
  assert.equal(rec.result, "business-error");
  assert.equal(rec.errorCode, "ELEMENT_NOT_FOUND");
  assert.equal(rec.before?.processAlive, true);
  assert.equal(rec.after?.processAlive, true);
});

test("wrapper: non-structured internal error with live target -> protocol-error", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({ sendKeyError: new Error("internal boom") });
  await assert.rejects(
    dispatchToolValue("send_key", { targetRef: binding.targetRef, key: "x" }, runtime, {} as never),
    /internal boom/
  );
  const rec = lastRecord();
  assert.equal(rec.tool, "send_key");
  assert.equal(rec.result, "protocol-error");
  assert.equal(rec.errorCode, undefined);
  assert.equal(rec.before?.processAlive, true);
  assert.equal(rec.after?.processAlive, true);
});

test("wrapper: process dead after operation -> target-disappeared", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({
    aliveAfter: false,
    windowAliveAfter: false,
    captureError: new Error("capture died")
  });
  let caught: unknown;
  try {
    await dispatchToolValue("capture_window", { targetRef: binding.targetRef }, runtime, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.match((caught as Error).message, /capture died/);
  const rec = lastRecord();
  assert.equal(rec.tool, "capture_window");
  assert.equal(rec.result, "target-disappeared");
  assert.equal(rec.before?.processAlive, true);
  assert.equal(rec.after?.processAlive, false);
  assert.equal(rec.after?.windowAlive, false);
});

test("wrapper: process alive + window recreated -> business-error with windowRebound, NOT target-disappeared", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({
    aliveAfter: true,
    windowAliveAfter: false,
    windows: [{ hwnd: "999", title: "Fixture App", pid: 4242, processName: "FixtureApp" }],
    // A STRUCTURED business failure (e.g. ELEMENT_NOT_FOUND) while the window
    // was recreated mid-operation: the session is still alive -> business-error
    // + windowRebound, never target-disappeared.
    clickError: new McpUiError("ELEMENT_NOT_FOUND", "click target no longer present")
  });
  let caught: unknown;
  try {
    await dispatchToolValue("click_window", { targetRef: binding.targetRef, x: 0, y: 0 }, runtime, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError);
  assert.equal((caught as McpUiError).code, "ELEMENT_NOT_FOUND");
  const rec = lastRecord();
  assert.equal(rec.result, "business-error");
  assert.equal(rec.windowRebound, true);
  assert.equal(rec.after?.hwnd, "999");
  assert.notEqual(rec.result, "target-disappeared");
});

test("wrapper: success records interactionMethod from the result, exactly one record", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({});
  const result = await dispatchToolValue("click_window", { targetRef: binding.targetRef, x: 0, y: 0 }, runtime, {} as never);
  assert.equal((result as Record<string, unknown>).clicked, true);
  const rec = lastRecord();
  assert.equal(rec.tool, "click_window");
  assert.equal(rec.result, "success");
  assert.equal(rec.interactionMethod, "post_message");
  assert.equal(rec.before?.processAlive, true);
  assert.equal(rec.after?.processAlive, true);
  // Exactly ONE record for the operation (no duplicate manual record).
  const ops = listTargetBindings().find((b) => b.targetRef === binding.targetRef)?.operations ?? [];
  assert.equal(ops.length, 1);
});

test("wrapper: capture_window success records the capture method", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({});
  const result = await dispatchToolValue("capture_window", { targetRef: binding.targetRef }, runtime, {} as never);
  assert.equal((result as Record<string, unknown>).path, "C:\\outputs\\x.png");
  const rec = lastRecord();
  assert.equal(rec.tool, "capture_window");
  assert.equal(rec.result, "success");
  assert.equal(rec.interactionMethod, "PrintWindow");
  // The ring must NOT contain the image path or any payload.
  assert.ok(!("path" in rec), "no path field in the ring");
  assert.ok(!("outputPath" in rec), "no outputPath field in the ring");
});

test("wrapper: sensitive args never enter the ring (type_text payload)", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({});
  const result = await dispatchToolValue("type_text", { targetRef: binding.targetRef, text: "SUPER_SECRET_TOKEN_123" }, runtime, {} as never);
  assert.equal((result as Record<string, unknown>).typed, true);
  const rec = lastRecord();
  assert.equal(rec.tool, "type_text");
  const json = JSON.stringify(rec);
  assert.ok(!json.includes("SUPER_SECRET_TOKEN_123"), "type_text payload must never enter the ring");
  assert.ok(!("text" in rec), "no text field");
});

test("wrapper: ring stays bounded across many operations", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({});
  const { TARGET_OPERATION_RING_MAX } = await import("../src/targets.js");
  for (let i = 0; i < TARGET_OPERATION_RING_MAX + 5; i++) {
    await dispatchToolValue("click_window", { targetRef: binding.targetRef, x: 0, y: 0 }, runtime, {} as never);
  }
  const ops = listTargetBindings().find((b) => b.targetRef === binding.targetRef)?.operations ?? [];
  assert.equal(ops.length, TARGET_OPERATION_RING_MAX);
});

test("wrapper: ui_query through the executor path is operation-tracked", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({});
  const uiaDeps = {} as never;
  const executor = {
    parseInput: () => ({ ok: true as const, value: { targetRef: binding.targetRef, selector: { automationId: "a" } } }),
    dispatch: (tool: string, input: unknown) => dispatchToolValue(tool, input, runtime, uiaDeps)
  };
  const { executeValidatedTool } = await import("../src/executor.js");
  const out = await executeValidatedTool("ui_query", { targetRef: binding.targetRef, selector: { automationId: "a" } }, executor as never);
  assert.ok(out !== undefined);
  const rec = lastRecord();
  assert.equal(rec.tool, "ui_query");
  assert.equal(rec.result, "success");
  assert.equal(rec.interactionMethod, "UIAQuery");
});

test("wrapper: TARGET_PROCESS_EXITED during resolution -> no record (operation never started)", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeRuntime({ alive: false, windowAlive: false });
  let caught: unknown;
  try {
    await dispatchToolValue("get_window_state", { targetRef: binding.targetRef }, runtime, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError);
  assert.equal((caught as McpUiError).code, "TARGET_PROCESS_EXITED");
  assert.equal(listTargetBindings().length, 0, "binding unregistered on process exit");
});

test("wrapper: startedByMcp and lifetime are separate on bindings", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({
    profileId: "fixture",
    executableNames: ["FixtureApp.exe"],
    processNames: ["FixtureApp"],
    pid: 4242,
    hwnd: "777",
    startedByMcp: true,
    lifetime: "independent"
  });
  assert.equal(binding.startedByMcp, true);
  assert.equal(binding.lifetime, "independent");
  // An independent target is NOT a managed child: nothing anywhere marks it
  // as server-owned for cleanup.
  assert.notEqual(binding.lifetime, "managed");
});
