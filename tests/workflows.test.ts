// Unit tests for the workflow system (src/app-packs/workflows.ts):
// catalog visibility, input validation, internal workflows, and execution
// through the pipeline engine with a mocked dispatch.
import assert from "node:assert/strict";
import test from "node:test";

import { listWorkflows, getWorkflow, validateWorkflowInputs, runWorkflow } from "../src/app-packs/workflows.js";
import type { LoadedPack } from "../src/app-packs/types.js";
import { McpUiError } from "../src/uia/results.js";

function makePack(overrides: Partial<LoadedPack> = {}): LoadedPack {
  return {
    manifest: {
      schemaVersion: 1,
      id: "fixture",
      displayName: "Fixture",
      version: "1.0.0",
      catalogVisibility: "session"
    },
    profile: { id: "fixture", executableNames: ["Fixture.exe"] },
    controls: { controls: {} },
    actions: { contracts: [] },
    workflows: {
      workflows: [
        {
          id: "public_wf",
          description: "public",
          safe: true,
          tested: true,
          steps: [{ id: "a", tool: "read_clipboard", args: {}, exports: { text: "text" } }]
        },
        {
          id: "hidden_wf",
          visibility: "hidden",
          steps: [{ tool: "read_clipboard", args: {} }]
        }
      ]
    },
    dir: "X:/packs/fixture",
    source: "test",
    sourceKind: "explicit",
    loadedAtMs: Date.now(),
    errors: [],
    ...overrides
  };
}

test("listWorkflows respects visibility", () => {
  const pack = makePack();
  const visible = listWorkflows(pack);
  const ids = visible.map((w) => w.id);
  assert.ok(ids.includes("public_wf"));
  assert.ok(ids.includes("hidden_wf"), "hidden workflows appear in the catalog (flagged)");
  const hidden = visible.find((w) => w.id === "hidden_wf");
  assert.equal(hidden?.visibility, "hidden");
});

test("getWorkflow finds by id", () => {
  const pack = makePack();
  assert.ok(getWorkflow(pack, "public_wf"));
  assert.equal(getWorkflow(pack, "missing"), undefined);
});

test("validateWorkflowInputs enforces required, unknown, enum and nested types", () => {
  const pack = makePack();
  const wf = {
    ...getWorkflow(pack, "public_wf")!,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 2 },
        mode: { type: "string", enum: ["fast", "slow"] },
        count: { type: "integer", minimum: 1 },
        tags: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: { depth: { type: "integer" } }, required: ["depth"] }
      },
      required: ["text"],
      additionalProperties: false
    }
  };
  assert.deepEqual(validateWorkflowInputs(wf, { text: "xy", mode: "fast", count: 2, tags: ["a"], nested: { depth: 1 } }), []);
  // Missing required (the message names the field).
  assert.ok(validateWorkflowInputs(wf, {}).some((e) => e.message.includes("text")));
  // Unknown input (additionalProperties=false) - reported at the root with
  // the field name in the message.
  assert.ok(validateWorkflowInputs(wf, { text: "xy", extra: 1 }).some((e) => e.message.includes("extra")));
  // enum violation.
  assert.ok(validateWorkflowInputs(wf, { text: "xy", mode: "turbo" }).some((e) => e.path.includes("mode")));
  // type violation (count must be an integer).
  assert.ok(validateWorkflowInputs(wf, { text: "xy", count: "2" }).some((e) => e.path.includes("count")));
  // minimum violation.
  assert.ok(validateWorkflowInputs(wf, { text: "xy", count: 0 }).some((e) => e.path.includes("count")));
  // Nested required.
  assert.ok(validateWorkflowInputs(wf, { text: "xy", nested: {} }).some((e) => e.message.includes("depth")));
  // Array item type.
  assert.ok(validateWorkflowInputs(wf, { text: "xy", tags: [1] }).some((e) => e.path.includes("tags")));
});

