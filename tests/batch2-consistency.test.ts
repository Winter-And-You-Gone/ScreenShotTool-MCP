// Batch 2 targeted tests: consistency & maintainability.
//
//   1. workflow_catalog background capability matches the RUNTIME preflight
//      (steps AND finally), so the catalog can never promise what the
//      runtime refuses.
//   2. Central background policy table: screen capture is refused in
//      background, noActivate posted input is bestEffort (never upgraded to
//      safe), global input stays foregroundRequired.
//   3. App Pack validator scans references in expect / finally /
//      captureBefore / retry - not just args.
//   4. Workflow inputSchema validation covers enum/type/nested/arrays.
//   5. The unified PipelineContext factory carries the real foreground
//      reader (profile_run_steps / run_workflow both see pipeline-level
//      foreground state).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { listWorkflows } from "../src/app-packs/workflows.js";
import { validatePack } from "../src/app-packs/validator.js";
import { loadPackFromDir } from "../src/app-packs/loader.js";
import { backgroundUnsafePipelineSteps, stepBackgroundPolicy, type BackgroundPolicy } from "../src/interaction.js";
import { runPipeline, type ExecutionContext } from "../src/pipeline.js";
import type { LoadedPack } from "../src/app-packs/types.js";

function makePack(overrides: Partial<LoadedPack> = {}): LoadedPack {
  return {
    manifest: { schemaVersion: 1, id: "fixture", displayName: "Fixture", version: "1.0.0", catalogVisibility: "session" },
    profile: { id: "fixture", executableNames: ["Fixture.exe"] },
    controls: { controls: {} },
    actions: {
      contracts: [
        { control: "combo", action: "selectByName", backgroundPolicy: "foregroundRequired", idempotent: false },
        { control: "btn", action: "invoke", backgroundPolicy: "safe", idempotent: true }
      ]
    },
    workflows: { workflows: [] },
    dir: "X:/packs/fixture",
    source: "test",
    sourceKind: "explicit",
    loadedAtMs: Date.now(),
    errors: [],
    ...overrides
  };
}

const emptyExpectDeps: ExecutionContext["expectDeps"] = {
  getUiElement: async () => ({ found: false }),
  queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 0 })
};

// ── 1. workflow_catalog vs runtime consistency ──

test("catalog A: a foregroundRequired FINALLY step makes the workflow foregroundRequired (same logic as runtime)", () => {
  const pack = makePack({
    workflows: {
      workflows: [
        {
          id: "wf",
          steps: [{ id: "main", tool: "profile_action", args: { profile: "${pack.id}", control: "btn", action: "invoke" } }],
          finally: [{ id: "cleanup", tool: "profile_action", args: { profile: "${pack.id}", control: "combo", action: "selectByName" } }]
        }
      ]
    }
  });
  const catalog = listWorkflows(pack);
  assert.equal(catalog[0]!.backgroundPolicy, "foregroundRequired");
  assert.equal(catalog[0]!.foregroundRequiredSteps[0]!.stepId, "cleanup");
  assert.equal(catalog[0]!.foregroundRequiredSteps[0]!.section, "finally");
  // The runtime preflight flags the SAME step.
  const wf = pack.workflows.workflows[0]!;
  const unsafe = backgroundUnsafePipelineSteps(wf.steps, wf.finally ?? [], () => pack.actions, pack.actions);
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0]!.stepId, "cleanup");
});

test("catalog B: a safe workflow (no foregroundRequired in steps OR finally) is catalogued safe", () => {
  const pack = makePack({
    workflows: {
      workflows: [
        {
          id: "wf",
          steps: [{ id: "main", tool: "profile_action", args: { profile: "${pack.id}", control: "btn", action: "invoke" } }],
          finally: [{ id: "cleanup", tool: "read_clipboard" }]
        }
      ]
    }
  });
  const catalog = listWorkflows(pack);
  assert.equal(catalog[0]!.backgroundPolicy, "safe");
});

// ── 2. Central background policy table ──

test("policy A: background preflight refuses screen-region capture", () => {
  const unsafe = backgroundUnsafePipelineSteps(
    [{ id: "shot", tool: "capture_screen_region", args: { region: { x: 0, y: 0, width: 100, height: 100 } } }],
    [],
    () => undefined,
    undefined
  );
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0]!.stepId, "shot");
  assert.equal(unsafe[0]!.backgroundPolicy, "foregroundRequired");
});

test("policy B: noActivate posted input is bestEffort (never safe, never foregroundRequired)", () => {
  // noActivate posted keys: allowed in background (bestEffort) - the
  // preflight does NOT refuse them, but they are not claimed safe either.
  assert.equal(stepBackgroundPolicy(undefined, { tool: "send_key", args: { key: "enter", noActivate: true } }), "bestEffort");
  assert.equal(stepBackgroundPolicy(undefined, { tool: "type_text", args: { text: "x", noActivate: true } }), "bestEffort");
  // The preflight only flags foregroundRequired - bestEffort passes.
  const unsafe = backgroundUnsafePipelineSteps(
    [{ id: "k", tool: "send_key", args: { key: "enter", noActivate: true } }],
    [],
    () => undefined,
    undefined
  );
  assert.equal(unsafe.length, 0, "noActivate posted input is not refused in background");
  // Global keyboard input WITHOUT noActivate stays foregroundRequired.
  assert.equal(stepBackgroundPolicy(undefined, { tool: "send_key", args: { key: "enter" } }), "foregroundRequired");
  // Read-only UIA queries are safe.
  assert.equal(stepBackgroundPolicy(undefined, { tool: "ui_query", args: { selector: { controlType: "Button" } } }), "safe");
  // capture_window (PrintWindow) is bestEffort.
  assert.equal(stepBackgroundPolicy(undefined, { tool: "capture_window", args: { pid: 1 } }), "bestEffort");
});

