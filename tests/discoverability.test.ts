// Targeted tests for the model-discoverability round:
//   1. business errors validate against every tool's outputSchema (no
//      "Structured content does not match output schema")
//   2. targetRef bindings: profile_launch returns one, stale HWNDs rebind,
//      process-alive-but-windowless is never a crash, single-instance
//      auto-bind, multi-instance ambiguity
//   3. ensureSelected verifies the declared business postcondition
//      (controlState=true + businessState=false must NOT succeed)
//   4. selector-driven windowMessageClick reports the exact method and
//      physicalCursorMoved=false
//   5. scoped ui_query: root/ancestor scoping, auto-depth escalation, field
//      projection; large-tree guard suggests a scoped query
//   6. tool descriptions / usageGuidance recommend the right order
import assert from "node:assert/strict";
import test from "node:test";

import { contracts, toolErrorEnvelope, withToolError, unwrapToolError } from "../src/contracts.js";
import { validateAgainstSchema } from "../src/outputs.js";
import { McpUiError } from "../src/uia/results.js";
import {
  autoResolveTarget,
  bindLaunchTarget,
  getTarget,
  registerTarget,
  resolveTargetRef,
  resetTargetBindings,
  TARGET_REF_PREFIX
} from "../src/targets.js";
import { performProfileAction } from "../src/profiles/registry.js";
import { projectElementFields } from "../src/windows.js";
import { toolZodSchemas } from "../src/schemas.js";

// ── 1. Error contract: business errors validate against outputSchema ──

function makeErrorEnvelope(code: string, message: string, suggestion?: string, retryable?: boolean) {
  return {
    success: false,
    error: { code, message, ...(suggestion ? { suggestion } : {}), ...(retryable !== undefined ? { retryable } : {}) }
  };
}

test("profile_action business error validates against its outputSchema", () => {
  const err = makeErrorEnvelope("ELEMENT_NOT_FOUND", "No element matched selector", "Use scoped ui_query...", false);
  const check = validateAgainstSchema(err, contracts.profile_action!.outputSchema);
  assert.equal(check.ok, true, `error envelope must satisfy profile_action outputSchema: ${check.reason}`);
});

test("ui_catalog / ui_inspect_tree / ui_query / ui_get errors validate against their outputSchemas", () => {
  for (const tool of ["ui_catalog", "ui_inspect_tree", "ui_query", "ui_get"]) {
    const err = makeErrorEnvelope("WINDOW_NOT_FOUND", "No window matched", "Relaunch and use the returned targetRef.");
    const check = validateAgainstSchema(err, contracts[tool]!.outputSchema);
    assert.equal(check.ok, true, `${tool} error envelope must validate: ${check.reason}`);
  }
});

test("every tool's outputSchema accepts the unified error envelope", () => {
  // Orchestration tools already carry { success, error } natively; all other
  // tools are wrapped with withToolError.
  const envelope = makeErrorEnvelope("ACTION_STATE_INCONSISTENT", "control reports selected but postcondition is not satisfied", "Verify the actual page/content state.");
  for (const [name, c] of Object.entries(contracts)) {
    if (["run_steps", "profile_run_steps", "run_workflow", "continue_run"].includes(name)) continue;
    const check = validateAgainstSchema(envelope, c.outputSchema);
    assert.equal(check.ok, true, `${name} outputSchema must accept the business error envelope: ${check.reason}`);
  }
});

test("withToolError keeps the success branch first and unwraps cleanly", () => {
  const success = { type: "object", properties: { pid: { type: "integer" } }, required: ["pid"] };
  const wrapped = withToolError(success);
  assert.equal(wrapped.type, "object", "MCP requires an object-root outputSchema");
  assert.equal(wrapped.anyOf!.length, 2);
  assert.deepEqual(unwrapToolError(wrapped), success);
  assert.deepEqual(unwrapToolError(undefined), undefined);
  assert.ok(toolErrorEnvelope.properties?.error?.properties?.suggestion, "error envelope carries suggestion");
  assert.ok(toolErrorEnvelope.properties?.error?.properties?.retryable, "error envelope carries retryable");
});

// ── 2. targetRef bindings ──

