// Regression tests for the profile-resolve / profile-action declared-search
// alignment (entry.search.rootControl / maxDepth / depthStrategy must apply
// identically to BOTH tools) and for the targetRef lookup classification
// (found / expired / unknown must never be conflated).
//
// Fixtures are generic - no app-specific names.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registry as packRegistry } from "../src/app-packs/registry.js";
import {
  performProfileAction,
  resolveProfileControl,
  resolveDeclaredControlSearch,
  scopeSelectorToDeclaredSearch,
  effectiveSearchMaxDepth,
  semanticFailureContext
} from "../src/profiles/registry.js";
import type { UiElementSelector } from "../src/uia/types.js";
import { McpUiError } from "../src/uia/results.js";
import {
  bindLaunchTarget,
  getTarget,
  lookupTarget,
  resolveTargetRef,
  resetTargetBindings,
  registerTarget,
  TARGET_REF_TTL_MS
} from "../src/targets.js";

// ── Fixture pack (generic deep-control layout) ──

async function registerDeepFixturePack(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "resolve-search-root-"));
  const dir = path.join(root, "fixture-pack");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "resolve-fixture", displayName: "Resolve Fixture", version: "1.0.0"
  }));
  await writeFile(path.join(dir, "profile.json"), JSON.stringify({
    id: "resolve-fixture", displayName: "Resolve Fixture", executableNames: ["FixtureApp.exe"],
    mainWindow: { title: "Fixture" }
  }));
  await writeFile(path.join(dir, "controls.json"), JSON.stringify({
    controls: {
      // A deep control (element sits at depth ~26 inside the mocked tree).
      // The pack declares maxDepth=28 + depthStrategy=auto + rootControl so
      // both profile_action and profile_resolve must walk deep enough AND
      // stay scoped under the root.
      pageRoot: {
        selectors: [{ automationId: "pageRoot$", match: "regex" }],
        confidence: "source-derived"
      },
      deepControl: {
        selectors: [{ automationId: "deepControlButton$", match: "regex", controlType: "Button" }],
        confidence: "source-derived",
        search: { rootControl: "pageRoot", maxDepth: 28, depthStrategy: "auto" },
        page: "fixture-page",
        parent: "pageRoot"
      },
      // A control WITHOUT declared search: must fall back to the caller's
      // maxDepth (the generic default when absent).
      shallowControl: {
        selectors: [{ automationId: "shallowButton$", match: "regex", controlType: "Button" }],
        confidence: "source-derived"
      },
      // Same deep selector as deepControl but WITHOUT any declared search:
      // the element lives at depth 24+ so the generic default maxDepth (15)
      // can never reach it - this is what the OLD profile_resolve behavior
      // (ignoring entry.search) looked like.
      deepControlNoSearch: {
        selectors: [{ automationId: "deepControlButton$", match: "regex", controlType: "Button" }],
        confidence: "source-derived"
      }
    }
  }));
  await writeFile(path.join(dir, "actions.json"), JSON.stringify({ contracts: [] }));
  // pages.json declares the page referenced by deepControl.page (validation
  // requires every declared page to exist).
  await writeFile(path.join(dir, "pages.json"), JSON.stringify({
    pages: [{ id: "fixture-page", displayName: "Fixture Page" }],
    selectionGroups: []
  }));
  await packRegistry.load(root, undefined, false);
  return root;
}

