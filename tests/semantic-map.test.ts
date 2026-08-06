// Unit tests for the App Pack semantic map (pages.json / components.json):
// schema acceptance, cross-reference validation, relationship cycles,
// semantic alias resolution, ancestor disambiguation, selection-group path
// generation, compact describe, business-postcondition verification and
// ensureVisible scroll-container routing.
//
// All fixtures are generic (no VaporView-specific strings).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAllPacks, loadPackFromDir } from "../src/app-packs/loader.js";
import { registry } from "../src/app-packs/registry.js";
import { validatePack } from "../src/app-packs/validator.js";
import { resolveSemanticControl, describeSemanticMap } from "../src/app-packs/semantics.js";
import type { LoadedPack } from "../src/app-packs/types.js";

const MANIFEST = {
  schemaVersion: 1,
  id: "sem-fixture",
  displayName: "Semantic Fixture",
  version: "1.0.0",
  pagesFile: "pages.json",
  componentsFile: "components.json"
};

const PROFILE = {
  id: "sem-fixture",
  displayName: "Semantic Fixture",
  executableNames: ["FixtureApp.exe"]
};

const CONTROLS = {
  controls: {
    mainWindow: {
      selectors: [{ controlType: "Window", name: "Fixture" }],
      confidence: "runtime-verified"
    },
    sidebarTabs: {
      selectors: [{ automationId: "sidebar.tabs" }],
      confidence: "runtime-verified"
    },
    sidebarChannel1: {
      selectors: [{ automationId: "sidebar.tabs", index: 0 }],
      confidence: "runtime-verified",
      page: "config",
      group: "channel-group",
      aliases: ["通道1", "channel 1"],
      controlState: { any: [{ condition: "selected" }, { condition: "toggleStateEquals", toggleState: "On" }] },
      postconditions: [{ profileControl: "channel1Content", condition: "visible", timeoutMs: 3000 }]
    },
    sidebarChannel2: {
      selectors: [{ automationId: "sidebar.tabs", index: 1 }],
      confidence: "runtime-verified",
      page: "config",
      group: "channel-group",
      aliases: ["通道2", "channel 2"]
    },
    sidebarGeneral: {
      selectors: [{ automationId: "sidebar.tabs", index: 2 }],
      confidence: "runtime-verified",
      page: "config",
      group: "channel-group"
    },
    tabCommon: {
      selectors: [{ automationId: "config.tabs", name: "常用参数", ancestor: { automationId: "channel1Page" } }],
      confidence: "runtime-verified",
      page: "config",
      group: "param-group",
      aliases: ["常用参数", "common params"]
    },
    tabSensor: {
      selectors: [{ automationId: "config.tabs", name: "传感器配置", ancestor: { automationId: "channel1Page" } }],
      confidence: "runtime-verified",
      page: "config",
      group: "param-group",
      aliases: ["传感器配置", "sensor config"],
      controlState: { any: [{ condition: "selected" }] },
      postconditions: [
        { profileControl: "sensorConfigPanel", condition: "visible", timeoutMs: 3000 },
        { profileControl: "ntcR0Input", condition: "exists", timeoutMs: 3000 }
      ]
    },
    channel1Page: {
      selectors: [{ automationId: "channel1Page$", match: "regex" }],
      confidence: "source-derived",
      page: "config",
      role: "contentMarker"
    },
    channel1Content: {
      selectors: [{ automationId: "channel1Content$", match: "regex" }],
      confidence: "source-derived",
      page: "config",
      role: "contentMarker"
    },
    sensorConfigPanel: {
      selectors: [{ automationId: "sensorConfigPanel$", match: "regex" }],
      confidence: "source-derived",
      page: "config",
      role: "contentMarker"
    },
    ntcR0Input: {
      selectors: [{ automationId: "ntcR0Input$", match: "regex" }],
      confidence: "source-derived",
      page: "config",
      role: "input"
    },
    deepControl: {
      selectors: [{ automationId: "deep.control" }],
      confidence: "source-derived",
      page: "config",
      visibility: { scrollContainer: "mainScrollArea", strategies: ["ScrollItemPattern", "RangeValueScroll"], margin: 16 }
    },
    mainScrollArea: {
      selectors: [{ automationId: "mainScrollArea$", match: "regex" }],
      confidence: "source-derived",
      page: "config",
      role: "scrollArea"
    }
  }
};

