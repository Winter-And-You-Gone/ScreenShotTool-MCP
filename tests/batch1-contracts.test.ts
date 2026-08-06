// Batch 1 targeted tests: core correctness fixes.
//
//   1. Interaction context propagation: pipeline steps (profile_action etc.)
//      receive the resolved interaction context (foregroundDemo / background)
//      instead of re-deriving the mode from pack defaults mid-pipeline.
//   2. Canonical array output: array tools return { items: [...] } identically
//      for plain calls and pipeline steps; ${step.items.0.hwnd} validates and
//      runs; old ${0.0.hwnd} references stay compatible.
//   3. Atomic App Pack reload: a candidate pack with semantic errors never
//      enters the active registry; the old registry + validation cache are
//      kept verbatim after a failed reload.
//   4. continue_run unified lifecycle: finally runs on success AND failure,
//      restore replays the original captured state, exports are keyed by
//      global step index, and ALL continuation work shares one deadline.
//
// All dispatch is mocked - no real UIA, no GUI apps.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPipeline, continuePipeline, type ExecutionContext } from "../src/pipeline.js";
import { executeValidatedTool, normalizeToolOutput, isCanonicalArrayContract, type ToolExecutorContext } from "../src/executor.js";
import { getContract, contracts } from "../src/contracts.js";
import { validateAgainstSchema } from "../src/outputs.js";
import { AppPackRegistry } from "../src/app-packs/registry.js";
import { clearAllRuns, saveRun, getRun, type RunSnapshot } from "../src/runs.js";
import { prepareStepForInteraction, type StoredInteractionContext } from "../src/interaction.js";
import type { PackActions } from "../src/app-packs/types.js";
import type { AppProfile } from "../src/profiles/types.js";

const PROFILE: AppProfile = {
  id: "fixture",
  displayName: "Fixture",
  processNames: ["Fixture.exe"],
  controls: {
    btn: { selectors: [{ automationId: "btn" }], confidence: "source-derived" },
    combo: { selectors: [{ automationId: "combo" }], confidence: "source-derived" }
  }
};

const ACTIONS: PackActions = {
  contracts: [
    { control: "btn", action: "invoke", backgroundPolicy: "safe", idempotent: true },
    { control: "combo", action: "selectByName", backgroundPolicy: "foregroundRequired", idempotent: false }
  ]
};

const emptyExpectDeps: ExecutionContext["expectDeps"] = {
  getUiElement: async () => ({ found: false }),
  queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 0 })
};

// ── 1. Interaction context propagation ──