// Mock UiaDeps that models a deep tree: elements only exist at depth >= 24
// (unless the caller's maxDepth allows), and the deep element is ONLY found
// when the search is scoped under the pageRoot ancestor (mirrors the real
// ancestor-scoped walk in profile_action/profile_resolve).
function deepTreeDeps(opts: { findDeep: boolean; scopedOnly: boolean }) {
  const calls: Array<{ selector: UiElementSelector; maxDepth?: number; depthStrategy?: string }> = [];
  return {
    deps: {
      getUiElement: async (input: {
        selector?: UiElementSelector;
        maxDepth?: number;
        maxNodes?: number;
        timeoutMs?: number;
        depthStrategy?: string;
      }) => {
        calls.push({ selector: input.selector!, maxDepth: input.maxDepth, depthStrategy: input.depthStrategy });
        const aid = input.selector?.automationId ?? "";
        const ancestor = input.selector?.ancestor;
        // Simulated depth: without maxDepth >= 24 the walk cannot reach the
        // deep element (generic stand-in for the ~26-level Qt stack).
        const walkDepth = input.maxDepth ?? 15;
        if (aid.includes("deepControlButton")) {
          const scoped = ancestor?.automationId?.includes("pageRoot") === true;
          if (!opts.findDeep) return { found: false, element: null, elapsedMs: 1 };
          if (walkDepth < 24) return { found: false, element: null, elapsedMs: 1 };
          if (opts.scopedOnly && !scoped) return { found: false, element: null, elapsedMs: 1 };
          return {
            found: true,
            element: {
              automationId: "deepControlButton", name: "Deep", controlType: "Button", className: "",
              frameworkId: "Qt", processId: 1, nativeWindowHandle: "", enabled: true, offscreen: false,
              focusable: true, hasKeyboardFocus: false, isPassword: false, valueProtected: false,
              isReadOnly: false, boundingRect: null, runtimeId: [1], patterns: [], value: null,
              rangeValue: null, minimum: null, maximum: null, smallChange: null, largeChange: null,
              toggleState: null, selected: null, expandCollapseState: null
            },
            elapsedMs: 1
          };
        }
        if (aid.includes("shallowButton")) {
          return { found: true, element: { automationId: "shallowButton" }, elapsedMs: 1 };
        }
        if (aid.includes("pageRoot")) {
          return { found: true, element: { automationId: "pageRoot" }, elapsedMs: 1 };
        }
        return { found: false, element: null, elapsedMs: 1 };
      },
      performUiAction: async (input: { selector?: UiElementSelector; action: string; maxDepth?: number; depthStrategy?: string }) => {
        calls.push({ selector: input.selector!, maxDepth: input.maxDepth, depthStrategy: input.depthStrategy });
        const aid = input.selector?.automationId ?? "";
        const walkDepth = input.maxDepth ?? 15;
        if (aid.includes("deepControlButton") && walkDepth >= 24) {
          return { success: true, method: "InvokePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
        }
        if (aid.includes("shallowButton")) {
          return { success: true, method: "InvokePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
        }
        return { success: false, method: "InvokePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
      },
      queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
      inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 1, maxNodes: 1, elapsedMs: 1 }),
      sendKey: async () => ({ sent: true }),
      getForegroundWindow: async () => "0x100",
      activateWindow: async (hwnd: string) => ({ activated: true, foregroundHwnd: hwnd }),
      restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "0x100", foregroundChanged: false }),
      getWindowClientRectScreen: async () => ({ x: 0, y: 0, width: 100, height: 100, coordinateSpace: "screen" as const, source: "mock" })
    },
    calls
  };
}

// ── 1. Declared search applies to BOTH profile_action and profile_resolve ──

test("deep control: profile_resolve honors declared search (maxDepth/depthStrategy/rootControl)", async () => {
  const root = await registerDeepFixturePack();
  const { deps, calls } = deepTreeDeps({ findDeep: true, scopedOnly: true });
  const r = await resolveProfileControl(deps as never, { profile: "resolve-fixture", control: "deepControl", pid: 1 } as never);
  assert.equal(r.found, true);
  // The declared rootControl must be composed into the selector as ancestor.
  const used = calls.find((c) => c.selector.automationId?.includes("deepControlButton"));
  assert.ok(used, "deep control candidate must be attempted");
  assert.ok(used.selector.ancestor, "declared rootControl must scope the selector as ancestor");
  assert.ok(used.selector.ancestor!.automationId?.includes("pageRoot"));
  // The declared maxDepth must override the caller's default.
  assert.equal(used.maxDepth, 28, "declared maxDepth must be used (not the generic default)");
  assert.equal(used.depthStrategy, "auto", "declared depthStrategy must be forwarded");
  await rm(root, { recursive: true, force: true });
});

test("deep control: profile_action non-composite invoke uses the SAME declared search", async () => {
  const root = await registerDeepFixturePack();
  const { deps, calls } = deepTreeDeps({ findDeep: true, scopedOnly: true });
  const r = await performProfileAction(deps as never, {
    profile: "resolve-fixture", control: "deepControl", action: "invoke", pid: 1
  } as never);
  assert.equal((r as { result: { success: boolean } }).result.success, true);
  const used = calls.find((c) => c.selector.automationId?.includes("deepControlButton"));
  assert.ok(used, "deep control candidate must be attempted");
  assert.ok(used.selector.ancestor, "declared rootControl must scope the selector as ancestor");
  assert.equal(used.maxDepth, 28, "profile_action must use the declared maxDepth like profile_resolve");
  assert.equal(used.depthStrategy, "auto");
  await rm(root, { recursive: true, force: true });
});

