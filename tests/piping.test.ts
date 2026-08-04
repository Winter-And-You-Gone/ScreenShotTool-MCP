import assert from "node:assert/strict";
import test from "node:test";

import { resolvePlaceholders, validateReferences } from "../src/piping.js";

test("resolvePlaceholders passes through literals and primitives unchanged", () => {
  assert.deepEqual(resolvePlaceholders({}, []).value, {});
  assert.deepEqual(resolvePlaceholders({ a: 1, b: true, c: null }, []).value, { a: 1, b: true, c: null });
  assert.equal(resolvePlaceholders("plain string", []).value, "plain string");
  assert.equal(resolvePlaceholders(42, []).value, 42);
  // A string containing ${ but not matching the strict pattern is literal.
  assert.equal(resolvePlaceholders("${not-a-ref}", []).value, "${not-a-ref}");
  assert.equal(resolvePlaceholders("price is $5", []).value, "price is $5");
});

test("whole-value placeholder preserves the referenced type", () => {
  const results = [{ pid: 1234, hwnd: "999", ok: true, list: [1, 2, 3] }];
  assert.equal(resolvePlaceholders("${0.pid}", results).value, 1234);
  assert.equal(resolvePlaceholders("${0.hwnd}", results).value, "999");
  assert.equal(resolvePlaceholders("${0.ok}", results).value, true);
  assert.deepEqual(resolvePlaceholders("${0.list}", results).value, [1, 2, 3]);
  // ${N} with no path returns the entire result object.
  assert.deepEqual(resolvePlaceholders("${0}", results).value, results[0]);
});

test("embedded placeholder stringifies the referenced value", () => {
  const results = [{ pid: 1234, hwnd: "999" }];
  assert.equal(resolvePlaceholders("pid-${0.pid}", results).value, "pid-1234");
  assert.equal(resolvePlaceholders("${0.hwnd}!", results).value, "999!");
  assert.equal(resolvePlaceholders("${0.pid}-${0.hwnd}", results).value, "1234-999");
  // Object embedded -> JSON stringified.
  assert.equal(resolvePlaceholders("obj=${0}", results).value, `obj=${JSON.stringify(results[0])}`);
});

test("resolvePlaceholders walks nested objects and arrays", () => {
  const results = [{ pid: 7 }];
  const r = resolvePlaceholders({ outer: { pid: "${0.pid}", list: ["${0.pid}", "literal"] } }, results);
  assert.deepEqual(r.value, { outer: { pid: 7, list: [7, "literal"] } });
});

test("resolvePlaceholders resolves array indices via numeric path segments", () => {
  const results = [{ windows: [{ hwnd: "a" }, { hwnd: "b" }] }];
  assert.equal(resolvePlaceholders("${0.windows.0.hwnd}", results).value, "a");
  assert.equal(resolvePlaceholders("${0.windows.1.hwnd}", results).value, "b");
});

test("resolution fails when a referenced field is absent", () => {
  const results = [{ pid: 1 }];
  const r = resolvePlaceholders("${0.missing}", results);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no field 'missing'/);
});

test("resolution fails when traversal hits null mid-path", () => {
  const results = [{ window: null }];
  const r = resolvePlaceholders("${0.window.hwnd}", results);
  assert.equal(r.ok, false);
  assert.match(r.reason, /null at '0.window'/);
});

test("resolution fails on an out-of-range array index", () => {
  const results = [{ items: ["x"] }];
  const r = resolvePlaceholders("${0.items.5}", results);
  assert.equal(r.ok, false);
  assert.match(r.reason, /array index '5' out of range/);
});

test("resolution fails when indexing into a primitive", () => {
  const results = [{ pid: 5 }];
  const r = resolvePlaceholders("${0.pid.subfield}", results);
  assert.equal(r.ok, false);
  assert.match(r.reason, /cannot index into number/);
});

test("resolution fails when the referenced step has no result yet", () => {
  // Only step 0 has a result; step 1 hasn't run.
  const r = resolvePlaceholders("${1.pid}", [{}]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /step 1 which has no result/);
});

test("a resolution failure stops the walk and returns the first error", () => {
  const results = [{ good: 1 }];
  const r = resolvePlaceholders({ a: "${0.good}", b: "${0.bad}", c: "${0.alsoBad}" }, results);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no field 'bad'/);
});

test("validateReferences accepts backward and no references", () => {
  assert.equal(validateReferences([{ tool: "t", args: {} }]).ok, true);
  // Step 1 referencing step 0 is a valid backward reference.
  assert.equal(validateReferences([
    { tool: "t", args: {} },
    { tool: "t", args: { pid: "${0.pid}" } }
  ]).ok, true);
  // Step 2 referencing steps 0 and 1 is fine.
  assert.equal(validateReferences([
    { tool: "t", args: {} },
    { tool: "t", args: {} },
    { tool: "t", args: { a: "${0.x}", b: "${1.y}" } }
  ]).ok, true);
});

test("validateReferences rejects forward and self references", () => {
  // Self-reference: step 0 references step 0.
  let v = validateReferences([{ tool: "t", args: { pid: "${0.pid}" } }]);
  assert.equal(v.ok, false);
  assert.match(v.message, /step 0 references step 0/);

  // Forward reference: step 1 references step 2.
  v = validateReferences([
    { tool: "t", args: {} },
    { tool: "t", args: { pid: "${2.pid}" } },
    { tool: "t", args: {} }
  ]);
  assert.equal(v.ok, false);
  assert.match(v.message, /step 1 references step 2/);
});

test("validateReferences reports multiple violations at once", () => {
  const v = validateReferences([
    { tool: "t", args: { a: "${1.x}" } },
    { tool: "t", args: { b: "${2.y}" } }
  ]);
  assert.equal(v.ok, false);
  assert.match(v.message, /step 0 references step 1/);
  assert.match(v.message, /step 1 references step 2/);
});

test("validateReferences ignores non-matching ${...} strings", () => {
  // A PowerShell-style variable should not be treated as a reference.
  assert.equal(validateReferences([
    { tool: "t", args: { cmd: "echo ${env:PATH}" } }
  ]).ok, true);
});