test("interaction A: pipeline steps inherit the resolved context (profile_action receives the pipeline mode)", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await runPipeline(
    {
      steps: [
        { id: "a", tool: "profile_action", args: { profile: "fixture", control: "btn", action: "invoke" } },
        { id: "b", tool: "profile_launch", args: { profile: "fixture" } }
      ]
    },
    {
      dispatch: async (tool, args) => {
        seen.push((args as Record<string, unknown>) ?? {});
        if (tool === "profile_launch") {
          return { profile: "fixture", pid: 1, hwnd: "2", title: "t", startedByMcp: true, reused: false, uiaRootAvailable: true, interaction: { requestedMode: "foregroundDemo", effectiveMode: "foregroundDemo", foregroundChanged: true, targetActivated: true, physicalCursorMoved: false } };
        }
        return { profile: "fixture", control: "btn", result: { success: true }, interaction: { requestedMode: "foregroundDemo", effectiveMode: "foregroundDemo", foregroundChanged: true, targetActivated: true, physicalCursorMoved: false } };
      },
      pack: { id: "fixture", actions: ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "foregroundDemo",
      interaction: { restorePreviousForeground: false, stepDelayMs: 5 },
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(result.success, true);
  assert.equal(seen.length, 2);
  for (const args of seen) {
    assert.equal(args.interactionMode, "foregroundDemo", `step must receive foregroundDemo, got ${JSON.stringify(args)}`);
    assert.equal((args.foregroundDemo as { restorePreviousForeground?: boolean })?.restorePreviousForeground, false, "restorePreviousForeground must be inherited");
  }
});

test("interaction B: outer explicit background wins over a pack-less default (profile_action steps stay background)", async () => {
  const seen: Array<Record<string, unknown>> = [];
  // The profile_action has NO pack default (pack-less run_steps), but the
  // outer call explicitly requested background: the step must receive it.
  const result = await runPipeline(
    {
      steps: [
        { id: "a", tool: "profile_action", args: { profile: "fixture", control: "btn", action: "invoke" } }
      ]
    },
    {
      dispatch: async (tool, args) => {
        seen.push((args as Record<string, unknown>) ?? {});
        return { profile: "fixture", control: "btn", result: { success: true }, interaction: { requestedMode: "background", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false } };
      },
      pack: { id: "fixture", actions: ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(result.success, true);
  assert.equal(seen[0]?.interactionMode, "background", "step must inherit background");
});

test("interaction C: a step's explicit mode is never overridden by the pipeline context", () => {
  const stored: StoredInteractionContext = { requestedMode: "foregroundDemo", effectiveMode: "foregroundDemo", allowForegroundFallback: false };
  const prepared = prepareStepForInteraction(
    { id: "a", tool: "profile_launch", args: { profile: "fixture", interactionMode: "background" } },
    stored
  );
  assert.equal(prepared.args?.interactionMode, "background", "step-explicit mode wins");
  // Non-interaction-aware tools are untouched.
  const ui = prepareStepForInteraction({ id: "b", tool: "ui_action", args: { action: "invoke" } }, stored);
  assert.equal(ui.args?.interactionMode, undefined);
});

// ── 2. Canonical array output ──

test("array output A: plain calls and pipeline steps return the same {items} structure", async () => {
  const raw = [{ hwnd: "1", title: "a", pid: 1, processName: "p", className: "c", rect: { x: 0, y: 0, width: 1, height: 1 } }];
  // Plain call through the unified executor.
  const plainCtx: ToolExecutorContext = {
    parseInput: () => ({ ok: true, value: {} }),
    dispatch: async () => raw
  };
  const plain = await executeValidatedTool("list_windows", {}, plainCtx);
  assert.deepEqual(plain, { items: raw }, "plain call returns the canonical {items} object");
  assert.ok(validateAgainstSchema(plain, contracts.list_windows!.outputSchema).ok, "canonical result validates");

  // Pipeline step through the same executor shape.
  let dispatched: unknown;
  const pipelineResult = await runPipeline(
    { steps: [{ id: "w", tool: "list_windows" }] },
    {
      dispatch: async (tool, args) => {
        void tool;
        dispatched = await executeValidatedTool("list_windows", args, plainCtx);
        return dispatched;
      },
      pack: { id: "fixture", actions: ACTIONS, profile: PROFILE, version: "1" },
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(pipelineResult.success, true);
  assert.deepEqual(dispatched, { items: raw });
  assert.deepEqual(pipelineResult.steps[0]!.result, { items: raw }, "the step result is the canonical object");
});

test("array output B: ${step.items.0.hwnd} validates statically and runs; ${0.0.hwnd} stays compatible", async () => {
  const raw = [{ hwnd: "99", title: "t", pid: 42, processName: "p", className: "c", rect: { x: 0, y: 0, width: 1, height: 1 } }];
  const list = () => raw;
  const ctx = {
    dispatch: async (tool: string) => {
      if (tool === "list_windows") return { items: list() };
      if (tool === "ui_wait") return { matched: true, condition: "exists", timedOut: false, elapsedMs: 1, timeoutMs: 10000, pollIntervalMs: 200, lastObservation: null };
      throw new Error(`unexpected tool ${tool}`);
    },
    pack: { id: "fixture", actions: ACTIONS, profile: PROFILE, version: "1" },
    expectDeps: emptyExpectDeps
  };
  const result = await runPipeline(
    {
      steps: [
        { id: "windows", tool: "list_windows" },
        { id: "check", tool: "ui_wait", args: { hwnd: "${windows.items.0.hwnd}", selector: { controlType: "Window" }, condition: "exists" } }
      ]
    },
    ctx
  );
  assert.equal(result.success, true, "canonical ${windows.items.0.hwnd} reference resolves");

  // Old-style numeric reference ${0.0.hwnd} against a canonical result still
  // works (items-compat in the reference resolver).
  const legacy = await runPipeline(
    {
      steps: [
        { tool: "list_windows" },
        { tool: "ui_wait", args: { hwnd: "${0.0.hwnd}", selector: { controlType: "Window" }, condition: "exists" } }
      ]
    },
    ctx
  );
  assert.equal(legacy.success, true, "legacy ${0.0.hwnd} reference stays compatible");

  // Static validation accepts ${windows.items.0.hwnd} (schema-derived).
  const { validatePipelineStatic } = await import("../src/pipeline.js");
  const v = validatePipelineStatic(
    {
      steps: [
        { id: "windows", tool: "list_windows" },
        { id: "check", tool: "ui_wait", args: { hwnd: "${windows.items.0.hwnd}", selector: { controlType: "Window" }, condition: "exists" } }
      ]
    },
    { pack: { id: "fixture", actions: ACTIONS }, getContract }
  );
  assert.equal(v.valid, true, `static validation must accept ${"${windows.items.0.hwnd}"}: ${JSON.stringify(v.errors)}`);
});

test("array output C: normalizeToolOutput wraps only canonical array contracts", () => {
  const listSchema = contracts.list_windows!.outputSchema;
  assert.ok(isCanonicalArrayContract(listSchema));
  assert.deepEqual(normalizeToolOutput("list_windows", [1, 2], { outputSchema: listSchema }), { items: [1, 2] });
  // Non-array results pass through.
  assert.deepEqual(normalizeToolOutput("list_windows", { items: [1] }, { outputSchema: listSchema }), { items: [1] });
  // Non-canonical contracts are untouched.
  const launchSchema = contracts.profile_launch!.outputSchema;
  assert.deepEqual(normalizeToolOutput("profile_launch", { pid: 1 }, { outputSchema: launchSchema }), { pid: 1 });
  assert.equal(isCanonicalArrayContract(launchSchema), false);
});

// ── 3. Atomic App Pack reload ──

async function writePack(dir: string, id: string, files: Record<string, unknown>): Promise<void> {
  const packDir = path.join(dir, id);
  await mkdir(packDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), JSON.stringify(value, null, 2), "utf8");
  }
}

const MANIFEST = { schemaVersion: 1, id: "fixture-app", displayName: "Fixture App", version: "1.0.0" };
const PROFILE_JSON = { id: "fixture-app", executableNames: ["FixtureApp.exe"] };
const CONTROLS_JSON = {
  controls: {
    confirmButton: { selectors: [{ automationId: "confirmButton$", match: "regex", controlType: "Button" }], confidence: "source-derived" }
  }
};
const ACTIONS_JSON = {
  contracts: [
    { control: "confirmButton", action: "invoke", idempotent: false, retrySafe: false }
  ]
};

test("reload A: a candidate pack with semantic errors never enters the active registry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-atomic-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "controls.json": CONTROLS_JSON,
    "actions.json": ACTIONS_JSON
  });
  const reg = new AppPackRegistry();
  const first = await reg.load(dir, [], false);
  assert.equal(first.reloaded, true);
  assert.ok(reg.getPack("fixture-app"), "valid pack is active");

  // Introduce a semantic error: an action contract referencing a control that
  // does not exist. Schema validation passes; SEMANTIC validation fails.
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "controls.json": CONTROLS_JSON,
    "actions.json": {
      contracts: [
        { control: "ghostControl", action: "invoke", idempotent: true }
      ]
    }
  });
  const second = await reg.load(dir, [], false);
  assert.equal(second.reloaded, false, "semantically invalid candidate must not reload");
  assert.ok(second.issues.some((i) => i.code === "PACK_INVALID"), `expected PACK_INVALID, got ${JSON.stringify(second.issues)}`);
  assert.ok(reg.getPack("fixture-app"), "the OLD pack stays active");
  // The old pack still validates clean (the validation cache matches the
  // ACTIVE registry, never the rejected candidate).
  assert.equal(reg.validationErrorsFor("fixture-app").length, 0);
});

