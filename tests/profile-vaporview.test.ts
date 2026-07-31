import assert from "node:assert/strict";
import test from "node:test";

import { vaporViewProfile } from "../src/profiles/vaporview.js";
import { getCandidateSelectors, profileWindowSelector } from "../src/profiles/types.js";
import { getProfile, listProfiles, profileList } from "../src/profiles/registry.js";

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
    "titleBarMenuButton", "logTextEdit", "epsilonPortCombo", "pressurePortCombo"
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
  // Window-chrome buttons use unique automationIds (objectName).
  assert.equal(vaporViewProfile.controls.windowMinimizeButton.automationId, "windowMinimizeButton");
  assert.equal(vaporViewProfile.controls.windowCloseButton.automationId, "windowCloseButton");
  assert.equal(vaporViewProfile.controls.logTextEdit.automationId, "logTextEdit");
  assert.equal(vaporViewProfile.controls.titleBarMenuButton.automationId, "titleBarMenuButton");
});

test("mainWindow has multiple candidate selectors tried in order", () => {
  const candidates = getCandidateSelectors(vaporViewProfile, "mainWindow");
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length >= 2);
  // First candidate: title + frameworkId (most specific)
  assert.equal(candidates[0]!.name, "VaporView");
  assert.equal(candidates[0]!.frameworkId, "Qt");
  // Second candidate: frameworkId only (fallback)
  assert.equal(candidates[1]!.frameworkId, "Qt");
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
  const keyControls = ["mainWindow", "windowCloseButton", "logTextEdit", "titleBarMenuButton"];
  for (const c of keyControls) {
    const sels = getCandidateSelectors(vaporViewProfile, c);
    const hasNonTextLocator = sels.some((s) => s.automationId || s.className || s.frameworkId);
    assert.ok(hasNonTextLocator, `control ${c} relies only on display text - fragile under localization`);
  }
});

test("listProfiles returns the vaporview profile", () => {
  const all = listProfiles();
  assert.ok(all.some((p) => p.id === "vaporview"));
});
