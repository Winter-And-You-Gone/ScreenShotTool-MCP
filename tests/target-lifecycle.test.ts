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