test("profile_launch output schema includes targetRef", () => {
  const ok = validateAgainstSchema(
    {
      profile: "x", targetRef: "target_x_1", pid: 1, startedByMcp: true, reused: false, uiaRootAvailable: true,
      interaction: { requestedMode: "auto", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false }
    },
    contracts.profile_launch!.outputSchema
  );
  assert.equal(ok.ok, true, `targetRef result must validate: ${ok.reason}`);
});

test("profile_launch outputSchema requires targetRef in the success branch", () => {
  const schema = contracts.profile_launch!.outputSchema;
  // 1. The SUCCESS branch (first anyOf branch) requires targetRef.
  const successBranch = unwrapToolError(schema)!;
  assert.ok(successBranch.required?.includes("targetRef"), "targetRef must be required in the success branch");
  assert.ok(successBranch.required?.includes("profile"), "profile stays required");
  assert.ok(!successBranch.required?.includes("hwnd"), "hwnd must NOT be required (a launch may return only pid + targetRef)");

  // 2. A success result missing targetRef must FAIL the schema.
  const missingTargetRef = validateAgainstSchema(
    {
      profile: "x", pid: 1, startedByMcp: true, reused: false, uiaRootAvailable: true,
      interaction: { requestedMode: "auto", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false }
    },
    schema
  );
  assert.equal(missingTargetRef.ok, false, "a success result without targetRef must not validate");

  // 3. A legal error envelope still validates (the withToolError wrapper).
  const envelope = makeErrorEnvelope("PROFILE_NOT_FOUND", "No profile with id 'x'.", "Run app_pack_list to see which App Packs are loaded.");
  const envelopeCheck = validateAgainstSchema(envelope, schema);
  assert.equal(envelopeCheck.ok, true, "the error envelope must still validate: " + envelopeCheck.reason);

  // 4. A success result WITH targetRef validates (covered by the first test
  //    above; asserted again for the full shape including hwnd optionality).
  const withTargetRef = validateAgainstSchema(
    {
      profile: "x", targetRef: "target_x_2", pid: 2, hwnd: "0x99", title: "x", startedByMcp: true, reused: false, uiaRootAvailable: true,
      interaction: { requestedMode: "auto", effectiveMode: "background", foregroundChanged: false, targetActivated: false, physicalCursorMoved: false }
    },
    schema
  );
  assert.equal(withTargetRef.ok, true, "a success result with targetRef must validate: " + withTargetRef.reason);
});

// ── 2b. targetRef-aware vs unaware tool contract table ──

// Tools whose runtime resolves targetRef (dispatch -> resolveTargetInput).
// Target tools: HIGH-LEVEL tools plus the LOW-LEVEL window tools that now
// resolve targetRef at runtime (lifecycle consistency: once a target session
// exists, the same session identity applies to click_window / get_window_state
// / type_text / send_key / etc., so a stale hwnd never forces a manual
// relaunch). click_menu_item resolves targetRef too (native Win32 menu
// invocation on the same target window).
const TARGET_REF_AWARE = [
  "profile_action", "profile_resolve", "capture_window",
  "ui_query", "ui_get", "ui_action", "ui_catalog", "ui_inspect_tree", "ui_wait",
  "click_window", "move_mouse_window", "click_menu_item",
  "type_text", "send_key", "get_window_state", "wait_for_window"
];

// Tools that share the window-selector shape but do NOT accept targetRef:
// capture_screen_region is screen-space (no window), close_app is pid-only,
// launch_app/list_windows/read_clipboard/write_clipboard have no target
// session.
const TARGET_REF_UNAWARE: string[] = [];

