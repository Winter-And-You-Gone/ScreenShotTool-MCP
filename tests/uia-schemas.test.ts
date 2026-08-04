import assert from "node:assert/strict";
import test from "node:test";

import {
  uiInspectTreeSchema,
  uiQuerySchema,
  uiGetSchema,
  uiActionSchema,
  uiWaitSchema,
  profileListSchema,
  profileResolveSchema,
  profileActionSchema,
  toolInputSchemas
} from "../src/schemas.js";

test("ui_selector requires at least one locator field", () => {
  assert.throws(() => uiQuerySchema.parse({
    pid: 1,
    selector: { visibleOnly: true }
  }));
  assert.throws(() => uiGetSchema.parse({
    pid: 1,
    selector: {}
  }));
});

test("ui_selector accepts automationId/name/controlType/className/frameworkId", () => {
  const q = uiQuerySchema.parse({ pid: 1, selector: { automationId: "foo" } });
  assert.equal(q.selector.automationId, "foo");
  const q2 = uiQuerySchema.parse({ pid: 1, selector: { controlType: "Button", name: "OK" } });
  assert.equal(q2.selector.controlType, "Button");
  assert.equal(q2.selector.name, "OK");
});

test("ui_selector match modes: exact/contains/regex", () => {
  for (const m of ["exact", "contains", "regex"] as const) {
    const q = uiQuerySchema.parse({ pid: 1, selector: { name: "x", match: m } });
    assert.equal(q.selector.match, m);
  }
  assert.throws(() => uiQuerySchema.parse({ pid: 1, selector: { name: "x", match: "fuzzy" } }));
});

test("ui_selector rejects invalid regex", () => {
  // "x" is a valid regex (literal x), so this is accepted.
  const ok = uiQuerySchema.parse({ pid: 1, selector: { name: "x", match: "regex" } });
  assert.equal(ok.selector.match, "regex");
  // A genuinely invalid regex pattern is rejected.
  assert.throws(() => uiQuerySchema.parse({
    pid: 1,
    selector: { name: "(unclosed", match: "regex" }
  }));
  // Valid regex with a regex-only field is accepted
  const q = uiQuerySchema.parse({
    pid: 1,
    selector: { name: "^Save.*", match: "regex" }
  });
  assert.equal(q.selector.match, "regex");
});

test("ui_selector normalizes controlType (Button / ControlType.Button / button)", () => {
  assert.equal(uiQuerySchema.parse({ pid: 1, selector: { controlType: "ControlType.Button" } }).selector.controlType, "Button");
  assert.equal(uiQuerySchema.parse({ pid: 1, selector: { controlType: "button" } }).selector.controlType, "Button");
  assert.equal(uiQuerySchema.parse({ pid: 1, selector: { controlType: "ListItem" } }).selector.controlType, "ListItem");
});

test("ui_selector supports bounded path/ancestor and higher indexes", () => {
  const selector = uiQuerySchema.parse({
    pid: 1,
    selector: {
      automationId: "leaf",
      index: 3,
      ancestor: { automationId: "parent" },
      path: [
        { automationId: "container" },
        { automationId: "leaf" }
      ]
    },
    maxNodes: 5000,
    maxResults: 100
  });
  assert.equal(selector.selector.index, 3);
  assert.equal(selector.selector.path?.length, 2);
  assert.equal(selector.selector.ancestor?.automationId, "parent");
  assert.throws(() => uiQuerySchema.parse({
    pid: 1,
    selector: { automationId: "x", path: Array.from({ length: 13 }, () => ({ automationId: "x" })) }
  }));
});

test("ui_wait validates expected fields and accepts selector index", () => {
  const wait = uiWaitSchema.parse({
    pid: 1,
    selector: { automationId: "item", index: 2 },
    condition: "exists"
  });
  assert.equal(wait.selector.index, 2);
  assert.throws(() => uiWaitSchema.parse({
    pid: 1,
    selector: { automationId: "item" },
    condition: "countEquals",
    expectedCount: -1
  }));
});


test("ui_inspect_tree applies defaults and bounds", () => {
  const t = uiInspectTreeSchema.parse({ pid: 1 });
  assert.equal(t.maxDepth, 10);
  assert.equal(t.maxNodes, 1500);
  assert.equal(t.includeProcessPopups, true);
  assert.equal(t.includePatterns, true);
  assert.equal(t.includeOffscreen, true);
  assert.equal(t.interactiveOnly, false);

  assert.throws(() => uiInspectTreeSchema.parse({ pid: 1, maxDepth: 0 }));
  assert.throws(() => uiInspectTreeSchema.parse({ pid: 1, maxDepth: 31 }));
  assert.throws(() => uiInspectTreeSchema.parse({ pid: 1, maxNodes: 0 }));
  assert.throws(() => uiInspectTreeSchema.parse({ pid: 1, maxNodes: 5001 }));
});

