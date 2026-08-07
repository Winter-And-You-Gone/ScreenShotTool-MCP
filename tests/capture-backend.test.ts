// Capture backend identity + recovery-semantics tests.
//
// The ACTUAL capture backend (print / screen) is reported by the PowerShell
// helper branch that executed - never guessed from rect presence or the
// requested captureMethod. Backend identity maps to the interaction method
// through ONE helper (print -> PrintWindow, screen -> CopyFromScreen), and
// every consumer (success metadata, geometry-mismatch details, operation
// ring) uses the ACTUAL backend.
//
// Recovery semantics: background mode intentionally forces PrintWindow, so a
// PrintWindow failure suggestion must explicitly request BOTH
// captureMethod="screen" AND interactionMode="foregroundDemo"; a screen
// backend failure must never repeat the same screen fallback.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureBackendToInteractionMethod, validateCaptureGeometry } from "../src/windows.js";
import { McpUiError } from "../src/uia/results.js";
import { dispatchToolValue } from "../src/index.js";
import { registry } from "../src/app-packs/registry.js";
import { bindLaunchTarget, lastTargetOperation, resetTargetBindings } from "../src/targets.js";

test("backend mapping: print -> PrintWindow, screen -> CopyFromScreen, unknown -> undefined", () => {
  assert.equal(captureBackendToInteractionMethod("print"), "PrintWindow");
  assert.equal(captureBackendToInteractionMethod("screen"), "CopyFromScreen");
  assert.equal(captureBackendToInteractionMethod(undefined), undefined);
});

// ── Integration scenarios ──

// Capture dispatch mock: captures the actual args passed to the helper and
// returns a result with the given ACTUAL backend (simulating the helper's
// own reporting). Geometry validation mirrors the REAL captureWindow.
function makeCaptureRuntime(overrides: {
  helperBackend?: "print" | "screen";
  captured?: { width: number; height: number };
  targetWindowState?: { rect?: { width: number; height: number } };
}) {
  const helperBackend = overrides.helperBackend ?? "print";
  const captured = overrides.captured ?? { width: 1200, height: 800 };
  const calls: Array<Record<string, unknown>> = [];
  let probe = 0;
  const windows = {
    checkProcessAlive: async (input: { pid?: number; hwnd?: string | number }) => {
      probe++;
      const withHwnd = input.hwnd !== undefined;
      const isAfter = probe >= 3;
      return { pid: 1000, processAlive: true, windowAlive: isAfter ? (withHwnd ? true : false) : (withHwnd ? true : false) };
    },
    listWindows: async () => [],
    getWindowState: async () => ({
      hwnd: "100", title: "Fixture App", pid: 1000, processName: "FixtureApp", className: "Qt", visible: true,
      minimized: false, maximized: false, foreground: false, enabled: true, topmost: false, cloaked: false,
      timestamp: "t",
      ...(overrides.targetWindowState ? { rect: overrides.targetWindowState.rect } : { rect: { x: 0, y: 0, width: 1200, height: 800 } })
    }),
    captureWindow: async (input: Record<string, unknown>, resolvedMode?: string) => {
      // Mirror the REAL windows.captureWindow interaction policy: background
      // mode forces the non-activating print backend BEFORE the helper runs.
      const mode = resolvedMode ?? "auto";
      const effectiveRequested: Record<string, unknown> = { ...input };
      if (mode === "background") {
        effectiveRequested.captureMethod = "print";
        effectiveRequested.focus = false;
        effectiveRequested.noActivate = true;
      }
      calls.push({ ...effectiveRequested });
      const result = {
        path: "C:\\outputs\\x.png",
        width: captured.width,
        height: captured.height,
        target: "Fixture",
        rect: { x: 0, y: 0, width: captured.width, height: captured.height },
        timestamp: "t",
        captureBackend: helperBackend,
        interaction: {
          requestedMode: "auto",
          effectiveMode: "background",
          foregroundChanged: false,
          targetActivated: false,
          physicalCursorMoved: false,
          method: captureBackendToInteractionMethod(helperBackend)
        }
      };
      // Mirror the REAL captureWindow: full-window captures are geometry-
      // validated; implausible results throw CAPTURE_GEOMETRY_MISMATCH with
      // the ACTUAL backend and a backend-appropriate suggestion.
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
        ...(region ? { requestedRegion: { width: region.width ?? 0, height: region.height ?? 0 } } : {})
      });
      if (!v.valid) {
        const details: Record<string, unknown> = {
          captureBackend: helperBackend,
          ...(captureBackendToInteractionMethod(helperBackend) ? { interactionMethod: captureBackendToInteractionMethod(helperBackend) } : {}),
          ...(v.expected ? { expectedGeometry: v.expected } : {}),
          ...(v.actual ? { capturedGeometry: v.actual } : {}),
          ...(v.widthRatio !== undefined ? { widthRatio: v.widthRatio } : {}),
          ...(v.heightRatio !== undefined ? { heightRatio: v.heightRatio } : {}),
          ...(v.areaRatio !== undefined ? { areaRatio: v.areaRatio } : {})
        };
        const suggestion = helperBackend === "print"
          ? 'Retry capture_window against the same targetRef with captureMethod="screen" and interactionMode="foregroundDemo" if visible-screen capture is acceptable. Background mode intentionally forces non-activating PrintWindow capture, so changing captureMethod alone is not sufficient while the effective interactionMode remains background.'
          : "The screen capture backend failed for the resolved target. Inspect the returned target/window diagnostics before retrying.";
        throw new McpUiError(
          "CAPTURE_GEOMETRY_MISMATCH",
          "The captured image geometry does not plausibly match the resolved target window.",
          details,
          suggestion
        );
      }
      return result;
    }
  };
  return {
    version: "test",
    schemas: {} as never,
    windows: windows as never,
    profiles: {} as never,
    calls
  };
}

