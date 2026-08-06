// Unit tests for the semantic relation graph, control-state evaluation and
// fallback-policy resolution. Pure functions - no UIA, no VaporView strings.

import assert from "node:assert/strict";
import test from "node:test";

import { buildSemanticGraph, isSemanticDescendant, findSemanticPath, resolveSemanticControl } from "../src/app-packs/semantics.js";
import { evaluateControlState, evaluateControlStateCondition, snapshotFromElement } from "../src/profiles/control-state.js";
import { resolveFallbackPolicy, EXECUTABLE_FALLBACK_METHODS, ALWAYS_FORBIDDEN_FALLBACK_METHODS } from "../src/profiles/fallback.js";
import { CONTROL_STATE_CONDITIONS, FALLBACK_METHODS, FORBIDDEN_FALLBACK_METHODS } from "../src/app-packs/enums.js";
import type { LoadedPack } from "../src/app-packs/types.js";
import type { ControlEntry } from "../src/profiles/types.js";

// ── Graph fixtures ──

function fixturePack(): LoadedPack {
  return {
    manifest: { schemaVersion: 1, id: "graph-fixture", displayName: "Graph Fixture", version: "1.0.0" },
    profile: { id: "graph-fixture", displayName: "Graph Fixture", executableNames: ["Fixture.exe"] },
    controls: {
      controls: {
        navA: { selectors: [{ automationId: "navA" }], page: "page-a", group: "group-a", aliases: ["标签A"] },
        navB: { selectors: [{ automationId: "navB" }], page: "page-a", group: "group-b", aliases: ["标签B"] },
        rootA: { selectors: [{ automationId: "rootA" }], page: "page-a" },
        parentBox: { selectors: [{ automationId: "parentBox" }], page: "page-a", parent: "comp-card" },
        deepTarget: { selectors: [{ automationId: "deepTarget" }], page: "page-a", parent: "parentBox", group: "group-b", aliases: ["目标", "target"] },
        unrelated: { selectors: [{ automationId: "unrelated" }], page: "page-a", group: "group-a" },
        // Id-prefix lookalike that shares a prefix with deepTarget but has NO
        // declared relationship - must never match under the component scope.
        deepTargetLookalike: { selectors: [{ automationId: "deepTargetLookalike" }], page: "page-a" }
      }
    },
    actions: { contracts: [] },
    workflows: { workflows: [] },
    pages: {
      pages: [
        {
          id: "page-a",
          displayName: "页面A",
          navigationControl: "navA",
          rootControl: "rootA",
          components: ["comp-card"]
        }
      ],
      selectionGroups: [
        { id: "group-a", members: ["navA", "unrelated"], selectionMode: "single" },
        { id: "group-b", parent: "comp-card", members: ["navB", "deepTarget"], selectionMode: "single" }
      ]
    },
    components: {
      components: [
        {
          id: "comp-card",
          displayName: "卡片",
          rootControl: "rootA",
          children: ["parentBox", "unrelated", "deepTargetLookalike"]
        }
      ]
    },
    dir: "fixture",
    source: "fixture",
    sourceKind: "explicit",
    loadedAtMs: 0,
    errors: []
  };
}

test("graph: multi-level descendant through component -> container -> target", () => {
  const pack = fixturePack();
  const graph = buildSemanticGraph(pack);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "comp-card"), true);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "parentBox"), true);
  assert.equal(isSemanticDescendant(graph, "parentBox", "comp-card"), true);
  // Id-prefix lookalike is NOT a descendant (no declared edge).
  assert.equal(isSemanticDescendant(graph, "deepTargetLookalike", "parentBox"), false);
  assert.equal(isSemanticDescendant(graph, "unrelated", "parentBox"), false);
  // Self is a descendant of itself.
  assert.equal(isSemanticDescendant(graph, "deepTarget", "deepTarget"), true);
});

test("graph: control.parent creates reachability", () => {
  const pack = fixturePack();
  const graph = buildSemanticGraph(pack);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "comp-card"), true);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "page-a"), true);
});

test("graph: selection group members are reachable under the group scope", () => {
  const pack = fixturePack();
  const graph = buildSemanticGraph(pack);
  assert.equal(isSemanticDescendant(graph, "navB", "group-b"), true);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "group-b"), true);
  assert.equal(isSemanticDescendant(graph, "navA", "group-b"), false);
});

test("graph: findSemanticPath returns shortest stable path", () => {
  const pack = fixturePack();
  const graph = buildSemanticGraph(pack);
  const path = findSemanticPath(graph, "page-a", "deepTarget");
  assert.ok(path, "path must exist");
  assert.equal(path![0], "page-a");
  assert.equal(path![path!.length - 1], "deepTarget");
  // Deterministic: same call twice yields the same path.
  assert.deepEqual(path, findSemanticPath(graph, "page-a", "deepTarget"));
  assert.equal(findSemanticPath(graph, "page-a", "missing-node"), undefined);
});

