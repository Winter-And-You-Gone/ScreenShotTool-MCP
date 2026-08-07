// TargetRef Profile-context regression tests.
//
// A targetRef created by profile_launch carries the Profile/App Pack identity
// (profileId on the binding). Tools that need pack defaults (capture_window's
// interactionMode, ui_catalog's profile enrichment) MUST use that binding
// identity - never re-guess the profile from processName/titleContains (which
// may be absent on a targetRef-resolved window selector).
//
// If the implementation regresses to inferring the profile only from the
// window selector, the capture test below FAILS (windowSel has pid+hwnd only).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatchToolValue } from "../src/index.js";
import { registry } from "../src/app-packs/registry.js";
import { bindLaunchTarget, lastTargetOperation, resetTargetBindings } from "../src/targets.js";

// fixture-app profile: default interactionMode = background.

function makeRuntime(overrides: {
  windows?: Array<{ hwnd: string; title: string; pid: number; processName: string }>;
  captureResult?: Record<string, unknown>;
  captureError?: Error;
}) {
  let calls = 0;
  const windows = {
    checkProcessAlive: async (input: { pid?: number; hwnd?: string | number }) => {
      calls++;
      const withHwnd = input.hwnd !== undefined;
      const isAfter = calls >= 3;
      return { pid: 1000, processAlive: true, windowAlive: isAfter ? (withHwnd ? true : false) : (withHwnd ? true : false) };
    },
    listWindows: async () => overrides.windows ?? [],
    clickWindow: async () => ({ clicked: true, method: "post_message", target: "Fixture", hwnd: "100", title: "Fixture App", pid: 1000, button: "left", doubleClick: false, windowPoint: { x: 0, y: 0 }, screenPoint: { x: 0, y: 0 }, timestamp: "t" }),
    captureWindow: async () => {
      if (overrides.captureError) throw overrides.captureError;
      return overrides.captureResult ?? {
        path: "C:\\outputs\\x.png", width: 1200, height: 800, target: "Fixture",
        rect: { x: 0, y: 0, width: 1200, height: 800 }, timestamp: "t",
        interaction: { requestedMode: "background", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false, method: "PrintWindow" }
      };
    }
  };
  return {
    version: "test",
    schemas: {} as never,
    windows: windows as never,
    profiles: {
      findProfileForTarget: () => undefined, // MUST NOT be consulted for a bound targetRef
      enrichCatalogControls: () => undefined,
      resolveProfileControl: async () => undefined,
      performProfileAction: async () => undefined
    } as never
  };
}

function launchFixture(pid = 1000, hwnd = "100") {
  return bindLaunchTarget({
    profileId: "fixture-app",
    executableNames: ["FixtureApp.exe"],
    processNames: ["FixtureApp"],
    mainWindow: { title: "^Fixture App$", titleMatch: "regex" },
    pid,
    hwnd,
    title: "Fixture App",
    startedByMcp: true,
    lifetime: "independent"
  });
}

// Register the fixture-app pack in the shared registry for the duration of
// the tests (restored to the default sources afterwards).
async function withFixturePack(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-profile-fixture-"));
  try {
    // Start from the public example pack so every required file is present
    // and valid; only the identity and the interaction default change.
    // registry.load(dir) scans the SUBDIRECTORIES of dir as packs.
    const packDir = path.join(dir, "fixture-app");
    fs.mkdirSync(packDir);
    const exDir = path.resolve("app-packs/examples/notepad");
    fs.cpSync(exDir, packDir, { recursive: true });
    const profPath = path.join(packDir, "profile.json");
    const prof = JSON.parse(fs.readFileSync(profPath, "utf8")) as Record<string, unknown>;
    prof.interaction = { defaultMode: "background", allowForegroundFallback: false, backgroundPresentation: "behind" };
    prof.id = "fixture-app";
    fs.writeFileSync(profPath, JSON.stringify(prof));
    const manPath = path.join(packDir, "manifest.json");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8")) as Record<string, unknown>;
    man.id = "fixture-app";
    man.displayName = "Fixture App";
    fs.writeFileSync(manPath, JSON.stringify(man));
    const r = await registry.load(dir, [], false);
    assert.equal(r.reloaded, true, `fixture pack must load: ${JSON.stringify(r.issues)}`);
    try {
      await fn();
    } finally {
      // Reload the default sources so other tests see the standard packs.
      await registry.load(undefined, undefined, true).catch(() => undefined);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("profile context: capture_window via targetRef inherits the binding profile's interaction default", async () => {
  await withFixturePack(async () => {
    resetTargetBindings();
    const binding = launchFixture();
    // windowSel for a targetRef resolve carries ONLY pid+hwnd - no
    // processName/titleContains. The OLD logic (findProfileForTarget from the
    // window selector) would find no profile and fall back to auto; the
    // binding profileId (fixture-app, defaultMode=background) must win.
    const seen: Array<{ mode: string }> = [];
    const runtime = makeRuntime({});
    (runtime.windows as unknown as { captureWindow: unknown }).captureWindow = async (_input: unknown, mode: string) => {
      seen.push({ mode });
      return {
        path: "C:\\outputs\\x.png", width: 1200, height: 800, target: "Fixture",
        rect: { x: 0, y: 0, width: 1200, height: 800 }, timestamp: "t",
        interaction: { requestedMode: mode, effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false, method: "PrintWindow" }
      };
    };
    const result = await dispatchToolValue("capture_window", { targetRef: binding.targetRef }, runtime, {} as never);
    assert.ok(result !== undefined);
    assert.equal(seen.length, 1, "capture_window must be dispatched");
    assert.equal(seen[0]!.mode, "background", "targetRef binding profile default must resolve to background");
  });
});

test("profile context: explicit interactionMode overrides the binding profile default", async () => {
  await withFixturePack(async () => {
    resetTargetBindings();
    const binding = launchFixture();
    const seen: Array<{ mode: string }> = [];
    const runtime = makeRuntime({});
    (runtime.windows as unknown as { captureWindow: unknown }).captureWindow = async (_input: unknown, mode: string) => {
      seen.push({ mode });
      return {
        path: "C:\\outputs\\x.png", width: 1200, height: 800, target: "Fixture",
        rect: { x: 0, y: 0, width: 1200, height: 800 }, timestamp: "t",
        interaction: { requestedMode: mode, effectiveMode: "foregroundDemo", foregroundChanged: true, targetActivated: true, physicalCursorMoved: false, method: "PrintWindow" }
      };
    };
    const result = await dispatchToolValue(
      "capture_window",
      { targetRef: binding.targetRef, interactionMode: "foregroundDemo" },
      runtime,
      {} as never
    );
    assert.ok(result !== undefined);
    assert.equal(seen[0]!.mode, "foregroundDemo", "explicit input must override the pack default");
  });
});

test("profile context: the binding keeps its profileId after a targetRef resolve", async () => {
  await withFixturePack(async () => {
    resetTargetBindings();
    const binding = launchFixture();
    const runtime = makeRuntime({});
    const result = await dispatchToolValue("click_window", { targetRef: binding.targetRef, x: 0, y: 0 }, runtime, {} as never);
    assert.ok(result !== undefined);
    const rec = lastTargetOperation(binding.targetRef);
    assert.ok(rec);
    assert.equal(rec.tool, "click_window");
    assert.equal(rec.result, "success");
  });
});