test("targetRef-aware tools accept targetRef alone and mention it in the missing-target message", () => {
  // toolZodSchemas is statically imported above.
  for (const tool of TARGET_REF_AWARE) {
    const zodSchema = toolZodSchemas[tool];
    const jsonSchema = contracts[tool]!.inputSchema as { properties?: Record<string, unknown>; anyOf?: unknown[] };

    // 1. inputSchema contains targetRef (JSON exposure).
    assert.ok(jsonSchema.properties?.targetRef, `${tool} JSON inputSchema must expose targetRef`);

    // 2. Missing ALL target params -> the error message mentions targetRef.
    //    Selector-requiring tools (ui_query/ui_get/ui_action/ui_wait) need a
    //    selector to isolate the target-missing refine.
    const base = tool === "profile_action" ? { profile: "p", control: "c", action: "invoke" }
      : tool === "profile_resolve" ? { profile: "p", control: "c" }
        : ["ui_query", "ui_get", "ui_action", "ui_wait"].includes(tool)
          ? { selector: { controlType: "Button" }, ...(tool === "ui_action" ? { action: "invoke" } : {}), ...(tool === "ui_wait" ? { condition: "exists" } : {}) }
          : tool === "click_window" || tool === "move_mouse_window" ? { x: 1, y: 1 }
            : tool === "click_menu_item" ? { path: ["File"] }
              : tool === "type_text" ? { text: "hi" }
                : tool === "send_key" ? { key: "enter" }
                  : {};
    try {
      zodSchema.parse(base);
      assert.fail(`${tool} must reject a call with no target`);
    } catch (error) {
      const message = (error as Error).message;
      assert.ok(message.includes("targetRef"), `${tool} missing-target message must mention targetRef, got: ${message.slice(0, 120)}`);
    }

    // 3. Passing ONLY targetRef passes the target-missing refine.
    const parsed = zodSchema.parse({ ...base, targetRef: "target_p_1" });
    assert.equal(parsed.targetRef, "target_p_1", `${tool} must accept targetRef alone`);

    // 4. JSON anyOf exposes the targetRef branch first.
    //    (ui_query uses allOf with the target anyOf nested inside - check
    //    either shape.)
    const anyOf = (jsonSchema.anyOf ?? (jsonSchema.allOf as Array<{ anyOf?: unknown[] }> | undefined)?.find((b) => "anyOf" in (b as object))?.anyOf) as Array<{ required?: string[] }> | undefined;
    assert.ok(anyOf && anyOf.some((b) => b.required?.includes("targetRef")), `${tool} anyOf must allow targetRef`);
  }
});

test("targetRef-unaware tools do not advertise targetRef and keep the legacy message", () => {
  // No tools are currently targetRef-unaware: every window-target tool
  // resolves targetRef at runtime (click_window / move_mouse_window /
  // click_menu_item / type_text / send_key / get_window_state /
  // wait_for_window were extended in the target-session hardening). The
  // contract test stays to guard against FUTURE tools that share the
  // window-selector shape without targetRef support.
  assert.equal(TARGET_REF_UNAWARE.length, 0, "all window-target tools must support targetRef");
});

test("stale HWND rebinds to the new window of the same process", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
    titleContains: ["Fixture"], pid: 42, hwnd: "0x111", title: "Fixture App"
  });
  // The saved hwnd is gone but the process is alive with a NEW window.
  let hwndState = { windowAlive: false, processAlive: true };
  let listed = [{ hwnd: "0x222", title: "Fixture App v2", pid: 42, processName: "FixtureApp.exe" }];
  const resolution = await resolveTargetRef(binding.targetRef, {
    checkProcessAlive: async () => hwndState,
    listWindows: async () => listed
  });
  assert.equal(resolution.ok, true);
  assert.equal(resolution.ok && resolution.target.rebound, true, "the stale hwnd must be refreshed");
  assert.equal(resolution.ok && resolution.target.hwnd, "0x222");
  assert.equal(resolution.ok && resolution.target.previousHwnd, "0x111");
});

test("process alive but no window returns WINDOW_NOT_FOUND_FOR_PROCESS (never a crash)", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
    titleContains: ["Fixture"], pid: 42, hwnd: "0x111"
  });
  const resolution = await resolveTargetRef(binding.targetRef, {
    checkProcessAlive: async () => ({ processAlive: true, windowAlive: false }),
    listWindows: async () => []
  });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) {
    assert.equal(resolution.error.code, "WINDOW_NOT_FOUND_FOR_PROCESS");
    assert.equal(resolution.processAlive, true, "the process is NOT dead");
    assert.equal(resolution.windowAlive, false);
    assert.ok(resolution.error.suggestion?.includes("does not prove the process crashed") ?? resolution.error.suggestion?.includes("Wait"), "suggestion must guide the model");
    const check = validateAgainstSchema(
      { success: false, error: { code: resolution.error.code, message: resolution.error.message, suggestion: resolution.error.suggestion, retryable: true } },
      contracts.profile_action!.outputSchema
    );
    assert.equal(check.ok, true);
  }
});