test("graph: cyclic data does not hang isSemanticDescendant/findSemanticPath", () => {
  const pack = fixturePack();
  // Inject a component cycle into the fixture data.
  const cyclic = JSON.parse(JSON.stringify(pack)) as LoadedPack;
  cyclic.components!.components.push({ id: "cycle-x", children: ["cycle-y"] });
  cyclic.components!.components.push({ id: "cycle-y", children: ["cycle-x", "deepTarget"] });
  const graph = buildSemanticGraph(cyclic);
  assert.equal(isSemanticDescendant(graph, "deepTarget", "cycle-x"), true);
  const path = findSemanticPath(graph, "cycle-x", "deepTarget");
  assert.ok(path);
  assert.equal(path![path!.length - 1], "deepTarget");
});

// ── controlState evaluation ──

test("controlState: any - one condition satisfied is enough", () => {
  const eval1 = evaluateControlState({ exists: true, selected: true, toggleState: "Off" }, { any: [{ condition: "selected" }, { condition: "toggleStateEquals", toggleState: "On" }] });
  assert.equal(eval1.matched, true);
  assert.equal(eval1.usedDefault, false);
  const eval2 = evaluateControlState({ exists: true, selected: false, toggleState: "Off" }, { any: [{ condition: "selected" }, { condition: "toggleStateEquals", toggleState: "On" }] });
  assert.equal(eval2.matched, false);
});

test("controlState: all - one failing condition fails the whole", () => {
  const eval1 = evaluateControlState({ exists: true, selected: true, toggleState: "On", value: "42" }, { all: [{ condition: "selected" }, { condition: "valueEquals", expectedValue: "42" }] });
  assert.equal(eval1.matched, true);
  const eval2 = evaluateControlState({ exists: true, selected: true, toggleState: "On", value: "43" }, { all: [{ condition: "selected" }, { condition: "valueEquals", expectedValue: "42" }] });
  assert.equal(eval2.matched, false);
  const failed = eval2.conditions.find((c) => c.condition === "valueEquals");
  assert.equal(failed?.matched, false);
  assert.equal(failed?.actual, "43");
});

test("controlState: all AND any must both hold when both declared", () => {
  const good = evaluateControlState({ exists: true, selected: true, toggleState: "On" }, { all: [{ condition: "selected" }], any: [{ condition: "toggleStateEquals", toggleState: "On" }] });
  assert.equal(good.matched, true);
  const badAny = evaluateControlState({ exists: true, selected: true, toggleState: "Off" }, { all: [{ condition: "selected" }], any: [{ condition: "toggleStateEquals", toggleState: "On" }] });
  assert.equal(badAny.matched, false);
  const badAll = evaluateControlState({ exists: true, selected: false, toggleState: "On" }, { all: [{ condition: "selected" }], any: [{ condition: "toggleStateEquals", toggleState: "On" }] });
  assert.equal(badAll.matched, false);
});

test("controlState: valueEquals drives success without selected/toggle", () => {
  const eval1 = evaluateControlState({ exists: true, selected: false, toggleState: null, value: "ready" }, { all: [{ condition: "valueEquals", expectedValue: "ready" }] });
  assert.equal(eval1.matched, true);
  // Explicit declaration: default selected/toggle logic must NOT be applied.
  assert.equal(eval1.usedDefault, false);
});

test("controlState: explicit declaration never falls back to default logic", () => {
  // selected=false + toggleState=Off, but the declaration only asks for
  // valueEquals - must succeed via the declared condition.
  const eval1 = evaluateControlState({ exists: true, selected: false, toggleState: "Off", value: "ready" }, { all: [{ condition: "valueEquals", expectedValue: "ready" }] });
  assert.equal(eval1.matched, true);
  // And the mirror: declaration asks for selected; selected=false must FAIL
  // even though toggleState default logic would pass.
  const eval2 = evaluateControlState({ exists: true, selected: false, toggleState: "On" }, { all: [{ condition: "selected" }] });
  assert.equal(eval2.matched, false);
});

test("controlState: no declaration keeps the legacy default behavior", () => {
  const ok = evaluateControlState({ exists: true, selected: true, toggleState: null }, undefined);
  assert.equal(ok.matched, true);
  assert.equal(ok.usedDefault, true);
  const okToggle = evaluateControlState({ exists: true, selected: false, toggleState: "On" }, undefined);
  assert.equal(okToggle.matched, true);
  const bad = evaluateControlState({ exists: true, selected: false, toggleState: null }, undefined);
  assert.equal(bad.matched, false);
});

