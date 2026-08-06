// Unit tests for the scroll-direction logic and finite RangeValue stepping.
// Pure functions only - no UIA, no real application.

import assert from "node:assert/strict";
import test from "node:test";

import { determineScrollDirection, nextRangeValueStep } from "../src/profiles/visibility.js";

const viewport = { x: 100, y: 100, width: 800, height: 600 }; // screen space

test("direction: element below the viewport -> forward", () => {
  const below = { x: 200, y: 800, width: 100, height: 50 };
  assert.equal(determineScrollDirection(below, viewport, 0), "forward");
});

test("direction: element above the viewport -> backward", () => {
  const above = { x: 200, y: 20, width: 100, height: 50 };
  assert.equal(determineScrollDirection(above, viewport, 0), "backward");
});

test("direction: fully visible element -> none", () => {
  const inside = { x: 200, y: 200, width: 100, height: 50 };
  assert.equal(determineScrollDirection(inside, viewport, 0), "none");
});

test("direction: margin affects the decision", () => {
  // Element bottom exactly at viewport bottom (no margin): fully visible.
  const edge = { x: 200, y: 100, width: 100, height: 600 };
  assert.equal(determineScrollDirection(edge, viewport, 0), "none");
  // With margin 24 the same element pokes outside -> forward.
  assert.equal(determineScrollDirection(edge, viewport, 24), "forward");
  // Element top exactly at viewport top: fine with margin 0, backward with margin.
  const topEdge = { x: 200, y: 100, width: 100, height: 50 };
  assert.equal(determineScrollDirection(topEdge, viewport, 0), "none");
  assert.equal(determineScrollDirection(topEdge, viewport, 24), "backward");
});

test("direction: missing rects -> none (never guesses)", () => {
  assert.equal(determineScrollDirection(null, viewport, 0), "none");
  assert.equal(determineScrollDirection({ x: 1, y: 1, width: 10, height: 10 }, null, 0), "none");
  assert.equal(determineScrollDirection(undefined, undefined, 0), "none");
});

test("step: forward increases the value by a finite step (never jumps to maximum)", () => {
  const range = { minimum: 0, maximum: 1000, smallChange: 10, largeChange: 100 };
  const next = nextRangeValueStep(200, "forward", range);
  assert.equal(next, 300); // largeChange preferred
  assert.ok(next < range.maximum, "must not jump straight to maximum");
});

test("step: backward decreases the value by a finite step (never jumps to minimum)", () => {
  const range = { minimum: 0, maximum: 1000, smallChange: 10, largeChange: 100 };
  const next = nextRangeValueStep(800, "backward", range);
  assert.equal(next, 700);
  assert.ok(next > range.minimum, "must not jump straight to minimum");
});

test("step: falls back smallChange -> range proportion -> minimal step", () => {
  assert.equal(nextRangeValueStep(100, "forward", { minimum: 0, maximum: 1000, smallChange: 10 }), 110);
  assert.equal(nextRangeValueStep(100, "forward", { minimum: 0, maximum: 1000 }), 200); // 10% of span
  // Zero-span range: proportional step is 0 -> minimal safe step (1), but the
  // maximum clamps the result to the current value (no progress possible).
  assert.equal(nextRangeValueStep(100, "forward", { minimum: 100, maximum: 100 }), 100);
  // Minimal-step path visible when the max still allows progress: span 0.5,
  // current 0 -> proportion 0.05 floors to the 1-unit minimal step, clamped
  // to max 0.5.
  assert.equal(nextRangeValueStep(0, "forward", { minimum: 0, maximum: 0.5 }), 0.5);
});

test("step: clamps at minimum/maximum", () => {
  assert.equal(nextRangeValueStep(990, "forward", { minimum: 0, maximum: 1000, largeChange: 100 }), 1000);
  assert.equal(nextRangeValueStep(10, "backward", { minimum: 0, maximum: 1000, largeChange: 100 }), 0);
});

test("step: forward/backward mapping is symmetric", () => {
  const range = { minimum: 0, maximum: 1000, smallChange: 10, largeChange: 100 };
  assert.equal(nextRangeValueStep(500, "forward", range), 600);
  assert.equal(nextRangeValueStep(600, "backward", range), 500);
});