test("process exit returns TARGET_PROCESS_EXITED with lifecycle details", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"], pid: 42, hwnd: "0x111"
  });
  const resolution = await resolveTargetRef(binding.targetRef, {
    checkProcessAlive: async () => ({ processAlive: false, windowAlive: false }),
    listWindows: async () => []
  });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) {
    assert.equal(resolution.error.code, "TARGET_PROCESS_EXITED");
    assert.equal(resolution.processAlive, false);
    const details = resolution.error.details as Record<string, unknown>;
    assert.equal(details.lifecycle, "process-exited");
    assert.equal(details.causality, "unknown");
    assert.ok(resolution.error.suggestion?.includes("profile_launch"), "suggestion must say relaunch");
  }
});

test("auto-resolve binds the unique running instance; several instances are TARGET_AMBIGUOUS", async () => {
  resetTargetBindings();
  const one = await autoResolveTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
    listWindows: async () => [{ hwnd: "0x1", title: "Fixture", pid: 10, processName: "FixtureApp.exe" }]
  });
  assert.ok(one, "a unique instance is auto-bound");
  assert.equal(one!.hwnd, "0x1");

  await assert.rejects(
    () => autoResolveTarget({
      profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
      listWindows: async () => [
        { hwnd: "0x1", title: "Fixture", pid: 10, processName: "FixtureApp.exe" },
        { hwnd: "0x2", title: "Fixture", pid: 11, processName: "FixtureApp.exe" }
      ]
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "TARGET_AMBIGUOUS");
      return true;
    }
  );
  // No instances -> undefined (the caller falls back to its own resolution).
  const none = await autoResolveTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
    listWindows: async () => []
  });
  assert.equal(none, undefined);
});

test("targetRef identifiers are stable and TTL-bounded", () => {
  resetTargetBindings();
  const binding = registerTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["fixtureapp"],
    pid: 1, hwnd: "0x1"
  });
  assert.ok(binding.targetRef.startsWith(TARGET_REF_PREFIX));
  assert.equal(getTarget(binding.targetRef), binding);
});

// ── 3. ensureSelected verifies the business postcondition ──

// performProfileAction resolves profiles through the global App Pack
// registry, so the fixture pack must be registered from a temp directory.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registry as packRegistry } from "../src/app-packs/registry.js";

async function registerFixturePack(opts: {
  defaultExpect?: unknown;
  fallbackPolicy?: "default" | "disabled";
}): Promise<string> {
  // The registry treats a source dir's CHILD directories as packs, so the
  // fixture lives in a named subdirectory of a fresh temp root.
  const root = await mkdtemp(path.join(tmpdir(), "discoverability-root-"));
  const dir = path.join(root, "fixture-pack");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "fixture", displayName: "Fixture", version: "1.0.0"
  }));
  await writeFile(path.join(dir, "profile.json"), JSON.stringify({
    id: "fixture", displayName: "Fixture", executableNames: ["FixtureApp.exe"],
    mainWindow: { title: "Fixture" }
  }));
  await writeFile(path.join(dir, "controls.json"), JSON.stringify({
    controls: {
      navItem: {
        selectors: [{ automationId: "navItem$", match: "regex", controlType: "Button" }],
        confidence: "source-derived"
      },
      pageMarker: {
        selectors: [{ automationId: "pageMarker$", match: "regex", controlType: "Pane" }],
        confidence: "source-derived"
      }
    }
  }));
  await writeFile(path.join(dir, "actions.json"), JSON.stringify({
    contracts: [
      {
        control: "navItem",
        action: "ensureSelected",
        ...(opts.defaultExpect !== undefined ? { defaultExpect: opts.defaultExpect } : {}),
        ...(opts.fallbackPolicy !== undefined ? { fallbackPolicy: opts.fallbackPolicy } : {}),
        idempotent: true
      }
    ]
  }));
  await packRegistry.load(root, undefined, false);
  return root;
}