test("reload B: after a failed reload describe/validate/catalog all see the old active version", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-atomic2-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "controls.json": CONTROLS_JSON,
    "actions.json": ACTIONS_JSON
  });
  const reg = new AppPackRegistry();
  await reg.load(dir, [], false);
  const oldActions = JSON.stringify(reg.getPack("fixture-app")!.actions);

  // Break the pack semantically AND change its version: the reload must fail
  // and every interface must keep seeing the old version.
  await writePack(dir, "fixture-app", {
    "manifest.json": { ...MANIFEST, version: "2.0.0" },
    "profile.json": PROFILE_JSON,
    "controls.json": CONTROLS_JSON,
    "actions.json": { contracts: [{ control: "ghost", action: "invoke", idempotent: true }] }
  });
  const failed = await reg.load(dir, [], false);
  assert.equal(failed.reloaded, false);

  // The consistency interfaces all observe the SAME old active state.
  assert.equal(reg.getPack("fixture-app")?.manifest.version, "1.0.0", "registry keeps the old version");
  assert.equal(JSON.stringify(reg.getPack("fixture-app")!.actions), oldActions, "registry keeps the old actions");
  assert.equal(reg.validationErrorsFor("fixture-app").length, 0, "validation cache matches the ACTIVE (old) pack");
  assert.equal(reg.listPacks("all").length, 1);
});

