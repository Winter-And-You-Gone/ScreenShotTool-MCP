// Capture geometry validation tests.
//
// A full-window capture_window must not report success when the captured
// bitmap geometry is implausible relative to the target window's real
// geometry (e.g. a 2560x1600 window captured as 2560x71). The validation is
// tolerant of legitimate frame/client-area/DPI differences, exempts
// region/crop captures, and never fabricates a mismatch when the target
// geometry is unknown.
import assert from "node:assert/strict";
import test from "node:test";

import { validateCaptureGeometry } from "../src/windows.js";
import { McpUiError } from "../src/uia/results.js";
import { dispatchToolValue } from "../src/index.js";
import { bindLaunchTarget, lastTargetOperation, resetTargetBindings } from "../src/targets.js";

// ── Pure helper: validateCaptureGeometry ──

test("geometry: exact match is valid (1200x800 target, 1200x800 capture)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 1200, capturedHeight: 800, captureMethod: "print" });
  assert.equal(v.valid, true);
});

test("geometry: reasonable frame/client difference is valid (1200x800 -> 1190x790)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 1190, capturedHeight: 790, captureMethod: "print" });
  assert.equal(v.valid, true);
});

test("geometry: moderate frame difference is valid (1200x800 -> 1150x770)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 1150, capturedHeight: 770, captureMethod: "print" });
  assert.equal(v.valid, true);
});

test("geometry: height collapse is INVALID (1200x800 -> 1200x40)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 1200, capturedHeight: 40, captureMethod: "print" });
  assert.equal(v.valid, false, "height collapse must be rejected");
  assert.equal(v.heightRatio, 0.05);
});

test("geometry: width collapse is INVALID (1200x800 -> 50x800)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 50, capturedHeight: 800, captureMethod: "print" });
  assert.equal(v.valid, false, "width collapse must be rejected");
});

test("geometry: area collapse is INVALID (1200x800 -> 300x100 = 3% of area)", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 300, capturedHeight: 100, captureMethod: "print" });
  assert.equal(v.valid, false, "area collapse must be rejected");
  assert.equal(v.areaRatio, 0.03125);
});

test("geometry: the real-world case 2560x1600 -> 2560x71 is INVALID", () => {
  const v = validateCaptureGeometry({ targetRect: { width: 2560, height: 1600 }, capturedWidth: 2560, capturedHeight: 71, captureMethod: "print" });
  assert.equal(v.valid, false, "2560x71 must be rejected as implausible for a 2560x1600 window");
  assert.equal(v.widthRatio, 1.0);
  assert.equal(v.heightRatio, 0.044375);
});

test("geometry: region/crop capture is exempt from full-window comparison", () => {
  const v = validateCaptureGeometry({
    targetRect: { width: 1200, height: 800 },
    capturedWidth: 300,
    capturedHeight: 100,
    captureMethod: "print",
    requestedRegion: { width: 300, height: 100 }
  });
  assert.equal(v.valid, true, "a requested crop must not be compared against the full window size");
});

test("geometry: unknown target geometry never fabricates a mismatch", () => {
  const v = validateCaptureGeometry({ targetRect: undefined, capturedWidth: 1200, capturedHeight: 40, captureMethod: "print" });
  assert.equal(v.valid, true, "no target rect => no basis to judge => no false mismatch");
});

test("geometry: a captured dimension larger than the target is bounded (2x max)", () => {
  const ok = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 1300, capturedHeight: 900, captureMethod: "print" });
  assert.equal(ok.valid, true, "a modest size increase is tolerated");
  const bad = validateCaptureGeometry({ targetRect: { width: 1200, height: 800 }, capturedWidth: 3000, capturedHeight: 2000, captureMethod: "print" });
  assert.equal(bad.valid, false, "a 2.5x blowup is implausible");
});

// ── Integration: capture_window rejects implausible geometry ──

