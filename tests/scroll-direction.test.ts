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

// ── RangeValue multi-step loop regression tests ──
//
// The RangeValue strategy must compute each step from the LATEST refreshed
// range snapshot. A fixed initial snapshot repeats the first target forever
// (0 -> 20 -> set 20 again -> "no change" -> stop), so a target of 60 can
// never be reached. These tests drive the REAL ensureVisible composite
// through a mock UiaDeps and assert the actual setRangeValue call sequence.

import { performProfileAction, type UiaDeps } from "../src/profiles/registry.js";
import { registry } from "../src/app-packs/registry.js";
import type { UiElementSelector } from "../src/uia/types.js";
import type { UiElementState } from "../src/uia/types.js";

function mockRangeElement(value: number, minimum = 0, maximum = 100, largeChange = 20): UiElementState {
  return {
    automationId: "scrollBar", name: "", controlType: "ScrollBar", className: "", frameworkId: "",
    processId: 0, nativeWindowHandle: "1234", enabled: true, offscreen: false, focusable: false,
    hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null,
    boundingRect: { x: 100, y: 100, width: 800, height: 600, coordinateSpace: "screen" },
    runtimeId: [], patterns: ["RangeValue"],
    value: null, rangeValue: value, minimum, maximum, smallChange: null, largeChange,
    toggleState: null, selected: null, expandCollapseState: null
  };
}

// Build a mock UiaDeps whose scroll container's rangeValue reflects the
// setRangeValue calls (each call stores the new value; subsequent reads
// return it). The target element starts below the viewport and becomes
// fullyVisible only once rangeValue >= threshold.
function mockScrollDeps(threshold: number): { deps: UiaDeps; setCalls: number[]; reads: number[] } {
  let scrollValue = 0;
  const setCalls: number[] = [];
  const reads: number[] = [];
  const deps: UiaDeps = {
    getWindowClientRectScreen: async () => ({ x: 100, y: 100, width: 800, height: 600, coordinateSpace: "screen", source: "GetClientRect+ClientToScreen" }),
    getUiElement: async (input) => {
      const sel = input.selector as UiElementSelector;
      const isContainer = (sel.automationId ?? "").includes("scroll");
      if (isContainer) {
        reads.push(scrollValue);
        return { found: true, element: mockRangeElement(scrollValue), elapsedMs: 1 };
      }
      // Target element: moves up as the scroll value increases; while
      // scrollValue < threshold its bottom stays below the viewport bottom
      // (700), so the geometric check keeps reporting not-fully-visible.
      const y = 1100 - scrollValue * 10; // scrollValue=60 -> y=500, bottom=550 < 700
      const fullyVisible = scrollValue >= threshold;
      return {
        found: true,
        element: {
          automationId: "target", name: "", controlType: "Pane", className: "", frameworkId: "",
          processId: 0, nativeWindowHandle: "5678", enabled: true, offscreen: false, focusable: false,
          hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null,
          boundingRect: fullyVisible
            ? { x: 200, y: 300, width: 100, height: 50, coordinateSpace: "screen" }
            : { x: 200, y, width: 100, height: 50, coordinateSpace: "screen" },
          runtimeId: [], patterns: [], value: null, rangeValue: null, minimum: null, maximum: null,
          smallChange: null, largeChange: null, toggleState: null, selected: null, expandCollapseState: null
        },
        elapsedMs: 1
      };
    },
    performUiAction: async (input) => {
      if (input.action === "setRangeValue" && typeof input.rangeValue === "number") {
        setCalls.push(input.rangeValue);
        scrollValue = input.rangeValue;
      }
      return { success: true, method: "RangeValuePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
    },
    queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
    inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 0, maxNodes: 0, elapsedMs: 1 }),
    sendKey: async () => ({ sent: true }),
    getForegroundWindow: async () => "",
    activateWindow: async () => ({ activated: false, foregroundHwnd: "" }),
    restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "", foregroundChanged: false })
  };
  return { deps, setCalls, reads };
}

async function seedScrollProfile(): Promise<string> {
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/scroll-loop-");
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir + "/scroll-fixture", { recursive: true });
  const manifest = { schemaVersion: 1, id: "scroll-fixture", displayName: "Scroll Fixture", version: "1.0.0" };
  const profile = { id: "scroll-fixture", displayName: "Scroll Fixture", executableNames: ["Fixture.exe"] };
  const controls = {
    controls: {
      mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
      target: {
        selectors: [{ automationId: "target" }],
        page: "page-a",
        visibility: { scrollContainer: "scrollContainer", strategies: ["RangeValueScroll"], margin: 0 }
      },
      scrollContainer: { selectors: [{ automationId: "scrollBar" }], page: "page-a", role: "scrollArea" }
    }
  };
  const pages = { pages: [{ id: "page-a", displayName: "Page", rootControl: "mainWindow", components: [] }] };
  await writeFile(dir + "/scroll-fixture/manifest.json", JSON.stringify(manifest));
  await writeFile(dir + "/scroll-fixture/profile.json", JSON.stringify(profile));
  await writeFile(dir + "/scroll-fixture/controls.json", JSON.stringify(controls));
  await writeFile(dir + "/scroll-fixture/pages.json", JSON.stringify(pages));
  const r = await registry.load(dir, [], false);
  assert.equal(r.reloaded, true, JSON.stringify(r.issues));
  return "scroll-fixture";
}