function launchFixture(pid = 1000, hwnd = "100") {
  return bindLaunchTarget({
    profileId: "fixture-app",
    executableNames: ["FixtureApp.exe"],
    processNames: ["FixtureApp"],
    pid,
    hwnd,
    title: "Fixture App",
    startedByMcp: true
  });
}

// A. background overrides requested screen -> actual print / PrintWindow.
test("backend A: interactionMode=background + captureMethod=screen -> helper receives print, interaction is PrintWindow", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeCaptureRuntime({ helperBackend: "print" });
  const result = await dispatchToolValue(
    "capture_window",
    { targetRef: binding.targetRef, hwnd: 100, captureMethod: "screen", interactionMode: "background" },
    runtime as never,
    {} as never
  );
  assert.ok(result !== undefined);
  // The helper must have been called with the forced print method.
  const helperArg = (runtime as unknown as { calls: Array<Record<string, unknown>> }).calls[0]!;
  assert.equal(helperArg.captureMethod, "print", "background must force print on the helper call");
  // The reported interaction method reflects the ACTUAL backend.
  const inter = (result as { interaction?: { method?: string } }).interaction;
  assert.equal(inter?.method, "PrintWindow", "actual backend print -> PrintWindow (never CopyFromScreen)");
  // Operation ring records the actual backend method.
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.interactionMethod, "PrintWindow");
});

// B. foregroundDemo + screen -> actual screen / CopyFromScreen.
test("backend B: interactionMode=foregroundDemo + captureMethod=screen -> actual screen, interaction is CopyFromScreen", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeCaptureRuntime({ helperBackend: "screen" });
  const result = await dispatchToolValue(
    "capture_window",
    { targetRef: binding.targetRef, hwnd: 100, captureMethod: "screen", interactionMode: "foregroundDemo" },
    runtime as never,
    {} as never
  );
  assert.ok(result !== undefined);
  const helperArg = (runtime as unknown as { calls: Array<Record<string, unknown>> }).calls[0]!;
  assert.equal(helperArg.captureMethod, "screen");
  const inter = (result as { interaction?: { method?: string } }).interaction;
  assert.equal(inter?.method, "CopyFromScreen", "actual backend screen -> CopyFromScreen");
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.interactionMethod, "CopyFromScreen");
});