test("deep control without declared search stays at the generic maxDepth (old behavior would fail)", async () => {
  const root = await registerDeepFixturePack();
  // findDeep but scopedOnly=false: the walk CAN reach the element at depth
  // 24+ - but only when maxDepth >= 24 is passed. A control without declared
  // search keeps the generic default (15), so resolution must FAIL - exactly
  // the failure the old profile_resolve produced for deep controls. The
  // declared-search test above proves the FIX (deepControl resolves).
  const { deps } = deepTreeDeps({ findDeep: true, scopedOnly: false });
  await assert.rejects(
    () => resolveProfileControl(deps as never, { profile: "resolve-fixture", control: "deepControlNoSearch", pid: 1 } as never),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "PROFILE_CONTROL_UNRESOLVED");
      return true;
    }
  );
  await rm(root, { recursive: true, force: true });
});

test("shallow control without declared search falls back to the caller maxDepth", async () => {
  const root = await registerDeepFixturePack();
  const { deps } = deepTreeDeps({ findDeep: true, scopedOnly: false });
  const r = await resolveProfileControl(deps as never, { profile: "resolve-fixture", control: "shallowControl", pid: 1 } as never);
  assert.equal(r.found, true);
  await rm(root, { recursive: true, force: true });
});

// ── 2. rootControl disambiguation ──

test("rootControl scoping: profile_resolve picks the target under the declared root, not the lookalike", async () => {
  // Two similar controls: the real one lives under pageRoot; a lookalike with
  // the same id-prefix lives elsewhere. Without the ancestor scope the search
  // would match the lookalike (or become ambiguous).
  const root = await mkdtemp(path.join(tmpdir(), "resolve-rootscope-"));
  const dir = path.join(root, "fixture-pack");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "rootscope-fixture", displayName: "RootScope Fixture", version: "1.0.0"
  }));
  await writeFile(path.join(dir, "profile.json"), JSON.stringify({
    id: "rootscope-fixture", displayName: "RootScope Fixture", executableNames: ["FixtureApp.exe"],
    mainWindow: { title: "Fixture" }
  }));
  await writeFile(path.join(dir, "controls.json"), JSON.stringify({
    controls: {
      pageRoot: { selectors: [{ automationId: "pageRoot$", match: "regex" }], confidence: "source-derived" },
      realTarget: {
        selectors: [{ automationId: "targetButton$", match: "regex", controlType: "Button" }],
        confidence: "source-derived",
        search: { rootControl: "pageRoot", maxDepth: 20 }
      }
    }
  }));
  await writeFile(path.join(dir, "actions.json"), JSON.stringify({ contracts: [] }));
  await packRegistry.load(root, undefined, false);

  const scopedMatches = new Set(["realTarget"]);
  const deps = {
    getUiElement: async (input: { selector?: UiElementSelector; maxDepth?: number }) => {
      const aid = input.selector?.automationId ?? "";
      const ancestor = input.selector?.ancestor;
      if (aid.includes("targetButton")) {
        const underRoot = ancestor?.automationId?.includes("pageRoot") === true;
        if (!underRoot) return { found: true, element: { automationId: "targetButton", name: "LOOKALIKE" }, elapsedMs: 1 };
        return { found: true, element: { automationId: "targetButton", name: "REAL", scoped: true }, elapsedMs: 1 };
      }
      if (aid.includes("pageRoot")) return { found: true, element: { automationId: "pageRoot" }, elapsedMs: 1 };
      return { found: false, element: null, elapsedMs: 1 };
    },
    performUiAction: async (input: { selector?: UiElementSelector; action: string }) => {
      const aid = input.selector?.automationId ?? "";
      const ancestor = input.selector?.ancestor;
      if (aid.includes("targetButton") && ancestor?.automationId?.includes("pageRoot")) {
        return { success: true, method: "InvokePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
      }
      return { success: false, method: "InvokePattern", coordinateFallbackUsed: false, physicalCursorMoved: false, before: null, after: null, elapsedMs: 1 };
    },
    queryUi: async () => ({ found: false, count: 0, elements: [], truncated: false, visitedNodes: 0, elapsedMs: 1 }),
    inspectUiTree: async () => ({ roots: [], nodes: [], visitedNodes: 0, returnedNodes: 0, truncated: false, maxDepth: 1, maxNodes: 1, elapsedMs: 1 }),
    sendKey: async () => ({ sent: true }),
    getForegroundWindow: async () => "0x100",
    activateWindow: async (hwnd: string) => ({ activated: true, foregroundHwnd: hwnd }),
    restoreForegroundWindow: async () => ({ restored: true, foregroundHwnd: "0x100", foregroundChanged: false }),
    getWindowClientRectScreen: async () => ({ x: 0, y: 0, width: 100, height: 100, coordinateSpace: "screen" as const, source: "mock" })
  } as never;

  // profile_resolve must return the SCOPED element (the one under pageRoot).
  const resolved = await resolveProfileControl(deps, { profile: "rootscope-fixture", control: "realTarget", pid: 1 } as never);
  assert.equal(resolved.found, true);
  assert.equal((resolved.element as { scoped?: boolean })?.scoped, true, "resolve must target the element under the declared rootControl");

  // profile_action must reach the same scoped target.
  const acted = await performProfileAction(deps, { profile: "rootscope-fixture", control: "realTarget", action: "invoke", pid: 1 } as never);
  assert.equal((acted as { result: { success: boolean } }).result.success, true);

  assert.ok(scopedMatches.size >= 0); // keep the set referenced (documentation)
  await rm(root, { recursive: true, force: true });
});