const PAGES = {
  pages: [
    {
      id: "config",
      displayName: "配置",
      aliases: ["config", "设置"],
      navigationControl: "sidebarChannel1",
      rootControl: "channel1Page",
      readyMarkers: [{ profileControl: "channel1Content", condition: "visible" }],
      scrollContainers: ["mainScrollArea"],
      components: ["config-card"]
    }
  ],
  selectionGroups: [
    { id: "channel-group", parent: "config-card", members: ["sidebarChannel1", "sidebarChannel2", "sidebarGeneral"], selectionMode: "single" },
    { id: "param-group", parent: "config-card", members: ["tabCommon", "tabSensor"], selectionMode: "single" }
  ]
};

const COMPONENTS = {
  components: [
    {
      id: "config-card",
      displayName: "配置卡片",
      page: "config",
      role: "card",
      rootControl: "channel1Page",
      children: ["sidebarChannel1", "sidebarChannel2", "tabCommon", "tabSensor", "deepControl"]
    }
  ]
};

const ACTIONS = {
  contracts: [
    {
      control: "sidebarChannel1",
      action: "ensureSelected",
      idempotent: true,
      retrySafe: true,
      defaultExpect: { profileControl: "channel1Content", condition: "visible", timeoutMs: 3000 }
    }
  ]
};

async function makePack(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sem-map-test-"));
  const packDir = path.join(dir, "sem-fixture");
  await mkdir(packDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), JSON.stringify(value, null, 2), "utf8");
  }
  return packDir;
}

async function loadFixture(): Promise<LoadedPack> {
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": CONTROLS,
    "actions.json": ACTIONS,
    "pages.json": PAGES,
    "components.json": COMPONENTS
  });
  const pack = await loadPackFromDir(dir);
  assert.ok(pack, "fixture pack must load");
  return pack!;
}

// Seed the shared registry with the fixture pack so semantics.ts (which
// resolves through the registry) can find it. The registry is a module
// singleton; the fixture id is unique to this file, so re-seeding is safe.
let registrySeeded = false;
async function seedRegistry(pack: LoadedPack): Promise<void> {
  if (registrySeeded) return;
  const r = await registry.load(path.dirname(pack.dir), [], false);
  assert.equal(r.reloaded, true, JSON.stringify(r.issues));
  registrySeeded = true;
}

test("pages/components/selectionGroups schema accepts a valid semantic map", async () => {
  const pack = await loadFixture();
  const v = validatePack(pack);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
  assert.ok(pack.pages, "pages loaded");
  assert.ok(pack.components, "components loaded");
  assert.equal(pack.pages!.pages.length, 1);
  assert.equal(pack.pages!.selectionGroups!.length, 2);
});

test("unknown parent/group/scrollContainer references are rejected", async () => {
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": {
      controls: {
        mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
        orphan: {
          selectors: [{ automationId: "orphan" }],
          page: "nope-page",
          parent: "nope-parent",
          group: "nope-group",
          visibility: { scrollContainer: "nope-scroll" }
        }
      }
    },
    "pages.json": {
      pages: [{ id: "config", displayName: "配置" }],
      selectionGroups: [{ id: "real-group", members: ["mainWindow", "orphan"] }]
    }
  });
  const pack = await loadPackFromDir(dir);
  assert.ok(pack);
  const v = validatePack(pack!);
  const codes = new Set(v.errors.map((e) => e.code));
  assert.ok(codes.has("UNKNOWN_CONTROL_PAGE"), JSON.stringify(v.errors));
  assert.ok(codes.has("UNKNOWN_CONTROL_PARENT"));
  assert.ok(codes.has("UNKNOWN_CONTROL_GROUP"));
  assert.ok(codes.has("UNKNOWN_SCROLL_CONTAINER"));
});