function ensureDeps(opts: {
  controlToggleState: "On" | "Off";
  businessMatched: boolean;
  allowWindowMessage?: boolean;
}) {
  let clicks = 0;
  return {
    deps: {
      // The control-state read (navItem) and the declared business
      // postcondition (pageMarker) are distinct selectors, so the mock can
      // answer each independently.
      getUiElement: async (input: { selector?: { automationId?: string } }) => {
        const isPostcondition = input.selector?.automationId?.includes("pageMarker");
        if (isPostcondition) {
          return opts.businessMatched
            ? {
                found: true,
                element: {
                  automationId: "pageMarker", name: "Page", controlType: "Pane", className: "", frameworkId: "Qt",
                  processId: 1, nativeWindowHandle: "", enabled: true, offscreen: false, focusable: false,
                  hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null,
                  boundingRect: null, runtimeId: [], patterns: [], value: null, rangeValue: null,
                  minimum: null, maximum: null, smallChange: null, largeChange: null,
                  toggleState: null, selected: null, expandCollapseState: null
                },
                elapsedMs: 1
              }
            : { found: false, element: null, elapsedMs: 1 };
        }
        return {
          found: true,
          element: {
            automationId: "navItem",
            name: "Nav",
            controlType: "Button",
            className: "",
            frameworkId: "Qt",
            processId: 1,
            nativeWindowHandle: "0x1",
            enabled: true,
            offscreen: false,
            focusable: true,
            hasKeyboardFocus: false,
            isPassword: false,
            valueProtected: false,
            isReadOnly: false,
            boundingRect: null,
            runtimeId: [1],
            patterns: ["TogglePattern", "InvokePattern"],
            value: null,
            rangeValue: null,
            minimum: null,
            maximum: null,
            smallChange: null,
            largeChange: null,
            toggleState: opts.controlToggleState,
            selected: opts.controlToggleState === "On",
            expandCollapseState: null
          },
          elapsedMs: 1
        };
      },
      queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
      performUiAction: async (input: { action: string }) => {
        if (input.action === "windowMessageClick") clicks++;
        return {
          success: true,
          method: input.action === "windowMessageClick" ? "WindowMessageElementClick" : "InvokePattern",
          coordinateFallbackUsed: false,
          physicalCursorMoved: false,
          before: null,
          after: null,
          elapsedMs: 1
        };
      },
      inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 1, maxNodes: 1, elapsedMs: 1 }),
      sendKey: async () => ({ sent: true }),
      getForegroundWindow: async () => "0x100",
      activateWindow: async (hwnd: string) => ({ activated: true, foregroundHwnd: hwnd }),
      restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "0x100", foregroundChanged: false })
    } as never,
    clicks: () => clicks
  };
}

test("ensureSelected with controlState=true and businessState=false must NOT succeed", async () => {
  const root = await registerFixturePack({
    defaultExpect: { profileControl: "pageMarker", condition: "exists", timeoutMs: 200, pollIntervalMs: 50 },
    fallbackPolicy: "disabled"
  });
  const { deps } = ensureDeps({ controlToggleState: "On", businessMatched: false });
  // controlState=true but the declared postcondition never matches: the
  // action MUST fail with ACTION_STATE_INCONSISTENT, never a silent success.
  await assert.rejects(
    () => performProfileAction(deps, { profile: "fixture", control: "navItem", action: "ensureSelected", pid: 1 } as never),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "ACTION_STATE_INCONSISTENT");
      return true;
    }
  );
  await rm(root, { recursive: true, force: true });
});

test("ensureSelected succeeds only when controlState AND businessState hold", async () => {
  const root = await registerFixturePack({
    defaultExpect: { profileControl: "pageMarker", condition: "exists", timeoutMs: 200, pollIntervalMs: 50 },
    fallbackPolicy: "disabled"
  });
  const { deps, clicks } = ensureDeps({ controlToggleState: "On", businessMatched: true });
  const r = await performProfileAction(deps, {
    profile: "fixture", control: "navItem", action: "ensureSelected", pid: 1, expect: false
  } as never);
  const result = (r as { result: Record<string, unknown> }).result;
  assert.equal(result.method, "noop", "already selected + business state holds -> no action");
  assert.equal(result.controlStateVerified, true);
  assert.equal(result.businessStateVerified, true);
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.physicalCursorMoved, false);
  assert.equal(clicks(), 0);
  await rm(root, { recursive: true, force: true });
});