test("controlState: every schema condition has an executor implementation", () => {
  // Exercise each condition from the shared enum against a snapshot.
  const snap = snapshotFromElement({
    selected: true,
    toggleState: "On",
    expandCollapseState: "Expanded",
    offscreen: false,
    enabled: true,
    value: "abc",
    name: "x"
  });
  const conditions: Array<{ condition: (typeof CONTROL_STATE_CONDITIONS)[number]; expectedValue?: string; toggleState?: "On" | "Off" | "Indeterminate" }> = [
    { condition: "selected" },
    { condition: "notSelected" },
    { condition: "toggleStateEquals", toggleState: "On" },
    { condition: "expanded" },
    { condition: "collapsed" },
    { condition: "exists" },
    { condition: "notExists" },
    { condition: "visible" },
    { condition: "hidden" },
    { condition: "enabled" },
    { condition: "disabled" },
    { condition: "valueEquals", expectedValue: "abc" },
    { condition: "valueContains", expectedValue: "b" }
  ];
  assert.equal(conditions.length, CONTROL_STATE_CONDITIONS.length);
  for (const c of conditions) {
    const r = evaluateControlStateCondition(snap, c);
    assert.equal(typeof r.matched, "boolean", `condition ${c.condition}`);
  }
});

// ── fallback policy ──

const contract = { control: "x", action: "ensureSelected", fallbackPolicy: "default" as const };

test("fallback: caller opt-in is the outer gate", () => {
  const entry: ControlEntry = { selectors: [], confidence: "source-derived" };
  const d = resolveFallbackPolicy({ controlEntry: entry, actionContract: contract, callOptions: {} });
  assert.equal(d.enabled, false);
  assert.match(d.disabledReason ?? "", /caller did not opt in/);
});

test("fallback: control-level enabled=false blocks even when contract allows", () => {
  const entry: ControlEntry = { selectors: [], confidence: "source-derived", fallbackPolicy: { enabled: false, methods: ["WindowMessageElementClick"] } };
  const d = resolveFallbackPolicy({ controlEntry: entry, actionContract: contract, callOptions: { allowMessageClickFallback: true } });
  assert.equal(d.enabled, false);
  assert.match(d.disabledReason ?? "", /enabled=false/);
});

test("fallback: control-level methods restrict the try list to declared order", () => {
  const entry: ControlEntry = { selectors: [], confidence: "source-derived", fallbackPolicy: { enabled: true, methods: ["WindowMessageElementClick"] } };
  const d = resolveFallbackPolicy({ controlEntry: entry, actionContract: contract, callOptions: { allowMessageClickFallback: true } });
  assert.equal(d.enabled, true);
  assert.deepEqual(d.methods, ["WindowMessageElementClick"]);
  assert.equal(d.source, "control");
});

test("fallback: action contract disabled blocks fallback", () => {
  const entry: ControlEntry = { selectors: [], confidence: "source-derived" };
  const d = resolveFallbackPolicy({ controlEntry: entry, actionContract: { control: "x", action: "ensureSelected", fallbackPolicy: "disabled" }, callOptions: { allowMessageClickFallback: true } });
  assert.equal(d.enabled, false);
  assert.match(d.disabledReason ?? "", /contract/);
});

test("fallback: forbidden methods never appear in the try list", () => {
  const entry: ControlEntry = {
    selectors: [], confidence: "source-derived",
    fallbackPolicy: { enabled: true, methods: ["InvokePattern", "PhysicalMouse", "WindowMessageElementClick"] }
  };
  const d = resolveFallbackPolicy({ controlEntry: entry, actionContract: contract, callOptions: { allowMessageClickFallback: true } });
  assert.ok(d.methods.every((m) => !(ALWAYS_FORBIDDEN_FALLBACK_METHODS as readonly string[]).includes(m)));
  assert.deepEqual(d.methods, ["InvokePattern", "WindowMessageElementClick"]);
});

test("fallback: shared enums are consistent between schema, validator and executor", () => {
  // The executor's executable set is exactly the shared enum minus forbidden.
  assert.ok(EXECUTABLE_FALLBACK_METHODS.every((m) => (FALLBACK_METHODS as readonly string[]).includes(m)));
  assert.ok((FORBIDDEN_FALLBACK_METHODS as readonly string[]).every((m) => (ALWAYS_FORBIDDEN_FALLBACK_METHODS as readonly string[]).includes(m)));
  assert.equal(EXECUTABLE_FALLBACK_METHODS.length, 4);
});

// ── resolve_semantic_control scoping ──

