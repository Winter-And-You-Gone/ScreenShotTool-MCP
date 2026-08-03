import assert from "node:assert/strict";
import test from "node:test";

import { vaporViewProfile } from "../src/profiles/vaporview.js";
import { getCandidateSelectors, normalizeControlEntry, profileWindowSelector } from "../src/profiles/types.js";
import {
  getProfile,
  listProfiles,
  profileList,
  resolveProfileControl,
  performProfileAction
} from "../src/profiles/registry.js";
import { McpUiError } from "../src/uia/results.js";
import type { GetResult, ActionResult } from "../src/uia/types.js";

test("vaporview profile is registered and identifiable", () => {
  assert.equal(vaporViewProfile.id, "vaporview");
  assert.equal(vaporViewProfile.displayName, "VaporView");
  assert.ok(vaporViewProfile.processNames.includes("VaporView"));
  assert.ok(vaporViewProfile.titleContains?.includes("VaporView"));
  const p = getProfile("vaporview");
  assert.equal(p, vaporViewProfile);
});

test("profile_list includes vaporview", () => {
  const list = profileList();
  assert.ok(list.profiles.some((p) => p.id === "vaporview"));
  assert.ok(list.profiles[0]!.controlCount > 0);
});

test("vaporview profile maps expected stable controls", () => {
  const expected = [
    "mainWindow", "centralWidget", "mainPageStack", "appSidebar",
    "windowMinimizeButton", "windowMaximizeButton", "windowCloseButton",
    "titleBarMenuButton", "logListView", "logSearchEdit", "epsilonPortCombo", "pressurePortCombo"
  ];
  for (const c of expected) {
    assert.ok(vaporViewProfile.controls[c], `missing control: ${c}`);
  }
});

test("profile contains NO RuntimeId, HWND, PID, or absolute coordinates", () => {
  // Profiles must not store volatile identifiers or screen coordinates.
  const serialized = JSON.stringify(vaporViewProfile);
  assert.ok(!/runtimeId/i.test(serialized), "profile must not contain runtimeId");
  assert.ok(!/"hwnd"\s*:\s*\d/i.test(serialized), "profile must not contain hwnd values");
  assert.ok(!/"pid"\s*:\s*\d/i.test(serialized), "profile must not contain pid values");
  // No absolute screen coordinates (x/y with large pixel values as a locator)
  assert.ok(!/"boundingRect"/i.test(serialized), "profile must not store boundingRect");
  // No local VaporView paths
  assert.ok(!/T:\\\\VaporView|X:\\\\Project/i.test(serialized), "profile must not contain local paths");
});

test("profile selectors use stable locators (automationId preferred)", () => {
  const closeEntry = normalizeControlEntry(vaporViewProfile.controls.windowCloseButton)!;
  const minimizeEntry = normalizeControlEntry(vaporViewProfile.controls.windowMinimizeButton)!;
  const logEntry = normalizeControlEntry(vaporViewProfile.controls.logListView)!;
  const menuEntry = normalizeControlEntry(vaporViewProfile.controls.titleBarMenuButton)!;
  // Runtime AutomationIds are full Qt paths (verified against the live tree).
  assert.equal(closeEntry.selectors[0]!.automationId, "QApplication.MainWindow.customTitleBar.windowCloseButton");
  assert.equal(minimizeEntry.selectors[0]!.automationId, "QApplication.MainWindow.customTitleBar.windowMinimizeButton");
  // Source-derived controls use a regex suffix on the confirmed short objectName.
  assert.equal(logEntry.selectors[0]!.automationId, "logListView$");
  assert.equal(logEntry.selectors[0]!.match, "regex");
  assert.equal(menuEntry.selectors[0]!.automationId, "QApplication.MainWindow.customTitleBar.titleBarMenuButton");
  assert.equal(closeEntry.confidence, "runtime-verified");
});

test("profile entries expose confidence and non-sensitive notes", () => {
  for (const [control, rawEntry] of Object.entries(vaporViewProfile.controls)) {
    const entry = normalizeControlEntry(rawEntry)!;
    assert.ok(
      entry.confidence === "source-derived" || entry.confidence === "runtime-verified"
        || entry.confidence === "action-limited" || entry.confidence === "unsupported",
      `${control} has confidence ${entry.confidence}`
    );
    assert.ok(!/runtimeId|hwnd|pid|boundingRect/i.test(entry.notes ?? ""), control);
  }
  // Sidebar nav buttons share objectName 'appSidebarButton'; disambiguated
  // by accessibleName, not by fragile index.
  const sidebarHome = normalizeControlEntry(vaporViewProfile.controls.sidebarHome)!;
  assert.ok(sidebarHome.selectors[0]!.name, "sidebarHome must disambiguate by name");
  assert.equal(sidebarHome.confidence, "runtime-verified");
});

test("mainWindow has multiple candidate selectors tried in order", () => {
  const candidates = getCandidateSelectors(vaporViewProfile, "mainWindow");
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length >= 2);
  // First candidate: title + frameworkId (most specific, locale-stable)
  assert.equal(candidates[0]!.name, "VaporView");
  assert.equal(candidates[0]!.frameworkId, "Qt");
  // Second candidate: full-path automationId + frameworkId (fallback)
  assert.equal(candidates[1]!.frameworkId, "Qt");
  assert.ok(candidates[1]!.automationId, "second candidate should have an automationId");
});