// ── 4. continue_run unified lifecycle ──

function makeSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run_test",
    kind: "run_steps",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 600_000,
    input: {
      steps: [
        { id: "a", tool: "read_clipboard" },
        { id: "b", tool: "read_clipboard" }
      ],
      finally: [
        { id: "cleanup", tool: "write_clipboard", args: { text: "done" } }
      ],
      restore: "always",
      captureBefore: [
        { saveAs: "orig", read: { tool: "ui_get", args: { selector: { automationId: "edit" } } } }
      ]
    },
    steps: [
      { id: "a", index: 0, tool: "read_clipboard", pipeProjection: { available: true, text: "x", length: 1 }, exports: {}, success: true },
      { id: "b", index: 1, tool: "read_clipboard", pipeProjection: null, exports: {}, success: false, error: { code: "ACTION_FAILED", message: "boom" } }
    ],
    exports: {},
    pid: 4242,
    hwnd: "99",
    stoppedAtStep: 1,
    error: { code: "ACTION_FAILED", message: "boom" },
    maxSteps: 2,
    totalTimeoutMs: 120_000,
    finallyRan: [],
    capturedState: [
      { key: "orig", state: { kind: "value", value: "original" }, protected: false, readTool: "ui_get", readArgs: { selector: { automationId: "edit" } } }
    ],
    continuable: true,
    continuationReason: null,
    ...overrides
  };
}