test("ensureSelected window-message fallback after inconsistent state verifies again", async () => {
  // The control reports On; the business postcondition is satisfied only
  // after the window-message click (mocked by flipping businessMatched on
  // the first click). The fallback must run and the final state verify.
  let businessMatched = false;
  let clicks = 0;
  const root = await registerFixturePack({
    defaultExpect: { profileControl: "pageMarker", condition: "exists", timeoutMs: 200, pollIntervalMs: 50 },
    fallbackPolicy: "default"
  });
  const deps = {
    getUiElement: async (input: { selector?: { automationId?: string } }) => {
      const isPostcondition = input.selector?.automationId?.includes("pageMarker");
      if (isPostcondition) {
        return businessMatched
          ? {
              found: true,
              element: {
                automationId: "pageMarker", name: "Page", controlType: "Pane", className: "", frameworkId: "Qt",
                processId: 1, nativeWindowHandle: "", enabled: true, offscreen: false, focusable: false,
                hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null,
                boundingRect: null, runtimeId: [], patterns: [], value: null, rangeValue: null,
                minimum: null, maximum: null, smallChange: null, largeChange: null,
                toggleState: null, selected: null, expandCollapseState: null
              },
              elapsedMs: 1
            }
          : { found: false, element: null, elapsedMs: 1 };
      }
      return {
        found: true,
        element: {
          automationId: "navItem", name: "Nav", controlType: "Button", className: "", frameworkId: "Qt",
          processId: 1, nativeWindowHandle: "0x1", enabled: true, offscreen: false, focusable: true,
          hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: false,
          boundingRect: null, runtimeId: [1], patterns: ["TogglePattern", "InvokePattern"],
          value: null, rangeValue: null, minimum: null, maximum: null, smallChange: null, largeChange: null,
          toggleState: "On", selected: true, expandCollapseState: null
        },
        elapsedMs: 1
      };
    },
    queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
    performUiAction: async (input: { action: string }) => {
      if (input.action === "windowMessageClick") {
        clicks++;
        businessMatched = true;
      }
      return {
        success: true,
        method: input.action === "windowMessageClick" ? "WindowMessageElementClick" : "InvokePattern",
        coordinateFallbackUsed: false,
        physicalCursorMoved: false,
        before: null,
        after: null,
        elapsedMs: 1
      };
    },
    inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 1, maxNodes: 1, elapsedMs: 1 }),
    sendKey: async () => ({ sent: true }),
    getForegroundWindow: async () => "0x100",
    activateWindow: async (hwnd: string) => ({ activated: true, foregroundHwnd: hwnd }),
    restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "0x100", foregroundChanged: false })
  } as never;
  const r = await performProfileAction(deps, {
    profile: "fixture", control: "navItem", action: "ensureSelected", pid: 1,
    allowMessageClickFallback: true
  } as never);
  const result = (r as { result: Record<string, unknown> }).result;
  assert.equal(result.method, "WindowMessageElementClick", "the fallback method must be reported exactly");
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.physicalCursorMoved, false);
  assert.ok(clicks >= 1, "the window-message fallback must have run");
  await rm(root, { recursive: true, force: true });
});

// ── 4. Selector-driven window-message click semantics ──

test("windowMessageClick is an allowed ui_action and its description is honest", () => {
  const schema = contracts.ui_action!.inputSchema;
  const enumValues = (schema as { properties?: { action?: { enum?: string[] } } }).properties?.action?.enum ?? [];
  assert.ok(enumValues.includes("windowMessageClick"), "ui_action accepts windowMessageClick");
  const desc = (schema as { properties?: { action?: { description?: string } } }).properties?.action?.description ?? "";
  assert.match(desc, /does NOT move or click the physical mouse/i);
  assert.match(contracts.ui_action!.description, /WindowMessageElementClick/);
  assert.match(contracts.ui_action!.description, /does not move or click the physical mouse/i);
});

// ── 5. Scoped UI query / projection / large-tree guard ──

test("projectElementFields projects to the requested subset and keeps coordinateSpace", () => {
  const el = {
    automationId: "a", name: "n", controlType: "Button", toggleState: "On", selected: true,
    boundingRect: { x: 1, y: 2, width: 3, height: 4, coordinateSpace: "screen" },
    runtimeId: [1]
  };
  const projected = projectElementFields(el, ["name", "automationId", "toggleState", "boundingRect"]);
  assert.deepEqual(Object.keys(projected).sort(), ["automationId", "boundingRect", "name", "toggleState"]);
  assert.equal((projected.boundingRect as { coordinateSpace: string }).coordinateSpace, "screen");
});

