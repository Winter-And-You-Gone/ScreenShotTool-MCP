// Unit tests for the interaction policy layer: mode resolution, pack
// defaults (private VaporView pack + unconfigured packs), background
// preflight (PIPELINE_NOT_BACKGROUND_SAFE), the no-silent-foreground-fallback
// rule, explicit foregroundDemo, background capture reports, and output
// schema conformance. Deliberately small: these prove the mode CONSTRAINTS,
// not the UIA functionality itself.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";

import { loadPackFromDir } from "../src/app-packs/loader.js";
import { runPipeline, type ExecutionContext } from "../src/pipeline.js";
import {
  backgroundUnsafeSteps,
  backgroundUnsafePipelineSteps,
  captureInteractionReport,
  effectiveModeFor,
  foregroundRequiredError,
  pipelineNotBackgroundSafeError,
  resolveInteractionMode,
  type InteractionMode,
  type InteractionReport
} from "../src/interaction.js";
import type { PackActions } from "../src/app-packs/types.js";
import type { AppProfile } from "../src/profiles/types.js";
import { contracts } from "../src/contracts.js";
import { validateAgainstSchema } from "../src/outputs.js";

const FOREGROUND_REQUIRED_ACTIONS: PackActions = {
  contracts: [
    { control: "sampleCombo", action: "selectByName", backgroundPolicy: "foregroundRequired", idempotent: false },
    { control: "sampleButton", action: "invoke", backgroundPolicy: "safe", idempotent: true }
  ]
};

const PROFILE: AppProfile = {
  id: "fixture",
  displayName: "Fixture",
  processNames: ["FixtureApp.exe"],
  controls: {
    sampleCombo: { selectors: [{ automationId: "sampleCombo$", match: "regex", controlType: "ComboBox" }], confidence: "source-derived" },
    sampleButton: { selectors: [{ automationId: "sampleButton$", match: "regex", controlType: "Button" }], confidence: "source-derived" }
  }
};

const emptyExpectDeps: ExecutionContext["expectDeps"] = {
  getUiElement: async () => ({ found: false }),
  queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 0 })
};

test("the private VaporView pack declares interaction defaultMode=background", async () => {
  const packDir = path.resolve("local-app-packs", "vaporview");
  if (!existsSync(path.join(packDir, "manifest.json"))) {
    test.skip("local-app-packs/vaporview is not present (private pack not installed); nothing asserted.");
    return;
  }
  const pack = await loadPackFromDir(packDir);
  assert.ok(pack, "VaporView pack must load from the local private directory");
  assert.equal(pack.profile.interaction?.defaultMode, "background");
  assert.equal(pack.profile.interaction?.allowForegroundFallback, false);
  assert.equal(pack.profile.interaction?.backgroundPresentation, "behind");
  // Combo popups are a known VaporView limitation: must NOT be marked safe.
  for (const c of pack.actions.contracts) {
    if (c.control.startsWith("ai8Temperature") && (c.action === "selectByIndex" || c.action === "selectByName")) {
      assert.equal(c.backgroundPolicy, "foregroundRequired", `${c.control} ${c.action} must stay foregroundRequired`);
    }
  }
});

test("an unconfigured pack still resolves to auto", () => {
  assert.equal(resolveInteractionMode({}), "auto");
  assert.equal(resolveInteractionMode({ explicit: undefined, packDefault: undefined }), "auto");
  // Explicit always wins; the pack default only applies when nothing explicit.
  assert.equal(resolveInteractionMode({ explicit: "background", packDefault: "foregroundDemo" }), "background");
  assert.equal(resolveInteractionMode({ packDefault: "background" }), "background");
  assert.equal(resolveInteractionMode({ workflow: "foregroundDemo" }), "foregroundDemo");
  assert.equal(resolveInteractionMode({ explicit: "foregroundDemo", workflow: "background", packDefault: "background" }), "foregroundDemo");
});