// C. print geometry mismatch -> suggestion contains screen + foregroundDemo + same targetRef.
test("backend C: print geometry mismatch suggestion requires screen AND foregroundDemo", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeCaptureRuntime({
    helperBackend: "print",
    captured: { width: 1200, height: 40 },
    targetWindowState: { rect: { width: 1200, height: 800 } }
  });
  let caught: unknown;
  try {
    await dispatchToolValue("capture_window", { targetRef: binding.targetRef, hwnd: 100, interactionMode: "background" }, runtime as never, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError);
  const err = caught as McpUiError;
  assert.equal(err.code, "CAPTURE_GEOMETRY_MISMATCH");
  const details = err.details as Record<string, unknown>;
  assert.equal(details.captureBackend, "print");
  assert.equal(details.interactionMethod, "PrintWindow");
  // The suggestion must demand BOTH captureMethod and interactionMode.
  assert.match(err.suggestion ?? "", /same targetRef/);
  assert.match(err.suggestion ?? "", /captureMethod="screen"/);
  assert.match(err.suggestion ?? "", /interactionMode="foregroundDemo"/);
  // Operation ring records the ACTUAL backend even on failure.
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.result, "business-error");
  assert.equal(rec.errorCode, "CAPTURE_GEOMETRY_MISMATCH");
  assert.equal(rec.interactionMethod, "PrintWindow");
});

// D. screen geometry mismatch -> suggestion does NOT repeat screen fallback.
test("backend D: screen geometry mismatch suggestion is neutral (no screen loop)", async () => {
  resetTargetBindings();
  const binding = launchFixture();
  const runtime = makeCaptureRuntime({
    helperBackend: "screen",
    captured: { width: 1200, height: 40 },
    targetWindowState: { rect: { width: 1200, height: 800 } }
  });
  let caught: unknown;
  try {
    await dispatchToolValue("capture_window", { targetRef: binding.targetRef, hwnd: 100, captureMethod: "screen", interactionMode: "foregroundDemo" }, runtime as never, {} as never);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof McpUiError);
  const err = caught as McpUiError;
  assert.equal(err.code, "CAPTURE_GEOMETRY_MISMATCH");
  const details = err.details as Record<string, unknown>;
  assert.equal(details.captureBackend, "screen");
  assert.equal(details.interactionMethod, "CopyFromScreen");
  assert.ok(!/captureMethod="screen"/.test(err.suggestion ?? ""), "screen failure must not suggest the same screen fallback");
  assert.ok(!/foregroundDemo/.test(err.suggestion ?? ""), "screen failure must not suggest foregroundDemo screen retry");
  assert.match(err.suggestion ?? "", /Inspect the returned target\/window diagnostics/i);
  const rec = lastTargetOperation(binding.targetRef);
  assert.ok(rec);
  assert.equal(rec.interactionMethod, "CopyFromScreen");
});

// E. Profile default background + requested screen (no explicit mode) -> still print.
test("backend E: profile default background + captureMethod=screen (no explicit mode) -> actual print", async () => {
  // Register a fixture-app pack whose profile default is background, so the
  // dispatch resolves mode=background from the binding profile even though
  // the call carries no explicit interactionMode.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-backend-fixture-"));
  try {
    const packDir = path.join(dir, "fixture-app");
    fs.mkdirSync(packDir);
    const exDir = path.resolve("app-packs/examples/notepad");
    fs.cpSync(exDir, packDir, { recursive: true });
    const profPath = path.join(packDir, "profile.json");
    const prof = JSON.parse(fs.readFileSync(profPath, "utf8")) as Record<string, unknown>;
    prof.id = "fixture-app";
    prof.interaction = { defaultMode: "background", allowForegroundFallback: false, backgroundPresentation: "behind" };
    fs.writeFileSync(profPath, JSON.stringify(prof));
    const manPath = path.join(packDir, "manifest.json");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8")) as Record<string, unknown>;
    man.id = "fixture-app";
    fs.writeFileSync(manPath, JSON.stringify(man));
    const r = await registry.load(dir, [], false);
    assert.equal(r.reloaded, true, `fixture pack must load: ${JSON.stringify(r.issues)}`);
    try {
      resetTargetBindings();
      const binding = launchFixture();
      const runtime = makeCaptureRuntime({ helperBackend: "print" });
      const result = await dispatchToolValue(
        "capture_window",
        { targetRef: binding.targetRef, hwnd: 100, captureMethod: "screen" },
        runtime as never,
        {} as never
      );
      assert.ok(result !== undefined);
      const helperArg = (runtime as unknown as { calls: Array<Record<string, unknown>> }).calls[0]!;
      assert.equal(helperArg.captureMethod, "print", "captureMethod=screen alone must not bypass a background profile default");
      const rec = lastTargetOperation(binding.targetRef);
      assert.ok(rec);
      assert.equal(rec.interactionMethod, "PrintWindow");
    } finally {
      await registry.load(undefined, undefined, true).catch(() => undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
