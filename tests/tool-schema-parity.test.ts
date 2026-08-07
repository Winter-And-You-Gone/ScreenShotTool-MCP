// Contract parity tests: the hand-written MCP JSON Schema (tools/list) and the
// Zod runtime acceptance must not drift. Every public tool input with a
// runtime .refine()/.superRefine() constraint must express the same constraint
// in its JSON Schema (allOf/anyOf/required), so a call that passes tools/list
// validation is accepted at runtime and vice versa.
import assert from "node:assert/strict";
import test from "node:test";

import {
  uiQuerySchema,
  uiGetSchema,
  uiActionSchema,
  uiWaitSchema,
  uiInspectTreeSchema,
  uiCatalogSchema,
  clickWindowSchema,
  moveMouseWindowSchema,
  getWindowStateSchema,
  typeTextSchema,
  sendKeySchema,
  waitForWindowSchema,
  profileActionSchema,
  toolInputSchemas,
  type ToolInputSchemas
} from "../src/schemas.js";
import type { JsonSchema } from "../src/contracts.js";

// ── Minimal JSON-Schema validation (draft-07 subset used by the schemas) ──
// Enough to evaluate the anyOf/allOf/required/properties constraints used by
// toolInputSchemas; not a full validator.

type Js = JsonSchema & {
  anyOf?: Js[];
  allOf?: Js[];
  required?: string[];
  properties?: Record<string, Js>;
  enum?: unknown[];
  type?: string | string[];
};

function schemaAllows(schema: Js | undefined, value: unknown): boolean {
  if (!schema) return true;
  // Top-level constraints apply regardless of type.
  if (schema.required) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    for (const r of schema.required) {
      if (!(r in (value as Record<string, unknown>))) return false;
    }
  }
  if (schema.enum && schema.enum.length > 0) {
    if (typeof value !== "string" || !schema.enum.includes(value)) return false;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.includes("object")) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const [k, v] of Object.entries(record)) {
        if (!(k in props)) return false; // additionalProperties:false assumed
        if (!schemaAllows(props[k], v)) return false;
      }
    } else if (types.includes("string")) {
      if (typeof value !== "string") return false;
    } else if (types.includes("integer")) {
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
    } else if (types.includes("boolean")) {
      if (typeof value !== "boolean") return false;
    } else if (types.includes("array")) {
      if (!Array.isArray(value)) return false;
      if (schema.items) {
        for (const item of value) {
          if (!schemaAllows(schema.items as Js, item)) return false;
        }
      }
    }
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((branch) => schemaAllows(branch, value))) return false;
  }
  if (schema.allOf && schema.allOf.length > 0) {
    if (!schema.allOf.every((branch) => schemaAllows(branch, value))) return false;
  }
  return true;
}

// Registered tool input schemas (JSON Schema side).
const jsonSchemas: Record<string, Js> = toolInputSchemas as unknown as Record<string, Js>;

// The Zod schemas with .refine() scope requirements (runtime side).
const zTarget = { pid: 1234 };
const zTargetRef = { targetRef: "target_fixture_1_2" };

function zodAccepts(schema: typeof uiQuerySchema, value: unknown): boolean {
  const r = schema.safeParse(value);
  return r.success;
}

test("ui_query: JSON Schema rejects nameContains-only + target (scope required)", () => {
  const call = { pid: 1234, nameContains: "传感器", maxResults: 40 };
  // Runtime: Zod refine rejects it (scope required).
  assert.equal(zodAccepts(uiQuerySchema, call), false);
  // Public JSON Schema must reject it at tools/list time too.
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), false);
});

test("ui_query: JSON Schema accepts selector + target", () => {
  const call = { pid: 1234, selector: { name: "传感器", match: "contains" } };
  assert.equal(zodAccepts(uiQuerySchema, call), true);
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), true);
});