test("background + foregroundRequired step -> PIPELINE_NOT_BACKGROUND_SAFE before any step executes", async () => {
  // Unit: the preflight flags the step.
  const unsafe = backgroundUnsafeSteps(
    [
      { id: "selectCombo", tool: "profile_action", args: { profile: "fixture", control: "sampleCombo", action: "selectByName" } },
      { id: "pressButton", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
    ],
    () => FOREGROUND_REQUIRED_ACTIONS,
    FOREGROUND_REQUIRED_ACTIONS
  );
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0]!.stepId, "selectCombo");
  assert.equal(unsafe[0]!.backgroundPolicy, "foregroundRequired");
  assert.equal(unsafe[0]!.suggestedMode, "foregroundDemo");
  const err = pipelineNotBackgroundSafeError("background", unsafe);
  assert.equal(err.code, "PIPELINE_NOT_BACKGROUND_SAFE");
  const details = err.details as { unsafeSteps: Array<{ stepId?: string; backgroundPolicy: string; suggestedMode: string }> };
  assert.deepEqual(details.unsafeSteps, [{ stepId: "selectCombo", backgroundPolicy: "foregroundRequired", suggestedMode: "foregroundDemo" }]);

  // End-to-end: runPipeline refuses BEFORE dispatching anything.
  let dispatched = 0;
  const result = await runPipeline(
    {
      steps: [
        { id: "a", tool: "profile_action", args: { profile: "fixture", control: "sampleCombo", action: "selectByName" } },
        { id: "b", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
      ]
    },
    {
      dispatch: async () => { dispatched++; return { ok: true }; },
      pack: { id: "fixture", actions: FOREGROUND_REQUIRED_ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "PIPELINE_NOT_BACKGROUND_SAFE");
  assert.equal(result.completed, 0);
  assert.equal(result.steps.length, 0);
  assert.equal(dispatched, 0, "no step may execute when the pipeline is not background-safe");
  // The pipeline-level interaction report still states the mode honestly.
  assert.equal((result.interaction as InteractionReport)?.requestedMode, "background");
});

test("background failures never silently fall into foregroundDemo", () => {
  // The resolution layer cannot upgrade: explicit background stays background.
  assert.equal(resolveInteractionMode({ explicit: "background", packDefault: "foregroundDemo" }), "background");
  // The action gate refuses with FOREGROUND_REQUIRED carrying the requested
  // (background) mode and a foregroundDemo suggestion - not an auto-upgrade.
  const gate = foregroundRequiredError("This operation has no verified background-safe method.", { requestedMode: "background", backgroundPolicy: "foregroundRequired" });
  assert.equal(gate.code, "FOREGROUND_REQUIRED");
  const details = gate.details as Record<string, unknown>;
  assert.equal(details.requestedMode, "background");
  assert.equal(details.effectiveMode, "background");
  assert.equal(details.foregroundChanged, false);
  assert.equal(details.suggestedMode, "foregroundDemo");
  assert.equal(details.backgroundPolicy, "foregroundRequired");
});

test("explicit foregroundDemo allows the foreground path", () => {
  assert.equal(resolveInteractionMode({ explicit: "foregroundDemo", packDefault: "background" }), "foregroundDemo");
  assert.equal(effectiveModeFor("foregroundDemo", true), "foregroundDemo");
  assert.equal(effectiveModeFor("foregroundDemo", false), "foregroundDemo");
  // The same action that is refused in background is fine when the caller
  // explicitly requested the demo mode (no gate applies).
  const unsafeInBackground = backgroundUnsafeSteps(
    [{ id: "selectCombo", tool: "profile_action", args: { profile: "fixture", control: "sampleCombo", action: "selectByName" } }],
    () => FOREGROUND_REQUIRED_ACTIONS,
    FOREGROUND_REQUIRED_ACTIONS
  );
  assert.equal(unsafeInBackground.length, 1, "background preflight flags it");
});

test("background capture report: foregroundChanged=false, PrintWindow, no cursor movement", () => {
  const report = captureInteractionReport("background", {
    foregroundBefore: "0x100",
    foregroundAfter: "0x100",
    foregroundChanged: false,
    captureMethod: "PrintWindow",
    targetActivated: false
  });
  assert.equal(report.requestedMode, "background");
  assert.equal(report.effectiveMode, "background");
  assert.equal(report.method, "PrintWindow");
  assert.equal(report.foregroundChanged, false);
  assert.equal(report.targetActivated, false);
  assert.equal(report.physicalCursorMoved, false);
  // A foregroundDemo capture is allowed to activate the target and reports it.
  const demo = captureInteractionReport("foregroundDemo", {
    foregroundChanged: true,
    captureMethod: "screen",
    targetActivated: true
  });
  assert.equal(demo.effectiveMode, "foregroundDemo");
  assert.equal(demo.targetActivated, true);
});

test("interaction results conform to the tool output schemas", () => {
  const interaction: InteractionReport = {
    requestedMode: "background",
    effectiveMode: "background",
    backgroundPolicy: "safe",
    method: "InvokePattern",
    foregroundBefore: "0x100",
    foregroundAfter: "0x100",
    foregroundChanged: false,
    targetActivated: false,
    physicalCursorMoved: false
  };
  // profile_launch result with interaction.
  const launch = {
    profile: "fixture",
    pid: 4242,
    hwnd: "0x200",
    title: "Fixture",
    startedByMcp: true,
    reused: false,
    uiaRootAvailable: true,
    interaction
  };
  const launchCheck = validateAgainstSchema(launch, contracts.profile_launch!.outputSchema);
  assert.ok(launchCheck.ok, `profile_launch result must match its outputSchema: ${launchCheck.ok ? "" : launchCheck.reason}`);
  // run_steps result with the aggregate interaction.
  const run = {
    schemaVersion: 1,
    success: true,
    total: 1,
    completed: 1,
    stoppedAtIndex: null,
    runId: "run_test",
    status: "completed",
    completedSteps: ["a"],
    exports: {},
    steps: [{ tool: "profile_action", success: true, result: { ok: true } }],
    interaction: { requestedMode: "foregroundDemo", effectiveMode: "foregroundDemo", foregroundChanged: true, foregroundRestored: true, targetActivated: true, physicalCursorMoved: false }
  };
  const runCheck = validateAgainstSchema(run, contracts.run_steps!.outputSchema);
  assert.ok(runCheck.ok, `run_steps result must match its outputSchema: ${runCheck.ok ? "" : runCheck.reason}`);
  // An auto-mode report without optional fields still validates (required
  // fields only).
  const minimal = validateAgainstSchema({ ...launch, interaction: { requestedMode: "auto", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false } }, contracts.profile_launch!.outputSchema);
  assert.ok(minimal.ok, "minimal interaction report must validate");
});

test("global keyboard input steps are flagged in background preflight", () => {
  const unsafe = backgroundUnsafeSteps(
    [
      { id: "keys", tool: "send_key", args: { key: "enter" } },
      { id: "posted", tool: "send_key", args: { key: "enter", noActivate: true } }
    ],
    () => undefined,
    undefined
  );
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0]!.stepId, "keys");
  assert.match(unsafe[0]!.reason, /global keyboard input/);
});