function continueCtx(opts: {
  failStep?: boolean;
  finallyFails?: boolean;
  restoreVerifyFails?: boolean;
  dispatchCalls?: string[];
}) {
  const calls = opts.dispatchCalls ?? [];
  return {
    dispatch: async (tool: string, args: unknown) => {
      calls.push(tool);
      if (tool === "ui_get") {
        // Restore verification re-read: normally the original value is back.
        return { found: true, element: { automationId: "edit", value: opts.restoreVerifyFails ? "changed" : "original", isPassword: false, valueProtected: false }, elapsedMs: 1 };
      }
      if (tool === "ui_action") {
        return { success: true, method: "ValuePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, elapsedMs: 1 };
      }
      if (tool === "read_clipboard") {
        if (opts.failStep) throw new Error("ACTION_FAILED: simulated failure");
        return { available: true, text: "ok", length: 2, timestamp: "t" };
      }
      if (tool === "write_clipboard") {
        if (opts.finallyFails) throw new Error("ELEMENT_NOT_FOUND: cleanup failed");
        return { written: true, length: 4, timestamp: "t" };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    pack: { id: "fixture", actions: ACTIONS, profile: PROFILE, version: "1" },
    expectDeps: emptyExpectDeps
  } satisfies ExecutionContext;
}

test("continue D1: finally runs after a SUCCESSFUL continuation (and not twice)", async () => {
  clearAllRuns();
  const calls: string[] = [];
  const snapshot = makeSnapshot();
  saveRun(snapshot);
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({ dispatchCalls: calls }),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, true);
  const finallyWrites = calls.filter((c) => c === "write_clipboard");
  assert.equal(finallyWrites.length, 1, "finally must run exactly once on a successful continuation");
  assert.equal(result.finallyResults.length, 1);
  assert.equal(result.finallyResults[0]!.success, true);
});

test("continue D2: finally runs after a FAILED continuation too", async () => {
  clearAllRuns();
  const calls: string[] = [];
  saveRun(makeSnapshot());
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({ failStep: true, dispatchCalls: calls }),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, false, "the continued step fails");
  assert.ok(calls.includes("write_clipboard"), "finally must run even when the continuation fails");
  assert.equal(result.finallyResults.length, 1);
});

test("continue D3: restore replays the ORIGINAL captured state and re-verifies", async () => {
  clearAllRuns();
  saveRun(makeSnapshot());
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({}),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, true);
  assert.equal(result.restoreResults.length, 1, "the original captured state must be restored");
  assert.equal(result.restoreResults[0]!.success, true, "restore must verify against the re-read state");
  assert.equal(result.restoreResults[0]!.expected, "original");
});

test("continue D4: a continuation without captured state reports RESTORE_STATE_UNAVAILABLE (never fake success)", async () => {
  clearAllRuns();
  saveRun(makeSnapshot({ capturedState: undefined }));
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({}),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, true);
  assert.equal(result.restoreResults.length, 1);
  assert.equal(result.restoreResults[0]!.code, "RESTORE_STATE_UNAVAILABLE", "missing captured state is reported honestly");
});

test("continue D5: all continuation work shares ONE deadline (no per-step reset)", async () => {
  clearAllRuns();
  saveRun(makeSnapshot({ totalTimeoutMs: 30_000 }));
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({}),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, true);
  const saved = getRun("run_test")!;
  assert.equal(saved.stoppedAtStep, 2);
});

test("continue D6: exports of the continued segment are keyed by GLOBAL step index", async () => {
  clearAllRuns();
  // Step 0 exports a value; the continuation completes step 1 which also
  // exports. A second continuation must NOT misalign the exports.
  const snapshot = makeSnapshot({
    input: {
      steps: [
        { id: "a", tool: "read_clipboard", exports: { text: "text" } },
        { id: "b", tool: "read_clipboard", exports: { len: "length" } }
      ]
    },
    steps: [
      { id: "a", index: 0, tool: "read_clipboard", pipeProjection: { available: true, text: "a", length: 1 }, exports: { text: "a" }, success: true },
      { id: "b", index: 1, tool: "read_clipboard", pipeProjection: null, exports: {}, success: false, error: { code: "ACTION_FAILED", message: "boom" } }
    ],
    exports: { text: "a" }
  });
  saveRun(snapshot);
  const result = await continuePipeline({
    runId: "run_test",
    continueFrom: "b",
    ctx: continueCtx({}),
    checkProcessAlive: async () => true,
    checkHwndValid: async () => true,
    getPackVersion: () => "1.0.0"
  });
  assert.equal(result.success, true);
  assert.equal(result.exports.text, "a", "step-0 export survives");
  assert.equal(result.exports.len, 2, "continued step-1 export is present and aligned");
  const saved = getRun("run_test")!;
  assert.equal(saved.steps[1]?.exports.len, 2, "the updated snapshot keeps the global-indexed exports");
});