test("resolve: within component scope hits multi-level descendants only", async () => {
  const { registry } = await import("../src/app-packs/registry.js");
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/sem-scope-");
  const pack = fixturePack();
  await (await import("node:fs/promises")).mkdir(dir + "/graph-fixture", { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dir + "/graph-fixture/manifest.json", JSON.stringify(pack.manifest));
  await writeFile(dir + "/graph-fixture/profile.json", JSON.stringify(pack.profile));
  await writeFile(dir + "/graph-fixture/controls.json", JSON.stringify(pack.controls));
  await writeFile(dir + "/graph-fixture/pages.json", JSON.stringify(pack.pages));
  await writeFile(dir + "/graph-fixture/components.json", JSON.stringify(pack.components));
  const r = await registry.load(dir, [], false);
  assert.equal(r.reloaded, true, JSON.stringify(r.issues));

  const res = resolveSemanticControl({ profile: "graph-fixture", query: "目标", within: "comp-card" });
  assert.ok(res.matches.some((m) => m.control === "deepTarget"), JSON.stringify(res.matches));
  // The id-prefix lookalike has no declared relationship -> excluded.
  assert.ok(!res.matches.some((m) => m.control === "deepTargetLookalike"), JSON.stringify(res.matches));
  assert.equal(res.scope.resolved, true);
  assert.equal(res.scope.within, "comp-card");

  const resGroup = resolveSemanticControl({ profile: "graph-fixture", query: "标签", within: "group-b" });
  assert.ok(resGroup.matches.some((m) => m.control === "navB"));
  assert.ok(!resGroup.matches.some((m) => m.control === "navA"));

  const resPage = resolveSemanticControl({ profile: "graph-fixture", query: "目标", within: "page-a" });
  assert.ok(resPage.matches.some((m) => m.control === "deepTarget"));
});

test("resolve: unknown within returns SEMANTIC_SCOPE_NOT_FOUND", async () => {
  const { registry } = await import("../src/app-packs/registry.js");
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/sem-scope-");
  const pack = fixturePack();
  await (await import("node:fs/promises")).mkdir(dir + "/graph-fixture", { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dir + "/graph-fixture/manifest.json", JSON.stringify(pack.manifest));
  await writeFile(dir + "/graph-fixture/profile.json", JSON.stringify(pack.profile));
  await writeFile(dir + "/graph-fixture/controls.json", JSON.stringify(pack.controls));
  await writeFile(dir + "/graph-fixture/pages.json", JSON.stringify(pack.pages));
  await writeFile(dir + "/graph-fixture/components.json", JSON.stringify(pack.components));
  await registry.load(dir, [], false);
  try {
    resolveSemanticControl({ profile: "graph-fixture", query: "目标", within: "no-such-scope" });
    assert.fail("must throw");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "SEMANTIC_SCOPE_NOT_FOUND");
  }
});

test("resolve: suggestedPath targets the right component and marks ambiguity", async () => {
  const { registry } = await import("../src/app-packs/registry.js");
  const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/sem-scope-");
  const pack = fixturePack();
  await (await import("node:fs/promises")).mkdir(dir + "/graph-fixture", { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dir + "/graph-fixture/manifest.json", JSON.stringify(pack.manifest));
  await writeFile(dir + "/graph-fixture/profile.json", JSON.stringify(pack.profile));
  await writeFile(dir + "/graph-fixture/controls.json", JSON.stringify(pack.controls));
  await writeFile(dir + "/graph-fixture/pages.json", JSON.stringify(pack.pages));
  await writeFile(dir + "/graph-fixture/components.json", JSON.stringify(pack.components));
  await registry.load(dir, [], false);

  // Single-target query: path = navigationControl -> page root -> component
  // root -> target (no unrelated component, no lookalike).
  const res = resolveSemanticControl({ profile: "graph-fixture", query: "目标" });
  assert.equal(res.pathAmbiguous, false);
  assert.ok(res.suggestedPath.includes("navA"), JSON.stringify(res.suggestedPath));
  assert.ok(res.suggestedPath.includes("rootA"));
  assert.ok(res.suggestedPath.includes("deepTarget"));
  assert.ok(!res.suggestedPath.includes("unrelated"));
  assert.ok(!res.suggestedPath.includes("deepTargetLookalike"));
  assert.equal(res.suggestedPath[res.suggestedPath.length - 1], "deepTarget");

  // Multi-group query: two matches in different groups, each group mapped by
  // a distinct query token -> the action order IS derivable, not ambiguous.
  const multi = resolveSemanticControl({ profile: "graph-fixture", query: "标签A 标签B" });
  assert.ok(multi.matches.length >= 2);
  assert.equal(multi.pathAmbiguous, false, JSON.stringify(multi));
  assert.ok(multi.suggestedPath.includes("navA"));
  assert.ok(multi.suggestedPath.includes("navB"));
  const iA = multi.suggestedPath.indexOf("navA");
  const iB = multi.suggestedPath.indexOf("navB");
  assert.ok(iA >= 0 && iB > iA, "标签A precedes 标签B in the ordered path");
});