function makeCaptureRuntime(overrides: {
  targetWindowState?: { rect?: { width: number; height: number } };
  captured?: { width: number; height: number };
}) {
  let calls = 0;
  const windows = {
    checkProcessAlive: async (input: { pid?: number; hwnd?: string | number }) => {
      calls++;
      const withHwnd = input.hwnd !== undefined;
      const isAfter = calls >= 3;
      return { pid: 1000, processAlive: true, windowAlive: isAfter ? (withHwnd ? true : false) : (withHwnd ? true : false) };
    },
    listWindows: async () => [],
    getWindowState: async () => ({
      hwnd: "100", title: "Fixture App", pid: 1000, processName: "FixtureApp", className: "Qt", visible: true,
      minimized: false, maximized: false, foreground: false, enabled: true, topmost: false, cloaked: false,
      timestamp: "t",
      ...(overrides.targetWindowState ? { rect: overrides.targetWindowState.rect } : { rect: { x: 0, y: 0, width: 1200, height: 800 } })
    }),
    captureWindow: async (input: Record<string, unknown>) => {
      const captured = overrides.captured ?? { width: 1200, height: 800 };
      const result = {
        path: "C:\\outputs\\x.png",
        width: captured.width,
        height: captured.height,
        target: "Fixture",
        rect: { x: 0, y: 0, width: captured.width, height: captured.height },
        timestamp: "t",
        interaction: { requestedMode: "background", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false, method: "PrintWindow" }
      };
      // Mirror the REAL captureWindow behavior: full-window captures are
      // geometry-validated against the target's true rect; implausible
      // results throw CAPTURE_GEOMETRY_MISMATCH.
      const targetState = overrides.targetWindowState?.rect;
      const hwnd = input.hwnd !== undefined ? String(input.hwnd) : undefined;
      let targetRect: { width: number; height: number } | undefined;
      if (hwnd !== undefined && targetState && targetState.width > 0 && targetState.height > 0) {
        targetRect = { width: targetState.width, height: targetState.height };
      }
      const region = input.region as { width?: number; height?: number } | undefined;
      const v = validateCaptureGeometry({
        targetRect,
        capturedWidth: captured.width,
        capturedHeight: captured.height,
        captureMethod: "print",
        ...(region ? { requestedRegion: { width: region.width ?? 0, height: region.height ?? 0 } } : {})
      });
      if (!v.valid) {
        const details: Record<string, unknown> = {
          captureMethod: "PrintWindow",
          ...(v.expected ? { expectedGeometry: v.expected } : {}),
          ...(v.actual ? { capturedGeometry: v.actual } : {}),
          ...(v.widthRatio !== undefined ? { widthRatio: v.widthRatio } : {}),
          ...(v.heightRatio !== undefined ? { heightRatio: v.heightRatio } : {}),
          ...(v.areaRatio !== undefined ? { areaRatio: v.areaRatio } : {})
        };
        throw new McpUiError(
          "CAPTURE_GEOMETRY_MISMATCH",
          "The captured image geometry does not plausibly match the resolved target window.",
          details,
          'Retry capture_window against the same targetRef with captureMethod="screen" if the user needs a visible screenshot and screen capture semantics are acceptable.'
        );
      }
      return result;
    }
  };
  return {
    version: "test",
    schemas: {} as never,
    windows: windows as never,
    profiles: {} as never
  };
}

test("integration: capture_window with implausible geometry throws CAPTURE_GEOMETRY_MISMATCH (business-error in ring)", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({ profileId: "fixture-app", executableNames: ["FixtureApp.exe"], processNames: ["FixtureApp"], pid: 1000, hwnd: "100", title: "Fixture App" });
  const runtime = makeCaptureRuntime({
    targetWindowState: { rect: { width: 2560, height: 1600 } },
    captured: { width: 2560, height: 71 }
  });
  let caught: unknown;
  try {
    await dispatchToolValue("capture_window", { targetRef: binding.targetRef, hwnd: 100 }, runtime, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError, "CAPTURE_GEOMETRY_MISMATCH must be a structured error");
  const err = caught as McpUiError;
  assert.equal(err.code, "CAPTURE_GEOMETRY_MISMATCH");
  // No toolkit root-cause claim in the message.
  assert.match(err.message, /geometry does not plausibly match/i);
  assert.ok(!/Qt|toolkit|compatib/i.test(err.message), "no unproven toolkit attribution");
  const details = err.details as Record<string, unknown>;
  assert.deepEqual(details.expectedGeometry, { width: 2560, height: 1600 });
  assert.deepEqual(details.capturedGeometry, { width: 2560, height: 71 });
  // Suggestion: same targetRef screen retry, never list_windows/relaunch.
  assert.match(err.suggestion ?? "", /same targetRef/);
  assert.match(err.suggestion ?? "", /captureMethod="screen"/);
  assert.ok(!/list_windows/.test(err.suggestion ?? ""), "suggestion must not direct to list_windows");
  // Operation ring: business-error with the real backend method, no path/image.
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.result, "business-error");
  assert.equal(rec.errorCode, "CAPTURE_GEOMETRY_MISMATCH");
  const json = JSON.stringify(rec);
  assert.ok(!json.includes("outputs"), "no output path in the ring");
});

test("integration: capture_window with plausible geometry succeeds and reports validated geometry", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({ profileId: "fixture-app", executableNames: ["FixtureApp.exe"], processNames: ["FixtureApp"], pid: 1000, hwnd: "100", title: "Fixture App" });
  const runtime = makeCaptureRuntime({
    targetWindowState: { rect: { width: 1200, height: 800 } },
    captured: { width: 1190, height: 790 }
  });
  const result = await dispatchToolValue("capture_window", { targetRef: binding.targetRef, hwnd: 100 }, runtime, {} as never);
  assert.ok(result !== undefined);
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.result, "success");
});

test("integration: capture_window with UNKNOWN target geometry does not misreport (region exempt)", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({ profileId: "fixture-app", executableNames: ["FixtureApp.exe"], processNames: ["FixtureApp"], pid: 1000, hwnd: "100", title: "Fixture App" });
  const runtime = makeCaptureRuntime({
    targetWindowState: { rect: undefined },
    captured: { width: 300, height: 100 }
  });
  // Unknown geometry + a requested region: both exemptions apply -> success.
  const result = await dispatchToolValue("capture_window", { targetRef: binding.targetRef, hwnd: 100, region: { x: 0, y: 0, width: 300, height: 100 } }, runtime, {} as never);
  assert.ok(result !== undefined, "unknown geometry + region must not fabricate a mismatch");
});