test("RangeValue loop: forward multi-step reaches the threshold (20 -> 40 -> 60)", async () => {
  const profileId = await seedScrollProfile();
  const { deps, setCalls } = mockScrollDeps(60);
  const result = await performProfileAction(deps, {
    profile: profileId, control: "target", action: "ensureVisible", timeoutMs: 10000
  } as Parameters<typeof performProfileAction>[1]);
  const res = result.result as {
    success: boolean; fullyVisible: boolean; method: string;
    initialScrollValue: number; finalScrollValue: number; attemptCount: number; scrollDirection: string;
  };
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.fullyVisible, true);
  assert.equal(res.method, "RangeValueScroll");
  assert.deepEqual(setCalls, [20, 40, 60], "setRangeValue sequence must advance: " + JSON.stringify(setCalls));
  assert.equal(res.initialScrollValue, 0);
  assert.equal(res.finalScrollValue, 60);
  assert.equal(res.attemptCount, 3);
  assert.equal(res.scrollDirection, "forward");
});

test("RangeValue loop: backward multi-step decreases (80 -> 60 -> 40)", async () => {
  const profileId = await seedScrollProfile();
  // Backward variant: start at 80, fullyVisible when value <= 40.
  let scrollValue = 80;
  const setCalls: number[] = [];
  const targetY = 50; // above the viewport top (100) so the direction is backward
  const depsBack: UiaDeps = {
    getWindowClientRectScreen: async () => ({ x: 100, y: 100, width: 800, height: 600, coordinateSpace: "screen", source: "GetClientRect+ClientToScreen" }),
    getUiElement: async (input) => {
      const sel = input.selector as UiElementSelector;
      if ((sel.automationId ?? "").includes("scroll")) {
        return { found: true, element: mockRangeElement(scrollValue), elapsedMs: 1 };
      }
      const fullyVisible = scrollValue <= 40;
      return {
        found: true,
        element: {
          automationId: "target", name: "", controlType: "Pane", className: "", frameworkId: "",
          processId: 0, nativeWindowHandle: "5678", enabled: true, offscreen: false, focusable: false,
          hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null,
          boundingRect: fullyVisible
            ? { x: 200, y: 300, width: 100, height: 50, coordinateSpace: "screen" }
            : { x: 200, y: targetY - (80 - scrollValue), width: 100, height: 50, coordinateSpace: "screen" },
          runtimeId: [], patterns: [], value: null, rangeValue: null, minimum: null, maximum: null,
          smallChange: null, largeChange: null, toggleState: null, selected: null, expandCollapseState: null
        },
        elapsedMs: 1
      };
    },
    performUiAction: async (input) => {
      if (input.action === "setRangeValue" && typeof input.rangeValue === "number") {
        setCalls.push(input.rangeValue);
        scrollValue = input.rangeValue;
      }
      return { success: true, method: "RangeValuePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
    },
    queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
    inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 0, maxNodes: 0, elapsedMs: 1 }),
    sendKey: async () => ({ sent: true }),
    getForegroundWindow: async () => "",
    activateWindow: async () => ({ activated: false, foregroundHwnd: "" }),
    restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "", foregroundChanged: false })
  };
  const result = await performProfileAction(depsBack, {
    profile: profileId, control: "target", action: "ensureVisible", timeoutMs: 10000
  } as Parameters<typeof performProfileAction>[1]);
  const res = result.result as {
    success: boolean; fullyVisible: boolean; initialScrollValue: number; finalScrollValue: number;
    attemptCount: number; scrollDirection: string;
  };
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.fullyVisible, true);
  assert.deepEqual(setCalls, [60, 40], "setRangeValue sequence must decrease: " + JSON.stringify(setCalls));
  assert.equal(res.initialScrollValue, 80);
  assert.equal(res.finalScrollValue, 40);
  assert.equal(res.scrollDirection, "backward");
});

// Regression guard: the old bug (fixed initial snapshot) produced [20, 20]
// and stopped; the fixed loop must never repeat the first target.
test("RangeValue loop: never repeats the first target (regression guard)", async () => {
  const profileId = await seedScrollProfile();
  const { deps, setCalls } = mockScrollDeps(60);
  await performProfileAction(deps, {
    profile: profileId, control: "target", action: "ensureVisible", timeoutMs: 10000
  } as Parameters<typeof performProfileAction>[1]);
  assert.ok(setCalls.length >= 3, "must make at least 3 attempts, got " + JSON.stringify(setCalls));
  assert.ok(!(setCalls.length >= 2 && setCalls[0] === setCalls[1]), "must not repeat the first target: " + JSON.stringify(setCalls));
});
