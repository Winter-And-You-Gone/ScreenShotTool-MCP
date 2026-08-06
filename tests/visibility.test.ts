// Unit tests for the visibility geometry (pure functions only).

import assert from "node:assert/strict";
import test from "node:test";

import { isRectFullyVisible, evaluateVisibility, toRect } from "../src/profiles/visibility.js";

const viewport = { x: 100, y: 100, width: 800, height: 600 }; // screen space

test("visibility: fully inside the viewport", () => {
  const rect = { x: 200, y: 200, width: 100, height: 50 };
  assert.equal(isRectFullyVisible(rect, viewport, 0), true);
});

test("visibility: bottom edge exceeds viewport by 1px", () => {
  const rect = { x: 200, y: 100, width: 100, height: 601 }; // bottom = 701 > 700
  assert.equal(isRectFullyVisible(rect, viewport, 0), false);
});

test("visibility: visible but fails the margin", () => {
  const rect = { x: 100, y: 100, width: 100, height: 50 }; // touches the left/top edge
  assert.equal(isRectFullyVisible(rect, viewport, 0), true);
  assert.equal(isRectFullyVisible(rect, viewport, 24), false);
});

test("visibility: margin=0 accepts edge-touching rects", () => {
  const rect = { x: 100, y: 100, width: 800, height: 600 }; // exactly the viewport
  assert.equal(isRectFullyVisible(rect, viewport, 0), true);
});

test("visibility: margin larger than the viewport -> not fully visible (empty effective viewport)", () => {
  const rect = { x: 100, y: 100, width: 10, height: 10 };
  assert.equal(isRectFullyVisible(rect, viewport, 400), false);
});

test("visibility: evaluateVisibility reports visible vs fullyVisible vs offscreen separately", () => {
  const inside = evaluateVisibility({ offscreen: false, boundingRect: { x: 200, y: 200, width: 100, height: 50 } }, viewport, 0, "scrollContainer");
  assert.equal(inside.visible, true);
  assert.equal(inside.fullyVisible, true);
  assert.equal(inside.offscreen, false);
  assert.equal(inside.viewportSource, "scrollContainer");

  const clipped = evaluateVisibility({ offscreen: false, boundingRect: { x: 200, y: 100, width: 100, height: 601 } }, viewport, 0, "scrollContainer");
  assert.equal(clipped.visible, true);
  assert.equal(clipped.fullyVisible, false);
  assert.equal(clipped.offscreen, false);

  const offscreen = evaluateVisibility({ offscreen: true, boundingRect: { x: 200, y: 200, width: 100, height: 50 } }, viewport, 0, "scrollContainer");
  assert.equal(offscreen.visible, false);
  assert.equal(offscreen.fullyVisible, true, "geometrically inside but provider says offscreen");
  assert.equal(offscreen.offscreen, true);
});

test("visibility: missing rects are never fully visible", () => {
  assert.equal(isRectFullyVisible(null, viewport, 0), false);
  assert.equal(isRectFullyVisible(undefined, viewport, 0), false);
  assert.equal(isRectFullyVisible({ x: 1, y: 1, width: 10 }, viewport, 0), false);
  assert.equal(isRectFullyVisible({ x: 1, y: 1, width: 10, height: 10 }, null, 0), false);
});

test("visibility: coordinate space is explicit (screen) - same-space comparison only", () => {
  // Both rects carry screen-space semantics; the function never mixes
  // client and screen because callers convert before comparing. A rect
  // without full dimensions is rejected (toRect).
  assert.deepEqual(toRect({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
  assert.equal(toRect({ x: 1, y: 2, width: 3 }), undefined);
  assert.equal(toRect(null), undefined);
});

test("visibility: negative margin is clamped to 0 (schema rejects it, executor is safe)", () => {
  const rect = { x: 100, y: 100, width: 100, height: 50 };
  assert.equal(isRectFullyVisible(rect, viewport, -10), isRectFullyVisible(rect, viewport, 0));
});