test("ui_query: JSON Schema accepts rootSelector + target (scope via rootSelector)", () => {
  const call = { pid: 1234, rootSelector: { automationId: "parent" } };
  assert.equal(zodAccepts(uiQuerySchema, call), true);
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), true);
});

test("ui_query: JSON Schema accepts ancestorSelector + target", () => {
  const call = { pid: 1234, ancestorSelector: { automationId: "anc" } };
  assert.equal(zodAccepts(uiQuerySchema, call), true);
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), true);
});

test("ui_query: targetRef satisfies the target requirement on both sides", () => {
  const call = { targetRef: "target_fixture_1_2", selector: { automationId: "x" } };
  assert.equal(zodAccepts(uiQuerySchema, call), true);
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), true);
});

test("ui_query: nameContains + selector + target is valid (nameContains is a filter)", () => {
  const call = { pid: 1234, selector: { controlType: "Button" }, nameContains: "保存" };
  assert.equal(zodAccepts(uiQuerySchema, call), true);
  assert.equal(schemaAllows(jsonSchemas.ui_query, call), true);
});

// ── Target requirement parity: every targetRef-aware tool rejects
// selector-only calls with NO target on both sides. ──

const targetRequiring: Array<[string, typeof uiQuerySchema, Record<string, unknown>]> = [
  ["ui_query", uiQuerySchema, { selector: { automationId: "x" } }],
  ["ui_get", uiGetSchema, { selector: { automationId: "x" } }],
  ["ui_action", uiActionSchema, { selector: { automationId: "x" }, action: "invoke" }],
  ["ui_wait", uiWaitSchema, { selector: { automationId: "x" }, condition: "exists" }],
  ["ui_inspect_tree", uiInspectTreeSchema, {}],
  ["ui_catalog", uiCatalogSchema, {}],
  ["profile_action", profileActionSchema, { profile: "fixture", control: "btn", action: "invoke" }]
];

for (const [tool, zod, args] of targetRequiring) {
  test(`${tool}: JSON Schema and Zod both reject no-target calls`, () => {
    assert.equal(zodAccepts(zod, args), false, `${tool} Zod should reject`);
    assert.equal(schemaAllows(jsonSchemas[tool], args), false, `${tool} JSON Schema should reject`);
  });
  test(`${tool}: JSON Schema and Zod both accept targetRef`, () => {
    const withTarget = { ...args, targetRef: "target_fixture_1_2" };
    assert.equal(zodAccepts(zod, withTarget), true, `${tool} Zod should accept`);
    assert.equal(schemaAllows(jsonSchemas[tool], withTarget), true, `${tool} JSON Schema should accept`);
  });
}

// ── Low-level window tools now accept targetRef on BOTH sides. ──

const lowLevel: Array<[string, typeof clickWindowSchema, Record<string, unknown>]> = [
  ["click_window", clickWindowSchema, { x: 10, y: 10 }],
  ["move_mouse_window", moveMouseWindowSchema, { x: 10, y: 10 }],
  ["get_window_state", getWindowStateSchema, {}],
  ["wait_for_window", waitForWindowSchema, {}],
  ["type_text", typeTextSchema, { text: "hi" }],
  ["send_key", sendKeySchema, { key: "tab" }]
];

for (const [tool, zod, args] of lowLevel) {
  test(`${tool}: targetRef is accepted by Zod and JSON Schema`, () => {
    const withRef = { ...args, targetRef: "target_fixture_1_2" };
    assert.equal(zod.safeParse(withRef).success, true, `${tool} Zod should accept targetRef`);
    assert.equal(schemaAllows(jsonSchemas[tool], withRef), true, `${tool} JSON Schema should accept targetRef`);
  });
  test(`${tool}: no-target call rejected by both sides`, () => {
    assert.equal(zod.safeParse(args).success, false, `${tool} Zod should reject`);
    assert.equal(schemaAllows(jsonSchemas[tool], args), false, `${tool} JSON Schema should reject`);
  });
}