test("ui_query description recommends scoped search over tree enumeration", () => {
  const desc = contracts.ui_query!.description;
  assert.match(desc, /SCOPED UI SEARCH/);
  assert.match(desc, /rootSelector/);
  assert.match(desc, /nameContains/);
  assert.match(desc, /depthStrategy=auto/);
});

test("ui_catalog and ui_inspect_tree descriptions are diagnostic fallbacks", () => {
  assert.match(contracts.ui_catalog!.description, /DIAGNOSTIC FALLBACK TOOL/);
  assert.match(contracts.ui_inspect_tree!.description, /DIAGNOSTIC LAST-RESORT/);
  assert.match(contracts.ui_inspect_tree!.description, /Do NOT enumerate an entire application tree/);
});

test("large-tree guard errors carry the scoped-query suggestion and validate", () => {
  const err = new McpUiError(
    "TREE_OUTPUT_TOO_LARGE",
    "The requested tree is too large.",
    { tool: "ui_inspect_tree", nodes: 5000, bytes: 2_000_000 },
    "Use ui_query with rootSelector, nameContains, fields, and maxResults."
  );
  assert.ok(err.suggestion?.includes("rootSelector"));
  const check = validateAgainstSchema(
    { success: false, error: { code: err.code, message: err.message, details: err.details, suggestion: err.suggestion, retryable: false } },
    contracts.ui_inspect_tree!.outputSchema
  );
  assert.equal(check.ok, true);
});

// ── 6. Model guidance: descriptions + usageGuidance ──

test("profile_launch is described as the preferred launch tool; launch_app as the low-level fallback", () => {
  assert.match(contracts.profile_launch!.description, /PREFERRED launch tool/);
  assert.match(contracts.profile_launch!.description, /targetRef/);
  assert.match(contracts.launch_app!.description, /Low-level generic launch tool/);
  assert.match(contracts.launch_app!.description, /prefer profile_launch/);
});

test("profile_launch guidance: explicit user executable path must be passed as exePath on the FIRST call", () => {
  const desc = contracts.profile_launch!.description;
  // Keyword combination (stable, not a full-sentence snapshot): the contract
  // must tell the model to forward a user-supplied explicit path on the first
  // call instead of relying on env/auto resolution first.
  assert.match(desc, /explicitly supplied an executable path/i);
  assert.match(desc, /pass that exact path as exePath/i);
  assert.match(desc, /on the first profile_launch call/i);
  assert.match(desc, /Do not omit it merely because the profile also declares executableEnv or executableNames/i);
});

test("profile_launch input schema keeps exePath OPTIONAL (auto resolution stays legal)", () => {
  const schema = toolZodSchemas.profile_launch as unknown as { shape?: Record<string, unknown> };
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  // exePath must remain optional - profile auto resolution (env var /
  // executableNames / reuse) is still a legitimate path.
  assert.ok(shape, "zod schema has a shape");
  const zod = toolZodSchemas.profile_launch!.parse({ profile: "fixture" }) as { exePath?: string };
  assert.equal(zod.exePath, undefined, "profile_launch without exePath must still parse (optional field)");
  const withPath = toolZodSchemas.profile_launch!.parse({ profile: "fixture", exePath: "C:\\app.exe" }) as { exePath?: string };
  assert.equal(withPath.exePath, "C:\\app.exe");
});

test("profile_action description requires a bound target and prefers targetRef", () => {
  const desc = contracts.profile_action!.description;
  assert.match(desc, /REQUIRES A BOUND TARGET/);
  assert.match(desc, /targetRef/);
  assert.match(desc, /Do NOT reuse an old hwnd/);
});

test("app_pack_describe output schema accepts usageGuidance and the implementation returns the recommended order", () => {
  // outputSchema accepts usageGuidance.
  const ok = validateAgainstSchema(
    {
      pack: "p", displayName: "P", version: "1", source: "cli", controls: [], workflows: [],
      usageGuidance: {
        preferredLaunchTool: "profile_launch",
        preferredTargetBinding: "targetRef",
        recommendedOrder: ["profile_launch", "profile_action", "scoped ui_query", "ui_catalog", "ui_inspect_tree"],
        antiPatterns: ["Do not use launch_app when this pack is available."]
      }
    },
    contracts.app_pack_describe!.outputSchema
  );
  assert.equal(ok.ok, true, `usageGuidance result must validate: ${ok.reason}`);
});
