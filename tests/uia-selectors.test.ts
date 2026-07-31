import assert from "node:assert/strict";
import test from "node:test";

import {
  hasLocator,
  normalizeControlType,
  validateRegex,
  selectorSummary,
  MAX_REGEX_LEN
} from "../src/uia/selectors.js";
import type { UiElementSelector } from "../src/uia/types.js";
import { buildCandidateSummary, ambiguityError, notFoundError, isUiError } from "../src/uia/results.js";

test("hasLocator requires at least one locator field", () => {
  assert.equal(hasLocator(undefined), false);
  assert.equal(hasLocator({}), false);
  assert.equal(hasLocator({ visibleOnly: true, index: 0 }), false);
  assert.equal(hasLocator({ automationId: "foo" }), true);
  assert.equal(hasLocator({ name: "bar" }), true);
  assert.equal(hasLocator({ controlType: "Button" }), true);
  assert.equal(hasLocator({ className: "Qt" }), true);
  assert.equal(hasLocator({ frameworkId: "Win32" }), true);
  assert.equal(hasLocator({ path: [{ automationId: "x" }] }), true);
  assert.equal(hasLocator({ ancestor: { name: "parent" } }), true);
});

test("hasLocator does not treat empty strings as locators", () => {
  assert.equal(hasLocator({ automationId: "" }), false);
  assert.equal(hasLocator({ name: "" }), false);
});

test("normalizeControlType accepts short, full, and lowercase forms", () => {
  assert.equal(normalizeControlType("Button"), "Button");
  assert.equal(normalizeControlType("ControlType.Button"), "Button");
  assert.equal(normalizeControlType("button"), "Button");
  assert.equal(normalizeControlType("ListItem"), "ListItem");
  assert.equal(normalizeControlType("controltype.edit"), "Edit");
  assert.equal(normalizeControlType(undefined), undefined);
  assert.equal(normalizeControlType("   "), undefined);
});

test("normalizeControlType preserves unknown provider types", () => {
  assert.equal(normalizeControlType("SomeCustomType"), "SomeCustomType");
});

test("validateRegex rejects invalid regex and over-length patterns", () => {
  assert.equal(validateRegex("foo.*bar"), null);
  assert.equal(validateRegex("^a+b?$"), null);
  assert.notEqual(validateRegex("(unclosed"), null);
  assert.notEqual(validateRegex("[invalid"), null);
  const tooLong = "a".repeat(MAX_REGEX_LEN + 1);
  assert.notEqual(validateRegex(tooLong), null);
});

test("selectorSummary produces a readable one-liner", () => {
  const s: UiElementSelector = { automationId: "btn", controlType: "Button", match: "exact" };
  const summary = selectorSummary(s);
  assert.ok(summary.includes("automationId=btn"));
  assert.ok(summary.includes("controlType=Button"));
  assert.ok(summary.includes("match=exact"));
  assert.equal(selectorSummary(undefined), "<empty>");
});

test("buildCandidateSummary caps at MAX_CANDIDATES", () => {
  const elements = Array.from({ length: 25 }, (_, i) => ({
    automationId: `id${i}`,
    name: `n${i}`,
    controlType: "Button",
    className: "",
    frameworkId: "Qt",
    processId: 1,
    nativeWindowHandle: "",
    enabled: true,
    offscreen: false,
    focusable: true,
    hasKeyboardFocus: false,
    isPassword: false,
    isReadOnly: null,
    boundingRect: null,
    runtimeId: [i],
    patterns: [],
    value: null,
    rangeValue: null,
    minimum: null,
    maximum: null,
    smallChange: null,
    largeChange: null,
    toggleState: null,
    selected: null,
    expandCollapseState: null
  }));
  const summary = buildCandidateSummary(elements);
  assert.equal(summary.length, 10);
  assert.equal(summary[0]!.automationId, "id0");
});

test("ambiguityError carries code ELEMENT_AMBIGUOUS and candidate count", () => {
  const err = ambiguityError({ name: "x" }, [
    {
      automationId: "a", name: "x", controlType: "Button", className: "", frameworkId: "",
      processId: 1, nativeWindowHandle: "", enabled: true, offscreen: false, focusable: true,
      hasKeyboardFocus: false, isPassword: false, isReadOnly: null, boundingRect: null,
      runtimeId: [1], patterns: [], value: null, rangeValue: null, minimum: null, maximum: null,
      smallChange: null, largeChange: null, toggleState: null, selected: null, expandCollapseState: null
    }
  ]);
  assert.equal(err.ok, false);
  assert.equal(err.code, "ELEMENT_AMBIGUOUS");
  assert.equal(err.details?.candidateCount, 1);
});

test("notFoundError carries code ELEMENT_NOT_FOUND", () => {
  const err = notFoundError({ automationId: "missing" });
  assert.equal(err.code, "ELEMENT_NOT_FOUND");
  assert.ok(err.message.includes("No element matched"));
});

test("isUiError detects structured errors", () => {
  assert.equal(isUiError({ ok: false, code: "X", message: "y" }), true);
  assert.equal(isUiError({ ok: true, result: 1 }), false);
  assert.equal(isUiError(new Error("boom")), false);
  assert.equal(isUiError(null), false);
});
