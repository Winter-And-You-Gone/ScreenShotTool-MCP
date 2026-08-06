// Unit tests for the unified tool executor (src/executor.ts):
//   - every tool call goes through read contract -> validate input ->
//     dispatch -> validate output
//   - an output that violates its outputSchema raises
//     TOOL_OUTPUT_SCHEMA_MISMATCH with structured validationErrors and the
//     value is discarded (never passed on)
//   - business errors are NOT forced through the success outputSchema
import assert from "node:assert/strict";
import test from "node:test";

import { executeValidatedTool, ToolOutputSchemaMismatchError, type ToolExecutorContext } from "../src/executor.js";
import { McpUiError } from "../src/uia/results.js";

// A valid profile_launch dispatch result (the output schema requires the
// interaction report since the interaction-policy work).
const LAUNCH_RESULT = {
  profile: "x",
  pid: 1,
  title: "x",
  startedByMcp: true,
  reused: false,
  uiaRootAvailable: true,
  interaction: {
    requestedMode: "auto",
    effectiveMode: "background",
    foregroundChanged: false,
    targetActivated: false,
    physicalCursorMoved: false
  }
};

function makeCtx(opts: {
  parseInput?: ToolExecutorContext["parseInput"];
  dispatch: (tool: string, input: unknown) => Promise<unknown>;
}): ToolExecutorContext {
  return {
    parseInput: opts.parseInput ?? ((tool, args) => {
      // Minimal input validation: unknown tool rejected, else pass through.
      if (tool === "not_a_tool") return { ok: false, message: "unknown tool" };
      return { ok: true, value: args };
    }),
    dispatch: opts.dispatch
  };
}

test("valid output passes through unchanged", async () => {
  const ctx = makeCtx({ dispatch: async () => LAUNCH_RESULT });
  const result = await executeValidatedTool("profile_launch", { profile: "x" }, ctx);
  assert.deepEqual(result, LAUNCH_RESULT);
});

test("invalid output raises TOOL_OUTPUT_SCHEMA_MISMATCH with structured errors", async () => {
  const ctx = makeCtx({
    dispatch: async () => ({ pid: "not-a-number", title: "x" }) // pid must be integer
  });
  await assert.rejects(
    () => executeValidatedTool("profile_launch", { profile: "x" }, ctx),
    (error: unknown) => {
      assert.ok(error instanceof ToolOutputSchemaMismatchError);
      assert.equal(error.code, "TOOL_OUTPUT_SCHEMA_MISMATCH");
      assert.equal(error.tool, "profile_launch");
      assert.equal(error.schemaVersion, 1);
      assert.ok(Array.isArray(error.validationErrors));
      assert.ok(error.validationErrors!.some((e) => e.path.includes("pid")), JSON.stringify(error.validationErrors));
      return true;
    }
  );
});

test("array tools validate against the object-root {items} schema", async () => {
  // list_windows declares { items: [...] } publicly; the unified executor
  // normalizes the raw array to the canonical { items: [...] } object so
  // plain calls, structuredContent, pipeline references and exports all see
  // the SAME shape (old ${0.0.hwnd} references stay compatible via the
  // reference resolver's items-compat).
  const ctx = makeCtx({
    dispatch: async () => [{ hwnd: "1", title: "a", pid: 1, processName: "p", className: "c", rect: { x: 0, y: 0, width: 1, height: 1 } }]
  });
  const result = await executeValidatedTool("list_windows", {}, ctx);
  assert.deepEqual(result, { items: [{ hwnd: "1", title: "a", pid: 1, processName: "p", className: "c", rect: { x: 0, y: 0, width: 1, height: 1 } }] }, "the canonical {items} object is returned");

  const bad = makeCtx({ dispatch: async () => [{ hwnd: 42 }] }); // missing fields + wrong type
  await assert.rejects(
    () => executeValidatedTool("list_windows", {}, bad),
    (error: unknown) => {
      assert.ok(error instanceof ToolOutputSchemaMismatchError);
      return true;
    }
  );
});

test("business errors propagate as-is (not forced through the success schema)", async () => {
  const ctx = makeCtx({
    dispatch: async () => { throw new McpUiError("ELEMENT_NOT_FOUND", "missing"); }
  });
  await assert.rejects(
    () => executeValidatedTool("ui_get", { selector: { automationId: "x" }, pid: 1 }, ctx),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "ELEMENT_NOT_FOUND");
      return true;
    }
  );
});

test("input validation failures raise InvalidParams before dispatch", async () => {
  let dispatched = false;
  const ctx = makeCtx({
    parseInput: (tool, args) => {
      void tool;
      if ((args as { bad?: boolean })?.bad) return { ok: false, message: "bad input" };
      return { ok: true, value: args };
    },
    dispatch: async () => { dispatched = true; return LAUNCH_RESULT; }
  });
  await assert.rejects(
    () => executeValidatedTool("profile_launch", { bad: true }, ctx),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, -32602); // InvalidParams
      return true;
    }
  );
  assert.equal(dispatched, false, "dispatch must not run when input is invalid");
});

test("unknown tools raise MethodNotFound", async () => {
  const ctx = makeCtx({
    dispatch: async () => { throw new Error("unused"); }
  });
  await assert.rejects(
    () => executeValidatedTool("nope", {}, ctx),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, -32601); // MethodNotFound
      return true;
    }
  );
});
