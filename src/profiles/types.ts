// App profile interfaces.
//
// A profile maps logical control names (e.g. "mainWindow", "connectButton")
// to UiElementSelectors, and identifies the target app by process name /
// title. Profiles live in the TS layer and call the generic UIA wrappers
// (inspectUiTree/queryUi/getUiElement/performUiAction/waitForUi) - they never
// touch PowerShell directly.

import type { UiElementSelector, WindowSelector } from "../uia/types.js";

export type AppProfile = {
  id: string;
  displayName: string;
  processNames: string[];
  titleContains?: string[];
  // Each logical control may have one or more candidate selectors, tried in
  // order. The first that resolves to a unique element wins.
  controls: Record<string, UiElementSelector | UiElementSelector[]>;
};

export type ProfileRegistry = {
  profiles: Record<string, AppProfile>;
};

// Result of resolving a logical control to a concrete element.
export type ProfileResolveResult = {
  profile: string;
  control: string;
  found: boolean;
  selectorUsed?: UiElementSelector;
  candidateIndex?: number;
  candidatesTried: Array<{
    selector: UiElementSelector;
    outcome: "found" | "not-found" | "ambiguous" | "error";
    message?: string;
  }>;
  element?: unknown;
};

// Build a WindowSelector from a profile + caller overrides. Caller-supplied
// pid/processName/hwnd/titleContains always win; otherwise the profile's
// processNames[0] and titleContains[0] are used. Only the four window fields
// are read from override, so callers can pass a larger input object safely.
export function profileWindowSelector(
  profile: AppProfile,
  override?: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string }
): WindowSelector & { processName?: string; titleContains?: string } {
  const sel: WindowSelector & { processName?: string; titleContains?: string } = {};
  if (override) {
    if (override.hwnd !== undefined) sel.hwnd = override.hwnd;
    if (override.pid !== undefined) sel.pid = override.pid;
    if (override.processName !== undefined) sel.processName = override.processName;
    if (override.titleContains !== undefined) sel.titleContains = override.titleContains;
  }
  if (!sel.processName && !sel.pid && !sel.hwnd) {
    sel.processName = profile.processNames[0];
  }
  if (!sel.titleContains && profile.titleContains && profile.titleContains.length > 0) {
    sel.titleContains = profile.titleContains[0];
  }
  return sel;
}

export function getCandidateSelectors(
  profile: AppProfile,
  control: string
): UiElementSelector[] {
  const entry = profile.controls[control];
  if (!entry) {
    return [];
  }
  return Array.isArray(entry) ? entry : [entry];
}
