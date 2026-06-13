import assert from "node:assert/strict";

import { readClipboard, writeClipboard } from "../src/windows.js";

console.log("=== Test 1: write_clipboard then read_clipboard ===");
const sample1 = "hello clipboard 你好 こんにちは\nline 2";
const w1 = await writeClipboard({ text: sample1 });
assert.equal(w1.written, true);
assert.equal(w1.length, sample1.length);
console.log("  wrote", w1.length, "chars");

const r1 = await readClipboard({});
assert.equal(r1.available, true);
assert.equal(r1.text, sample1);
console.log("  round-trip OK (length=" + r1.length + ")");

console.log("\n=== Test 2: write empty string ===");
const w2 = await writeClipboard({ text: "" });
assert.equal(w2.written, true);
assert.equal(w2.length, 0);

const r2 = await readClipboard({});
// After writing an empty Unicode text, the format is technically still
// available (empty string), so we accept either available=true with text=""
// or available=false (some Windows versions strip empty text).
console.log("  available after empty write:", r2.available, "text length:", r2.text.length);
assert.equal(r2.text, "");

console.log("\n=== Test 3: large text round-trip ===");
const big = "x".repeat(50_000);
await writeClipboard({ text: big });
const rBig = await readClipboard({});
assert.equal(rBig.available, true);
assert.equal(rBig.text, big);
console.log("  50k chars round-trip OK");

console.log("\n✅ All clipboard smoke tests passed.");