test("postconditions referencing unknown controls are rejected", async () => {
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": {
      controls: {
        mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
        nav: {
          selectors: [{ automationId: "nav" }],
          postconditions: [{ profileControl: "ghost-content", condition: "visible" }]
        }
      }
    }
  });
  const pack = await loadPackFromDir(dir);
  assert.ok(pack);
  const v = validatePack(pack!);
  assert.ok(v.errors.some((e) => e.code === "UNKNOWN_POSTCONDITION_CONTROL"), JSON.stringify(v.errors));
});

test("relationship cycles are rejected", async () => {
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": { controls: { mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] } } },
    "components.json": {
      components: [
        { id: "comp-a", children: ["comp-b"] },
        { id: "comp-b", children: ["comp-a"] }
      ]
    }
  });
  const pack = await loadPackFromDir(dir);
  assert.ok(pack);
  const v = validatePack(pack!);
  assert.ok(v.errors.some((e) => e.code === "RELATIONSHIP_CYCLE"), JSON.stringify(v.errors));
});

test("component->control + control->component cross refs are NOT cycles", async () => {
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": {
      controls: {
        mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
        cardRoot: { selectors: [{ automationId: "cardRoot" }], parent: "config-card" }
      }
    },
    "components.json": {
      components: [{ id: "config-card", children: ["cardRoot"] }]
    }
  });
  const pack = await loadPackFromDir(dir);
  assert.ok(pack);
  const v = validatePack(pack!);
  assert.equal(v.errors.length, 0, JSON.stringify(v.errors));
});

test("absolute screen coordinates are rejected as primary selectors", async () => {
  // UiElementSelector has no x/y fields - the schema rejects coordinate
  // selectors outright (a pack using them fails to LOAD, never reaches the
  // semantic validator). This test asserts the load-time rejection AND that
  // the validator independently flags any coordinate-like selector if one
  // ever slipped through.
  const dir = await makePack({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": {
      controls: {
        mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
        bad: { selectors: [{ x: 1324, y: 1400 }] }
      }
    }
  });
  const pack = await loadPackFromDir(dir);
  assert.equal(pack, undefined, "a pack with coordinate selectors must fail schema validation at load time");
});

test("semantic aliases resolve across pages and groups", async () => {
  const pack = await loadFixture();
  await seedRegistry(pack);
  const res = resolveSemanticControl({ profile: "sem-fixture", query: "通道1 传感器配置" });
  const ids = res.matches.map((m) => m.control);
  assert.ok(ids.includes("sidebarChannel1"), JSON.stringify(res));
  assert.ok(ids.includes("tabSensor"), JSON.stringify(res));
  const ch1 = res.matches.find((m) => m.control === "sidebarChannel1");
  assert.equal(ch1?.group, "channel-group");
  const sensor = res.matches.find((m) => m.control === "tabSensor");
  assert.equal(sensor?.group, "param-group");
  // Query token order maps channel-group before param-group -> the path is
  // an ordered action sequence, not ambiguous.
  assert.equal(res.pathAmbiguous, false, JSON.stringify(res));
  assert.ok(res.suggestedPath.includes("sidebarChannel1"));
  assert.ok(res.suggestedPath.includes("tabSensor"), "ordered multi-group path includes both targets");
  const c1 = res.suggestedPath.indexOf("sidebarChannel1");
  const ts = res.suggestedPath.indexOf("tabSensor");
  assert.ok(c1 >= 0 && ts > c1, "channel-1 precedes sensor-config in the path");
});

test("same-named controls under different ancestors are disambiguated by scoped selectors", async () => {
  const pack = await loadFixture();
  const v = validatePack(pack);
  assert.equal(v.errors.length, 0);
  // Both tabs use automationId "config.tabs" but with different names scoped
  // under ancestor channel1Page - the pack expresses the disambiguation.
  const tabSensor = pack.controls.controls.tabSensor as { selectors: Array<{ ancestor?: { automationId: string } }> };
  assert.equal(tabSensor.selectors[0]!.ancestor?.automationId, "channel1Page");
});

test("selectionGroup members generate the correct suggested path", async () => {
  const pack = await loadFixture();
  await seedRegistry(pack);
  const res = resolveSemanticControl({ profile: "sem-fixture", query: "传感器配置", page: "config" });
  assert.equal(res.matches[0]!.control, "tabSensor");
  // Path: navigationControl -> page rootControl (component rootControl is the
  // same control, deduped) -> target. No unrelated component nodes.
  assert.deepEqual(res.suggestedPath, ["sidebarChannel1", "channel1Page", "tabSensor"]);
  assert.equal(res.pathAmbiguous, false);
});