test("runWorkflow rejects a legacy 'internal' workflow (visibility removed from the schema)", async () => {
  const pack = makePack();
  const wf = { ...getWorkflow(pack, "public_wf")!, visibility: "internal" as never };
  await assert.rejects(
    () => runWorkflow({ pack, workflow: wf, inputs: {}, profile: {} as never, ctx: { dispatch: async () => ({}), expectDeps: {} as never } }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "WORKFLOW_INTERNAL");
      return true;
    }
  );
});

test("runWorkflow rejects invalid inputs before execution with WORKFLOW_INPUT_INVALID", async () => {
  const pack = makePack();
  const wf = { ...getWorkflow(pack, "public_wf")!, inputSchema: { type: "object", properties: { text: {} }, required: ["text"], additionalProperties: false } };
  let dispatched = 0;
  await assert.rejects(
    () => runWorkflow({
      pack, workflow: wf, inputs: {},
      profile: { id: "fixture", displayName: "F", processNames: [], controls: {} },
      ctx: {
        dispatch: async () => { dispatched++; return {}; },
        expectDeps: { getUiElement: async () => ({ found: false, element: null, elapsedMs: 1 }), queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }) }
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "WORKFLOW_INPUT_INVALID");
      const details = error.details as { validationErrors?: Array<{ path: string }> };
      assert.ok(Array.isArray(details?.validationErrors), "structured validationErrors are returned");
      return true;
    }
  );
  assert.equal(dispatched, 0, "no step runs on invalid inputs");
});

test("runWorkflow executes steps and returns exports + runId", async () => {
  const pack = makePack();
  const wf = getWorkflow(pack, "public_wf")!;
  const result = await runWorkflow({
    pack,
    workflow: wf,
    inputs: {},
    profile: { id: "fixture", displayName: "F", processNames: [], controls: {} },
    ctx: {
      dispatch: async (tool) => {
        assert.equal(tool, "read_clipboard");
        return { available: true, text: "wf-marker", length: 9, timestamp: "t" };
      },
      expectDeps: {
        getUiElement: async () => ({ found: false, element: null, elapsedMs: 1 }),
        queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 })
      }
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.exports.text, "wf-marker");
  assert.match(result.runId, /^run_/);
  assert.equal(result.completedSteps.length, 1);
});

test("runWorkflow rejects unknown tools before execution", async () => {
  const pack = makePack();
  const wf = { ...getWorkflow(pack, "public_wf")!, steps: [{ id: "a", tool: "not_a_tool", args: {} }] };
  await assert.rejects(
    () => runWorkflow({ pack, workflow: wf, inputs: {}, profile: {} as never, ctx: { dispatch: async () => ({}), expectDeps: {} as never } }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "UNKNOWN_TOOL");
      return true;
    }
  );
});

test("workflow ${pack.id} is injected server-side", async () => {
  const pack = makePack();
  const wf = {
    ...getWorkflow(pack, "public_wf")!,
    steps: [{ id: "a", tool: "read_clipboard", args: { tag: "${pack.id}" }, exports: { tag: "text" } }]
  };
  // The workflow engine itself doesn't resolve args; the pipeline does. This
  // test verifies the resolution through the engine end to end.
  const result = await runWorkflow({
    pack,
    workflow: wf,
    inputs: {},
    profile: { id: "fixture", displayName: "F", processNames: [], controls: {} },
    ctx: {
      pack: { id: "fixture", actions: { contracts: [] }, profile: { id: "fixture", displayName: "F", processNames: [], controls: {} }, version: "1.0.0" },
      dispatch: async (tool, args) => {
        assert.equal(tool, "read_clipboard");
        assert.equal((args as { tag?: string }).tag, "fixture");
        return { available: true, text: (args as { tag?: string }).tag ?? "", length: 1, timestamp: "t" };
      },
      expectDeps: {
        getUiElement: async () => ({ found: false, element: null, elapsedMs: 1 }),
        queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 })
      }
    }
  });
  assert.equal(result.success, true);
  assert.equal(result.exports.tag, "fixture");
});