// ── 3. Failure semantic context ──

test("profile_resolve failure carries the semantic context (page/parent/searchApplied/diagnosticScope/suggestedDiagnostic)", async () => {
  const root = await registerDeepFixturePack();
  const { deps } = deepTreeDeps({ findDeep: false, scopedOnly: false });
  await assert.rejects(
    () => resolveProfileControl(deps as never, { profile: "resolve-fixture", control: "deepControl", pid: 1 } as never),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "PROFILE_CONTROL_UNRESOLVED");
      const d = error.details as Record<string, unknown>;
      assert.equal(d.profile, "resolve-fixture");
      assert.equal(d.control, "deepControl");
      assert.equal(d.page, "fixture-page");
      assert.equal(d.component, "pageRoot");
      assert.ok(Array.isArray(d.candidatesTried));
      const applied = d.searchApplied as Record<string, unknown>;
      assert.equal(applied.maxDepth, 28, "searchApplied must report the declared maxDepth");
      assert.equal(applied.depthStrategy, "auto");
      assert.equal(applied.rootControl, "pageRoot");
      const scope = d.diagnosticScope as Record<string, unknown>;
      assert.equal(scope.rootControl, "pageRoot");
      const suggestion = d.suggestedDiagnostic as Record<string, unknown>;
      assert.equal(suggestion.tool, "ui_query");
      assert.equal(suggestion.withinControl, "pageRoot");
      assert.ok(error.suggestion, "the error must carry an actionable suggestion");
      return true;
    }
  );
  await rm(root, { recursive: true, force: true });
});

// ── 4. Shared helper behavior (unit level) ──

test("resolveDeclaredControlSearch: pack declared > caller explicit > generic default", () => {
  const entry = {
    selectors: [],
    search: { rootControl: "root", maxDepth: 28, depthStrategy: "auto" as const }
  };
  const declared = resolveDeclaredControlSearch({} as never, entry, { maxDepth: 5 });
  assert.equal(declared.maxDepth, 28, "pack-declared maxDepth must beat the caller's");
  assert.equal(declared.depthStrategy, "auto");
  assert.equal(effectiveSearchMaxDepth(declared, { maxDepth: 5 }), 28);
  const noDeclared = resolveDeclaredControlSearch({} as never, { selectors: [] }, { maxDepth: 7 });
  assert.equal(noDeclared.maxDepth, undefined);
  assert.equal(effectiveSearchMaxDepth(noDeclared, { maxDepth: 7 }), 7, "caller maxDepth wins when the pack declares none");
  assert.equal(effectiveSearchMaxDepth(noDeclared, undefined), 15, "generic default when neither declares");
});

test("scopeSelectorToDeclaredSearch composes rootControl as ancestor only when resolvable", () => {
  const base: UiElementSelector = { automationId: "btn$", match: "regex" };
  const scoped = scopeSelectorToDeclaredSearch(base, { rootControl: "root", rootSelector: { automationId: "root$" } });
  assert.deepEqual(scoped.ancestor, { automationId: "root$" });
  assert.equal(scoped.automationId, "btn$");
  const unscoped = scopeSelectorToDeclaredSearch(base, {});
  assert.equal(unscoped.ancestor, undefined);
});

test("semanticFailureContext is shared by both callers (exports the same shape)", () => {
  const ctx = semanticFailureContext(
    { selectors: [], confidence: "source-derived", page: "p", parent: "card", search: { rootControl: "card", maxDepth: 20 } },
    { profile: "pr", control: "ctl", candidatesTried: [{ selector: { automationId: "x" }, outcome: "not-found" }], searchApplied: { maxDepth: 20 } }
  );
  assert.equal(ctx?.diagnosticScope?.rootControl, "card");
  assert.deepEqual(ctx?.suggestedDiagnostic, { tool: "ui_query", withinControl: "card", maxResults: 10 });
  assert.equal(ctx?.searchApplied?.maxDepth, 20);
});