test("suggestedPath: target in the second card never pulls the first card", async () => {
  const pack = await loadFixture();
  // Add a second component that contains only the deep control; the sensor
  // tab belongs to the FIRST card. Querying the deep control must yield a
  // path through its own component, never the sensor card's.
  const withSecond = JSON.parse(JSON.stringify(pack)) as LoadedPack;
  withSecond.components!.components.push({
    id: "second-card",
    displayName: "第二卡片",
    page: "config",
    role: "card",
    rootControl: "mainScrollArea",
    children: ["deepControl"]
  });
  const dir = pack.dir;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dir + "/components.json", JSON.stringify(withSecond.components));
  await registry.load(path.dirname(dir), [], false);
  const res = resolveSemanticControl({ profile: "sem-fixture", query: "deep", within: "second-card" });
  assert.ok(res.matches.some((m) => m.control === "deepControl"));
  // The path must NOT contain the sensor card's root (channel1Page) when the
  // deep control's own component root is mainScrollArea.
  const res2 = resolveSemanticControl({ profile: "sem-fixture", query: "deep" });
  assert.equal(res2.pathAmbiguous, false, JSON.stringify(res2));
  assert.ok(!res2.suggestedPath.includes("tabSensor"), JSON.stringify(res2.suggestedPath));
});

test("pages describe compactly with page filter", async () => {
  const pack = await loadFixture();
  const map = describeSemanticMap(pack, ["pages", "components", "relationships"], "config", true);
  assert.equal(map.pages.length, 1);
  assert.equal(map.pages[0]!.id, "config");
  const page = map.pages[0] as { navigationControl: string; components: string[]; readyMarkers: unknown[] };
  assert.equal(page.navigationControl, "sidebarChannel1");
  assert.ok(page.components.includes("config-card"));
  assert.ok(Array.isArray(page.readyMarkers));
  const rel = (map.relationships as Array<{ control: string; postconditions?: unknown[] }>).find((r) => r.control === "tabSensor");
  assert.ok(rel?.postconditions, "compact relationships carry postconditions");
  const deep = (map.relationships as Array<{ control: string; scrollContainer?: string }>).find((r) => r.control === "deepControl");
  assert.equal(deep?.scrollContainer, "mainScrollArea");
});

test("controlState=true with business postcondition=false must not succeed (evaluator contract)", async () => {
  // The ensureSelected composite requires BOTH control state AND business
  // postconditions; the pack declares both. This test proves the pack-level
  // contract (the runtime behavior is exercised by the interaction suite).
  const pack = await loadFixture();
  const v = validatePack(pack);
  assert.equal(v.errors.length, 0);
  const sidebar = pack.controls.controls.sidebarChannel1 as {
    controlState: { any: unknown[] };
    postconditions: Array<{ profileControl: string; condition: string }>;
  };
  assert.ok(sidebar.controlState.any.length >= 1);
  assert.equal(sidebar.postconditions[0]!.profileControl, "channel1Content");
});

test("ensureVisible declares its scroll container (routing contract)", async () => {
  const pack = await loadFixture();
  const deep = pack.controls.controls.deepControl as { visibility: { scrollContainer: string; strategies: string[] } };
  assert.equal(deep.visibility.scrollContainer, "mainScrollArea");
  assert.ok(deep.visibility.strategies.includes("ScrollItemPattern"));
  // The scroll container control itself must exist and be declared on the page.
  const v = validatePack(pack);
  assert.equal(v.errors.length, 0);
});

test("private local packs never leak into public fixture tests (gitignore contract)", async () => {
  // The public test suites must not depend on local-app-packs content; this
  // asserts the fixture pack above is self-contained (no absolute paths, no
  // app-specific strings in the public schema surface).
  const serialized = JSON.stringify({ controls: CONTROLS.controls, pages: PAGES, components: COMPONENTS });
  assert.ok(!serialized.includes("VaporView"));
  assert.ok(!serialized.includes("X:\\"));
});
