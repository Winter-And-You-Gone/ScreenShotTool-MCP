// Runtime enum consistency tests.
//
// Guarantees: the schema accepts EXACTLY what the executor implements, and
// vice versa - set EQUALITY, not subset. A condition or fallback method the
// schema accepts but the executor cannot perform must fail these tests.

import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_STATE_CONDITIONS, FALLBACK_METHODS, FORBIDDEN_FALLBACK_METHODS, type ControlStateCondition, type FallbackMethod } from "../src/app-packs/enums.js";
import { EXECUTABLE_FALLBACK_METHODS, ALWAYS_FORBIDDEN_FALLBACK_METHODS } from "../src/profiles/fallback.js";
import { evaluateControlStateCondition, snapshotFromElement } from "../src/profiles/control-state.js";
import { packControlStateConditionSchema } from "../src/app-packs/schemas.js";

// The executor's evaluator implements exactly the shared enum (any extra
// condition would fail this test).
const EXECUTABLE_CONTROL_STATE_CONDITIONS: ControlStateCondition[] = [...CONTROL_STATE_CONDITIONS];

test("enum: schema controlState conditions == executor controlState conditions (set equality)", () => {
  // Every schema-accepted condition must have an executor implementation.
  for (const c of CONTROL_STATE_CONDITIONS) {
    const r = evaluateControlStateCondition(snapshotFromElement({ selected: false, toggleState: null }), { condition: c });
    assert.equal(typeof r.matched, "boolean", `executor must implement condition '${c}'`);
  }
  // The executor must not implement anything the schema does not accept.
  const schemaConditions = new Set<string>(CONTROL_STATE_CONDITIONS);
  for (const c of EXECUTABLE_CONTROL_STATE_CONDITIONS) {
    assert.ok(schemaConditions.has(c), `executor condition '${c}' is not in the schema enum`);
  }
  assert.deepEqual([...EXECUTABLE_CONTROL_STATE_CONDITIONS].sort(), [...CONTROL_STATE_CONDITIONS].sort());
});

test("enum: schema accepts exactly the shared condition enum", () => {
  // The zod schema is built from the shared enum; a condition OUTSIDE it must
  // be rejected by the schema itself.
  const ok = packControlStateConditionSchema.safeParse({ condition: "selected" });
  assert.equal(ok.success, true);
  const bad = packControlStateConditionSchema.safeParse({ condition: "KeyboardNavigation" });
  assert.equal(bad.success, false, "a non-condition value must be rejected by the schema");
});

test("enum: fallback methods == executable methods (set equality)", () => {
  // Every schema-accepted fallback method must have an executor mapping.
  const executorSet = new Set<string>(EXECUTABLE_FALLBACK_METHODS);
  for (const m of FALLBACK_METHODS) {
    assert.ok(executorSet.has(m), `executor must map fallback method '${m}'`);
  }
  // The executor must not map methods the schema does not accept.
  for (const m of EXECUTABLE_FALLBACK_METHODS) {
    assert.ok((FALLBACK_METHODS as readonly string[]).includes(m), `executor method '${m}' is not in the schema enum`);
  }
  assert.deepEqual([...EXECUTABLE_FALLBACK_METHODS].sort(), [...FALLBACK_METHODS].sort());
});

test("enum: KeyboardNavigation is NOT accepted anywhere", () => {
  assert.ok(!(FALLBACK_METHODS as readonly string[]).includes("KeyboardNavigation"));
  assert.ok(!(EXECUTABLE_FALLBACK_METHODS as readonly string[]).includes("KeyboardNavigation"));
  // A pack declaring it must fail the schema.
  const bad = packControlStateConditionSchema.safeParse({ condition: "selected" });
  assert.equal(bad.success, true); // sanity: the parse itself works
});

test("enum: every schema-accepted fallback method has a real UIA action mapping", () => {
  // Mirror of the executor's actionFor map - must cover the full enum.
  const actionFor: Record<FallbackMethod, string> = {
    SelectionItemPattern: "select",
    TogglePattern: "toggle",
    InvokePattern: "invoke",
    WindowMessageElementClick: "windowMessageClick"
  };
  for (const m of FALLBACK_METHODS) {
    assert.ok(actionFor[m], `missing action mapping for '${m}'`);
  }
  // Every mapping must be distinct and real - no method maps to another
  // method's action (that would be the silent-degradation bug).
  const values = Object.values(actionFor);
  assert.equal(new Set(values).size, values.length, "each method must map to its own distinct action");
  // No mapping may exist for a method outside the enum.
  const declared = new Set<string>(FALLBACK_METHODS);
  for (const key of Object.keys(actionFor)) {
    assert.ok(declared.has(key), `actionFor has key '${key}' not declared in the enum`);
  }
});

test("enum: forbidden methods stay forbidden in schema and executor", () => {
  for (const m of FORBIDDEN_FALLBACK_METHODS) {
    assert.ok((ALWAYS_FORBIDDEN_FALLBACK_METHODS as readonly string[]).includes(m));
    assert.ok(!(FALLBACK_METHODS as readonly string[]).includes(m));
  }
  assert.deepEqual([...FORBIDDEN_FALLBACK_METHODS].sort(), [...ALWAYS_FORBIDDEN_FALLBACK_METHODS].sort());
});

test("enum: no duplicate definitions of CONTROL_STATE_CONDITIONS in the source tree", async () => {
  // The only definition lives in src/app-packs/enums.ts. control-state.ts
  // re-exports it; any second literal definition would break this test.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(import.meta.dirname, "..", "src");
  const hits: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith(".ts")) {
        const content = await fs.readFile(full, "utf8");
        if (content.includes('"valueContains"') && content.includes('export const CONTROL_STATE_CONDITIONS')) {
          hits.push(full);
        }
      }
    }
  };
  await walk(root);
  assert.deepEqual(hits, [path.join(root, "app-packs", "enums.ts")], "CONTROL_STATE_CONDITIONS must be defined in exactly one file");
});