test("pipeline interaction aggregates step foreground changes (changed during run, restored at end)", async () => {
  // The step reports foregroundChanged=true (and activated the target), but
  // the final foreground re-read equals the start: the pipeline report must
  // express BOTH facts - final unchanged AND changed-during-run.
  const reads = ["A", "A"];
  let readIndex = 0;
  const result = await runPipeline(
    {
      steps: [
        { id: "a", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
      ]
    },
    {
      dispatch: async () => ({
        profile: "fixture",
        control: "sampleButton",
        result: { success: true },
        interaction: { requestedMode: "background", effectiveMode: "background", foregroundChanged: true, targetActivated: true, physicalCursorMoved: false }
      }),
      pack: { id: "fixture", actions: FOREGROUND_REQUIRED_ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps,
      getForeground: async () => reads[Math.min(readIndex++, reads.length - 1)]!
    }
  );
  assert.equal(result.success, true);
  const report = result.interaction!;
  assert.equal(report.foregroundBefore, "A");
  assert.equal(report.foregroundAfter, "A");
  assert.equal(report.foregroundChanged, false, "final foreground equals the start");
  assert.equal(report.foregroundChangedDuringRun, true, "a step changed the foreground during the run - never hidden by the restore");
  assert.equal(report.foregroundRestored, true, "the final read restored the start window");
  assert.equal(report.targetActivated, true, "step activation is aggregated");
  assert.equal(report.physicalCursorMoved, false);
});

test("pipeline interaction reports an un-restored foreground honestly", async () => {
  // The final re-read differs from the start: background mode reports
  // foregroundChanged=true / foregroundRestored=false + a warning, WITHOUT
  // failing the already-completed business steps.
  const reads = ["A", "B"];
  let readIndex = 0;
  const result = await runPipeline(
    { steps: [{ id: "a", tool: "read_clipboard" }] },
    {
      dispatch: async () => ({ available: true, text: "x", length: 1, timestamp: "t" }),
      pack: { id: "fixture", actions: FOREGROUND_REQUIRED_ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps,
      getForeground: async () => reads[Math.min(readIndex++, reads.length - 1)]!
    }
  );
  assert.equal(result.success, true, "business steps are not failed by a foreground side effect");
  const report = result.interaction!;
  assert.equal(report.foregroundChanged, true);
  assert.equal(report.foregroundRestored, false);
  assert.ok(result.warnings.some((w) => w.startsWith("BACKGROUND_FOREGROUND_NOT_RESTORED")), `expected warning, got: ${JSON.stringify(result.warnings)}`);
});

test("background preflight refuses a foregroundRequired FINALLY step before the main flow executes", async () => {
  let dispatched = 0;
  const result = await runPipeline(
    {
      steps: [
        { id: "main", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
      ],
      finally: [
        { id: "cleanupDialog", tool: "profile_action", args: { profile: "fixture", control: "sampleCombo", action: "selectByName" } }
      ]
    },
    {
      dispatch: async () => { dispatched++; return { ok: true }; },
      pack: { id: "fixture", actions: FOREGROUND_REQUIRED_ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(result.success, false);
  assert.equal(result.error?.code, "PIPELINE_NOT_BACKGROUND_SAFE");
  const details = result.error?.details as { unsafeSteps?: Array<{ stepId?: string; section?: string; backgroundPolicy: string }> };
  assert.equal(details?.unsafeSteps?.length, 1);
  assert.equal(details?.unsafeSteps?.[0]?.stepId, "cleanupDialog");
  assert.equal(details?.unsafeSteps?.[0]?.section, "finally");
  assert.equal(details?.unsafeSteps?.[0]?.backgroundPolicy, "foregroundRequired");
  assert.equal(dispatched, 0, "the main flow must not execute when finally is unsafe");
  assert.equal(result.steps.length, 0);

  // The unified helper marks sections explicitly.
  const flagged = backgroundUnsafePipelineSteps(
    [{ id: "main", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }],
    [{ id: "cleanupDialog", tool: "profile_action", args: { profile: "fixture", control: "sampleCombo", action: "selectByName" } }],
    () => FOREGROUND_REQUIRED_ACTIONS,
    FOREGROUND_REQUIRED_ACTIONS
  );
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]!.section, "finally");
});

test("background pipeline with background-safe finally runs to completion", async () => {
  const result = await runPipeline(
    {
      steps: [
        { id: "main", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
      ],
      finally: [
        { id: "cleanup", tool: "profile_action", args: { profile: "fixture", control: "sampleButton", action: "invoke" } }
      ]
    },
    {
      dispatch: async () => ({ profile: "fixture", control: "sampleButton", result: { success: true } }),
      pack: { id: "fixture", actions: FOREGROUND_REQUIRED_ACTIONS, profile: PROFILE, version: "1" },
      interactionMode: "background",
      expectDeps: emptyExpectDeps
    }
  );
  assert.equal(result.success, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.finallyResults.length, 1);
  assert.equal(result.finallyResults[0]!.success, true);
  assert.equal(result.interaction?.requestedMode, "background");
});
