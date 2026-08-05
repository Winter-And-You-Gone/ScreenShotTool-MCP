// Unit tests for the ToolContract infrastructure (src/contracts.ts) and the
// output validation layer (src/outputs.ts): outputSchema runtime checks,
// sensitive field guards, and contract table completeness.
import assert from "node:assert/strict";
import test from "node:test";

import { getContract, contracts, chainableContracts, toMcpToolDefinition, contractExamples } from "../src/contracts.js";
import { validateAgainstSchema, isSensitiveFieldName, walkLeaves } from "../src/outputs.js";

test("every tool contract has inputSchema, outputSchema and pipeSafeFields", () => {
  const names = Object.keys(contracts);
  assert.ok(names.length >= 30, `expected a full tool table, got ${names.length}`);
  for (const name of names) {
    const c = contracts[name]!;
    assert.equal(c.name, name);
    assert.ok(c.description.length > 10, `${name} needs a description`);
    assert.ok(c.inputSchema, `${name} needs inputSchema`);
    assert.ok(c.outputSchema, `${name} needs outputSchema`);
    assert.ok(Array.isArray(c.pipeSafeFields), `${name} needs pipeSafeFields`);
    assert.equal(c.schemaVersion, 1);
  }
});

test("required pipeline tools are all present", () => {
  for (const required of [
    "launch_app", "list_windows", "capture_window", "wait_for_window", "ui_inspect_tree",
    "ui_catalog", "ui_query", "ui_get", "ui_action", "ui_wait",
    "profile_launch", "profile_list", "profile_resolve", "profile_action",
    "app_pack_list", "app_pack_describe", "app_pack_validate", "app_pack_reload", "app_pack_probe",
    "validate_steps", "run_steps", "profile_run_steps", "workflow_catalog", "run_workflow", "continue_run"
  ]) {
    assert.ok(contracts[required], `missing contract: ${required}`);
  }
});

test("orchestration tools are not chainable (no nesting)", () => {
  for (const excluded of ["run_steps", "profile_run_steps", "run_workflow", "continue_run", "validate_steps"]) {
    assert.ok(!chainableContracts.includes(excluded), `${excluded} must not be chainable`);
  }
  assert.ok(chainableContracts.includes("ui_action"));
  assert.ok(chainableContracts.includes("app_pack_list"));
});

test("validateAgainstSchema checks required fields and types", () => {
  const schema = {
    type: "object",
    properties: {
      pid: { type: "integer" },
      title: { type: "string" },
      window: { type: "object", properties: { hwnd: { type: "string" } }, required: ["hwnd"] }
    },
    required: ["pid", "title"]
  };
  assert.equal(validateAgainstSchema({ pid: 1, title: "x", window: { hwnd: "9" } }, schema).ok, true);
  assert.equal(validateAgainstSchema({ title: "x" }, schema).ok, false, "missing required pid");
  assert.equal(validateAgainstSchema({ pid: "1", title: "x" }, schema).ok, false, "wrong type");
  assert.equal(validateAgainstSchema({ pid: 1, title: "x", window: {} }, schema).ok, false, "nested required missing");
  // Extra fields are allowed (forward compatibility).
  assert.equal(validateAgainstSchema({ pid: 1, title: "x", extra: true }, schema).ok, true);
});

test("validateAgainstSchema handles arrays and enums", () => {
  const arrSchema = { type: "array", items: { type: "string" } };
  assert.equal(validateAgainstSchema(["a", "b"], arrSchema).ok, true);
  assert.equal(validateAgainstSchema([1], arrSchema).ok, false);
  const enumSchema = { type: "string", enum: ["a", "b"] };
  assert.equal(validateAgainstSchema("a", enumSchema).ok, true);
  assert.equal(validateAgainstSchema("c", enumSchema).ok, false);
});

test("isSensitiveFieldName blocks password/token/credential/secret/authorization/cookie", () => {
  assert.equal(isSensitiveFieldName(["user", "password"]), true);
  assert.equal(isSensitiveFieldName(["access", "token"]), true);
  assert.equal(isSensitiveFieldName(["api", "secret"]), true);
  assert.equal(isSensitiveFieldName(["authorization"]), true);
  assert.equal(isSensitiveFieldName(["session", "cookie"]), true);
  assert.equal(isSensitiveFieldName(["credential", "value"]), true);
  assert.equal(isSensitiveFieldName(["pid"]), false);
  assert.equal(isSensitiveFieldName(["window", "hwnd"]), false);
});