test("ui_inspect_tree requires a window selector", () => {
  assert.throws(() => uiInspectTreeSchema.parse({ maxDepth: 5 }));
});

test("ui_action action enum is enforced", () => {
  assert.equal(uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "invoke" }).action, "invoke");
  assert.throws(() => uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "magic" }));
});

test("ui_action setValue requires value; setRangeValue requires rangeValue", () => {
  assert.throws(() => uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "setValue" }));
  uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "setValue", value: "hi" });
  assert.throws(() => uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "setRangeValue" }));
  uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "setRangeValue", rangeValue: 5 });
});

test("ui_action forceCoordinateClick requires allowCoordinateFallback=true", () => {
  assert.throws(() => uiActionSchema.parse({
    pid: 1, selector: { name: "x" }, action: "click", forceCoordinateClick: true
  }));
  uiActionSchema.parse({
    pid: 1, selector: { name: "x" }, action: "click",
    forceCoordinateClick: true, allowCoordinateFallback: true
  });
});

test("ui_action allowCoordinateFallback defaults to false", () => {
  assert.equal(uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "invoke" }).allowCoordinateFallback, false);
});

test("ui_wait condition enum is enforced", () => {
  assert.equal(uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists" }).condition, "exists");
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "magic" }));
});

test("ui_wait applies timeout/pollInterval bounds and defaults", () => {
  const w = uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists" });
  assert.equal(w.timeoutMs, 10000);
  assert.equal(w.pollIntervalMs, 200);
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists", pollIntervalMs: 10 }));
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists", timeoutMs: 200 }));
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists", timeoutMs: 200000 }));
});

test("ui_wait valueEquals/valueContains require expectedValue", () => {
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "valueEquals" }));
  uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "valueEquals", expectedValue: "done" });
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "countEquals" }));
  uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "countEquals", expectedCount: 2 });
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "toggleStateEquals" }));
  uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "toggleStateEquals", toggleState: "On" });
});

test("ui schemas reject unknown fields (additionalProperties:false)", () => {
  assert.throws(() => uiInspectTreeSchema.parse({ pid: 1, bogus: true }));
  assert.throws(() => uiQuerySchema.parse({ pid: 1, selector: { name: "x" }, bogus: true }));
  assert.throws(() => uiActionSchema.parse({ pid: 1, selector: { name: "x" }, action: "invoke", bogus: true }));
  assert.throws(() => uiWaitSchema.parse({ pid: 1, selector: { name: "x" }, condition: "exists", bogus: true }));
});

test("profile schemas validate", () => {
  assert.deepEqual(profileListSchema.parse({}), {});
  const r = profileResolveSchema.parse({ profile: "example-app", control: "mainWindow", pid: 1234 });
  assert.equal(r.profile, "example-app");
  assert.equal(r.control, "mainWindow");
  const a = profileActionSchema.parse({ profile: "example-app", control: "windowCloseButton", action: "invoke", pid: 1234 });
  assert.equal(a.action, "invoke");
});

test("profile schemas require window selector", () => {
  assert.throws(() => profileResolveSchema.parse({ profile: "example-app", control: "x" }));
  assert.throws(() => profileActionSchema.parse({ profile: "example-app", control: "x", action: "invoke" }));
});

test("JSON schema exposes action and condition enums consistently with Zod", () => {
  const actionEnum = toolInputSchemas.ui_action.properties.action.enum;
  assert.deepEqual(actionEnum, [
    "invoke", "toggle", "select", "addToSelection", "removeFromSelection",
    "expand", "collapse", "setValue", "setRangeValue", "scrollIntoView",
    "focus", "legacyDefaultAction", "click",
    "appendText", "clear", "selectAll", "getValue", "setChecked",
    "increment", "decrement"
  ]);
  const condEnum = toolInputSchemas.ui_wait.properties.condition.enum;
  assert.ok(condEnum.includes("exists"));
  assert.ok(condEnum.includes("countEquals"));
  assert.equal(condEnum.length, 14);
  // selector JSON schema exists and has the locator fields
  const sel = toolInputSchemas.ui_query.properties.selector;
  assert.equal(sel.type, "object");
  assert.ok(sel.properties.automationId);
  assert.ok(sel.properties.controlType);
  assert.ok(sel.properties.path);
});

test("JSON schema default values match Zod defaults", () => {
  assert.equal(toolInputSchemas.ui_inspect_tree.properties.maxDepth.default, 10);
  assert.equal(toolInputSchemas.ui_inspect_tree.properties.maxNodes.default, 1500);
  assert.equal(toolInputSchemas.ui_inspect_tree.properties.includeProcessPopups.default, true);
  assert.equal(toolInputSchemas.ui_wait.properties.timeoutMs.default, 10000);
  assert.equal(toolInputSchemas.ui_wait.properties.pollIntervalMs.default, 200);
  assert.equal(toolInputSchemas.ui_action.properties.allowCoordinateFallback.default, false);
});