test("getCandidateSelectors wraps a single selector into an array", () => {
  const c = getCandidateSelectors(vaporViewProfile, "windowCloseButton");
  assert.ok(Array.isArray(c));
  assert.equal(c.length, 1);
});

test("getCandidateSelectors returns empty array for unknown control", () => {
  assert.deepEqual(getCandidateSelectors(vaporViewProfile, "nonexistent"), []);
});

test("profileWindowSelector uses caller pid over profile processName", () => {
  const sel = profileWindowSelector(vaporViewProfile, { pid: 999 });
  assert.equal(sel.pid, 999);
  assert.equal(sel.processName, undefined);
});

test("profileWindowSelector falls back to profile processName/titleContains", () => {
  const sel = profileWindowSelector(vaporViewProfile, {});
  assert.equal(sel.processName, "VaporView");
  assert.equal(sel.titleContains, "VaporView");
});

test("profile does not depend on Chinese-only text for key controls", () => {
  // Key controls should be locatable by automationId/frameworkId, not by
  // locale-specific display text that would break under language changes.
  const keyControls = ["mainWindow", "windowCloseButton", "logListView", "titleBarMenuButton"];
  for (const c of keyControls) {
    const sels = getCandidateSelectors(vaporViewProfile, c);
    const hasNonTextLocator = sels.some((s) => s.automationId || s.className || s.frameworkId);
    assert.ok(hasNonTextLocator, `control ${c} relies only on display text - fragile under localization`);
  }
});

test("profile resolve records not-found and ambiguous candidates", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => resolveProfileControl({
      getUiElement: async ({ selector }): Promise<GetResult> => {
        calls.push(selector.name ?? selector.frameworkId ?? "unknown");
        if (selector.name === "VaporView") {
          return { found: false, element: null, elapsedMs: 1 };
        }
        throw new McpUiError("ELEMENT_AMBIGUOUS", "ambiguous", { candidateCount: 2 });
      },
      performUiAction: async (): Promise<ActionResult> => {
        throw new Error("unused");
      },
      queryUi: async () => {
        throw new Error("unused");
      },
      inspectUiTree: async () => {
        throw new Error("unused");
      }
    }, {
      profile: "vaporview",
      control: "mainWindow",
      pid: 123
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "PROFILE_CONTROL_NOT_FOUND");
      const details = error.details as { attempts?: Array<{ outcome: string }> };
      assert.deepEqual(details.attempts?.map((attempt) => attempt.outcome), ["not-found", "ambiguous"]);
      return true;
    }
  );
  assert.deepEqual(calls, ["VaporView", "Qt"]);
});

test("profile resolve short-circuits severe window errors", async () => {
  let calls = 0;
  await assert.rejects(
    () => resolveProfileControl({
      getUiElement: async (): Promise<GetResult> => {
        calls++;
        throw new McpUiError("WINDOW_AMBIGUOUS", "multiple windows", { candidateCount: 2 });
      },
      performUiAction: async (): Promise<ActionResult> => {
        throw new Error("unused");
      },
      queryUi: async () => {
        throw new Error("unused");
      },
      inspectUiTree: async () => {
        throw new Error("unused");
      }
    }, {
      profile: "vaporview",
      control: "mainWindow",
      pid: 123
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "WINDOW_AMBIGUOUS");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("profile action retries element-not-found candidates and preserves attempts", async () => {
  const calls: string[] = [];
  const actionResult: ActionResult = {
    success: true,
    method: "InvokePattern",
    coordinateFallbackUsed: false,
    physicalCursorMoved: false,
    before: null,
    after: null,
    elapsedMs: 1
  };
  const result = await performProfileAction({
    getUiElement: async (): Promise<GetResult> => ({ found: false, element: null, elapsedMs: 1 }),
    performUiAction: async ({ selector }): Promise<ActionResult> => {
      calls.push(selector.name ?? selector.frameworkId ?? "unknown");
      if (calls.length === 1) {
        throw new McpUiError("ELEMENT_NOT_FOUND", "missing");
      }
      return actionResult;
    },
    queryUi: async () => {
      throw new Error("unused");
    }
  }, {
    profile: "vaporview",
    control: "mainWindow",
    action: "invoke",
    pid: 123
  });

  assert.equal(result.selectorUsed?.name, undefined);
  assert.equal(result.selectorUsed?.frameworkId, "Qt");
  assert.deepEqual(calls, ["VaporView", "Qt"]);
});

test("profile action short-circuits severe errors", async () => {
  let calls = 0;
  await assert.rejects(
    () => performProfileAction({
      getUiElement: async (): Promise<GetResult> => ({ found: false, element: null, elapsedMs: 1 }),
      performUiAction: async (): Promise<ActionResult> => {
        calls++;
        throw new McpUiError("UIA_ROOT_UNAVAILABLE", "root unavailable");
      },
      queryUi: async () => {
        throw new Error("unused");
      },
      inspectUiTree: async () => {
        throw new Error("unused");
      }
    }, {
      profile: "vaporview",
      control: "mainWindow",
      action: "invoke",
      pid: 123
    }),
    (error: unknown) => {
      assert.ok(error instanceof McpUiError);
      assert.equal(error.code, "UIA_ROOT_UNAVAILABLE");
      return true;
    }
  );
  assert.equal(calls, 1);
});

test("listProfiles returns the vaporview profile", () => {
  const all = listProfiles();
  assert.ok(all.some((p) => p.id === "vaporview"));
});