test("walkLeaves visits every leaf path", () => {
  const leaves: string[][] = [];
  walkLeaves({ a: { b: 1 }, c: [2, { d: "x" }] }, (path, value) => leaves.push([...path, String(value)]));
  assert.deepEqual(leaves.sort(), [
    ["a", "b", "1"],
    ["c", "0", "2"],
    ["c", "1", "d", "x"]
  ]);
});

test("launch_profile output schema matches the real result shape", () => {
  const schema = contracts.profile_launch!.outputSchema;
  const ok = validateAgainstSchema(
    { profile: "notepad", pid: 123, hwnd: "99", title: "x", startedByMcp: true, reused: false, uiaRootAvailable: true },
    schema
  );
  assert.equal(ok.ok, true);
  const bad = validateAgainstSchema({ pid: 123 }, schema);
  assert.equal(bad.ok, false, "profile is required");
});

test("ui_get outputSchema tolerates null element state fields (unsupported patterns)", () => {
  // Providers report null for unsupported patterns (e.g. value/toggleState
  // on a plain Pane); the output schema must accept them.
  const schema = contracts.ui_get!.outputSchema;
  const ok = validateAgainstSchema(
    { found: true, element: { automationId: "pane", value: null, toggleState: null, selected: null, selectedName: null, selectedIndex: null, isPassword: false, valueProtected: false }, elapsedMs: 1 },
    schema
  );
  assert.equal(ok.ok, true, `null element state must validate: ${JSON.stringify(ok)}`);
  // element itself may be null (found:false).
  const notFound = validateAgainstSchema({ found: false, element: null, elapsedMs: 1 }, schema);
  assert.equal(notFound.ok, true);
});

test("getContract returns undefined for unknown tools", () => {
  assert.equal(getContract("not_a_tool"), undefined);
  assert.equal(getContract("run_steps")?.name, "run_steps");
});

// ── MCP tools/list exposure ──

test("toMcpToolDefinition exposes outputSchema + standard annotations", () => {
  for (const name of Object.keys(contracts)) {
    const def = toMcpToolDefinition(contracts[name]!);
    assert.ok(def.outputSchema, `${name} must expose outputSchema`);
    assert.equal(def.outputSchema.type, "object", "MCP requires an object-root outputSchema");
    assert.ok(def.annotations, `${name} must expose annotations`);
    assert.ok(typeof def.annotations.openWorldHint === "boolean", "openWorldHint is set for desktop-automation tools");
    // readOnlyHint maps from the internal readOnly annotation.
    if (contracts[name]!.annotations?.readOnly !== undefined) {
      assert.equal(def.annotations.readOnlyHint, contracts[name]!.annotations!.readOnly);
    }
    // pipeSafeFields ride along in _meta.
    assert.deepEqual(def._meta?.pipeSafeFields, contracts[name]!.pipeSafeFields);
  }
});

test("array tools expose {items} object-root schemas (MCP compatible)", () => {
  const def = toMcpToolDefinition(contracts.list_windows!);
  assert.equal(def.outputSchema.type, "object");
  assert.equal(def.outputSchema.properties?.items?.type, "array");
  assert.ok(def.outputSchema.required?.includes("items"));
});

test("contractExamples derives result paths from pipeSafeFields", () => {
  const ex = contractExamples(contracts.profile_launch!);
  assert.ok(ex.some((e) => e.resultPath === "pid" && e.type === "integer"));
  assert.ok(ex.some((e) => e.resultPath === "hwnd" && e.type === "string"));
});

test("internal-only annotations are not leaked through tools/list annotations", () => {
  const def = toMcpToolDefinition(contracts.ui_action!);
  const keys = Object.keys(def.annotations);
  assert.ok(!keys.includes("needsExpect"), "needsExpect is internal");
  assert.ok(!keys.includes("retrySafe"), "retrySafe is internal");
  // ...but the full internal annotations ARE available via the describe
  // surface (tool_contract_describe implementation uses contracts directly).
  assert.equal(contracts.ui_action!.annotations?.needsExpect, true);
});