// ── 5. targetRef lookup classification ──

function makeBinding(targetRef = "target_fixture_42_100") {
  return registerTarget({
    profileId: "fixture",
    executableNames: ["FixtureApp.exe"],
    processNames: ["FixtureApp"],
    pid: 42,
    hwnd: "100",
    title: "Fixture"
  });
}

test("target lookup: binding exists + TTL valid -> found", () => {
  resetTargetBindings();
  const binding = makeBinding();
  const result = lookupTarget(binding.targetRef);
  assert.equal(result.status, "found");
  if (result.status === "found") assert.equal(result.binding.pid, 42);
  assert.equal(getTarget(binding.targetRef), binding);
});

test("target lookup: binding exists + TTL exceeded -> expired (expired:true, reason=expired)", async () => {
  resetTargetBindings();
  const binding = makeBinding();
  // Force the TTL to expire (only for the test - TTL is unchanged in prod).
  (binding as { lastResolvedAt: number }).lastResolvedAt = Date.now() - TARGET_REF_TTL_MS - 1;
  const result = lookupTarget(binding.targetRef);
  assert.equal(result.status, "expired");
  if (result.status === "expired") {
    assert.ok(result.expiredAt > binding.lastResolvedAt);
  }
  // getTarget stays a strict filter (expired -> undefined, binding removed).
  assert.equal(getTarget(binding.targetRef), undefined);
  // Re-register + re-expire for the resolveTargetRef check (getTarget swept
  // the expired binding above; resolveTargetRef must classify it "expired"
  // again, never "unknown").
  const binding2 = makeBinding();
  (binding2 as { lastResolvedAt: number }).lastResolvedAt = Date.now() - TARGET_REF_TTL_MS - 1;
  // resolveTargetRef reports the expired classification.
  const resolved = await awaitExpiredResolve(binding.targetRef);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, "TARGET_REQUIRED");
    const details = resolved.error.details as Record<string, unknown>;
    assert.equal(details.reason, "expired");
    assert.equal(details.expired, true);
    assert.match(resolved.error.message, /expired/);
    assert.match(resolved.error.suggestion ?? "", /profile_launch/);
  }
});

async function awaitExpiredResolve(targetRef: string) {
  return resolveTargetRef(targetRef, {
    checkProcessAlive: async () => ({ processAlive: true, windowAlive: true }),
    listWindows: async () => []
  });
}

test("target lookup: binding never existed -> unknown (expired:false, reason=binding-not-found)", async () => {
  resetTargetBindings();
  const result = lookupTarget("target_never_registered_1_2");
  assert.equal(result.status, "unknown");
  const resolved = await resolveTargetRef("target_never_registered_1_2", {
    checkProcessAlive: async () => ({ processAlive: true, windowAlive: true }),
    listWindows: async () => []
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    assert.equal(resolved.error.code, "TARGET_REQUIRED");
    const details = resolved.error.details as Record<string, unknown>;
    assert.equal(details.reason, "binding-not-found");
    assert.equal(details.expired, false, "unknown must NOT report expired:true");
    assert.match(resolved.error.message, /not known to the current MCP server session/);
    assert.match(resolved.error.suggestion ?? "", /Rebind\/reuse/);
  }
});

test("target lookup: cleared store + old ref -> unknown, never expired:true", async () => {
  resetTargetBindings();
  const binding = bindLaunchTarget({
    profileId: "fixture", executableNames: ["FixtureApp.exe"], processNames: ["FixtureApp"], pid: 7, hwnd: "55", title: "Fixture"
  });
  const ref = binding.targetRef;
  resetTargetBindings(); // simulates a server restart: the store is emptied
  const result = lookupTarget(ref);
  assert.equal(result.status, "unknown");
  const resolved = await resolveTargetRef(ref, {
    checkProcessAlive: async () => ({ processAlive: true, windowAlive: true }),
    listWindows: async () => []
  });
  assert.equal(resolved.ok, false);
  if (!resolved.ok) {
    const details = resolved.error.details as Record<string, unknown>;
    assert.equal(details.expired, false, "a store-cleared ref is unknown, NOT expired");
    assert.equal(details.reason, "binding-not-found");
  }
});

test("target lookup: TARGET_REF_TTL_MS unchanged (20 minutes)", () => {
  assert.equal(TARGET_REF_TTL_MS, 20 * 60 * 1000);
});