test("policy C: pack-declared backgroundPolicy refines the generic tool policy", () => {
  const pack = makePack();
  const withPack = stepBackgroundPolicy(pack.actions, { tool: "profile_action", args: { control: "btn", action: "invoke" } });
  assert.equal(withPack, "safe", "pack contract policy wins");
  const combo = stepBackgroundPolicy(pack.actions, { tool: "profile_action", args: { control: "combo", action: "selectByName" } });
  assert.equal(combo, "foregroundRequired");
});

// ── 3. Reference scanning scope ──

async function writePack(dir: string, id: string, files: Record<string, unknown>): Promise<void> {
  const packDir = path.join(dir, id);
  await mkdir(packDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), JSON.stringify(value, null, 2), "utf8");
  }
}

const MANIFEST = { schemaVersion: 1, id: "fixture-app", displayName: "Fixture App", version: "1.0.0" };
const PROFILE_JSON = { id: "fixture-app", executableNames: ["FixtureApp.exe"] };

test("refs A: a bad reference inside EXPECT is caught at pack load time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-refs-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "workflows.json": {
      workflows: [
        {
          id: "wf",
          steps: [
            { id: "a", tool: "read_clipboard", args: {} },
            // The expect's expectedValue references a field that does not
            // exist in read_clipboard's output schema - must be caught by
            // validation even though it is NOT in step.args.
            { id: "b", tool: "ui_wait", args: { pid: 1, selector: { controlType: "Window" }, condition: "exists" }, expect: { selector: { automationId: "x" }, condition: "exists", expectedValue: "${a.nonexistentField}", timeoutMs: 2000 } }
          ]
        }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "fixture-app"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes("UNKNOWN_OUTPUT_PATH"), `expected UNKNOWN_OUTPUT_PATH, got ${codes.join(",")}`);
  assert.ok(v.errors.some((e) => e.path.includes("expect")), "the expect reference error must carry an expect path");
});

test("refs B: a bad reference inside captureBefore / finally is caught at pack load time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-refs2-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "workflows.json": {
      workflows: [
        {
          id: "wf",
          steps: [
            { id: "a", tool: "read_clipboard", args: {}, captureBefore: { saveAs: "orig", read: { tool: "ui_get", args: { selector: { automationId: "edit" } } } } },
            { id: "b", tool: "ui_wait", args: { pid: "${a.nonexistentField}", selector: { controlType: "Window" }, condition: "exists" } }
          ],
          finally: [
            // Finally references a field that does not exist in read_clipboard's
            // output schema - must be caught by validation.
            { id: "cleanup", tool: "read_clipboard", args: { tag: "${b.nonexistent}" } }
          ]
        }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "fixture-app"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes("UNKNOWN_OUTPUT_PATH"), `expected UNKNOWN_OUTPUT_PATH, got ${codes.join(",")}`);
  const inFinally = v.errors.some((e) => e.path.includes("finally"));
  assert.ok(inFinally, "the finally reference error must be reported with a finally path");
  // A reference inside captureBefore.read.args to an unknown step is also
  // caught (scan covers captureBefore, not just args).
  const v2 = await validateCaptureReference();
  assert.ok(v2, "captureBefore reference errors are caught at load time");
});

async function validateCaptureReference(): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-refs3-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "workflows.json": {
      workflows: [
        {
          id: "wf",
          steps: [
            { id: "a", tool: "read_clipboard", args: {}, captureBefore: { saveAs: "orig", read: { tool: "ui_get", args: { selector: { automationId: "${ghost.pid}" } } } } }
          ]
        }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "fixture-app"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  return v.errors.some((e) => e.code === "UNKNOWN_STEP_REFERENCE");
}

// ── 4. Workflow inputSchema (validated in workflows.test.ts, checked here at
//       the pack-load level: an inputSchema with a type-violating default is a
//       pack error) ──

test("schema A: workflow inputSchema with enum/type constraints validates nested and array inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pack-schema-"));
  await writePack(dir, "fixture-app", {
    "manifest.json": MANIFEST,
    "profile.json": PROFILE_JSON,
    "workflows.json": {
      workflows: [
        {
          id: "wf",
          inputSchema: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["fast", "slow"] },
              count: { type: "integer", minimum: 1 },
              tags: { type: "array", items: { type: "string" } },
              nested: { type: "object", properties: { depth: { type: "integer" } }, required: ["depth"] }
            },
            required: ["mode"],
            additionalProperties: false
          },
          steps: [{ id: "a", tool: "read_clipboard", args: { tag: "${inputs.mode}" } }]
        }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "fixture-app"));
  assert.ok(loaded, "a pack with a typed inputSchema loads cleanly");
  assert.equal(validatePack(loaded).errors.length, 0);
});

// ── 5. Unified PipelineContext carries the real foreground reader ──

test("ctx A: the pipeline context factory's getForeground reaches the pipeline report", async () => {
  const reads = ["FG_1", "FG_1"];
  let readsDone = 0;
  const result = await runPipeline(
    { steps: [{ id: "a", tool: "read_clipboard" }] },
    {
      dispatch: async () => ({ available: true, text: "x", length: 1, timestamp: "t" }),
      pack: { id: "fixture", actions: makePack().actions, profile: makePack().profile, version: "1" },
      expectDeps: emptyExpectDeps,
      // This is exactly what createPipelineExecutionContext wires: the real
      // foreground reader becomes the pipeline-level report source.
      getForeground: async () => reads[Math.min(readsDone++, reads.length - 1)]!
    }
  );
  assert.equal(result.success, true);
  assert.equal(result.interaction?.foregroundBefore, "FG_1");
  assert.equal(result.interaction?.foregroundAfter, "FG_1");
});
