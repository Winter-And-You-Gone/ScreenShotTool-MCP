// Profile registry + resolution logic.
//
// profile_resolve and profile_action are implemented here in the TS layer:
// they look up candidate selectors for a logical control, try each via the
// generic UIA wrappers (queryUi/getUiElement), and either return the matched
// element or re-perform the action through performUiAction. No PowerShell is
// touched directly - the profile layer is a pure orchestration shim over the
// generic UIA layer, so it stays app-agnostic and reusable.

import type { AppProfile } from "./types.js";
import { vaporViewProfile } from "./vaporview.js";
import type { UiElementSelector } from "../uia/types.js";
import { getCandidateSelectors, profileWindowSelector } from "./types.js";
import type { ProfileResolveInput, ProfileActionInput } from "../schemas.js";
import {
  getUiElement,
  performUiAction,
  queryUi
} from "../windows.js";
import { HelperError } from "../windows.js";
import { uiError } from "../uia/results.js";
import type { UiError } from "../uia/types.js";

export const profiles: Record<string, AppProfile> = {
  [vaporViewProfile.id]: vaporViewProfile
};

export function listProfiles(): AppProfile[] {
  return Object.values(profiles);
}

export function getProfile(id: string): AppProfile | undefined {
  return profiles[id];
}

function toUiError(error: unknown): UiError {
  if (error instanceof HelperError) {
    return { ok: false, code: error.code, message: error.message, details: error.details as Record<string, unknown> | undefined };
  }
  const message = error instanceof Error ? error.message : String(error);
  return uiError("ACTION_FAILED", message, { stage: "profile" });
}

// Resolve a logical control name to a concrete element by trying each
// candidate selector in order. Returns the first unique match.
export async function resolveProfileControl(
  input: ProfileResolveInput
): Promise<{
  profile: string;
  control: string;
  found: boolean;
  selectorUsed?: UiElementSelector;
  candidateIndex?: number;
  candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }>;
  element?: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw uiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const candidates = getCandidateSelectors(profile, input.control);
  if (candidates.length === 0) {
    throw uiError("PROFILE_CONTROL_NOT_FOUND", `Profile '${input.profile}' has no control named '${input.control}'.`, { profile: input.profile, control: input.control });
  }

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await getUiElement({
        ...windowSel,
        selector,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth: input.maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs
      });
      if (result.found) {
        candidatesTried.push({ selector, outcome: "found" });
        return {
          profile: profile.id,
          control: input.control,
          found: true,
          selectorUsed: selector,
          candidateIndex: i,
          candidatesTried,
          element: result.element
        };
      }
      candidatesTried.push({ selector, outcome: "not-found" });
    } catch (error) {
      if (error instanceof HelperError) {
        candidatesTried.push({ selector, outcome: error.code === "ELEMENT_AMBIGUOUS" ? "ambiguous" : "error", message: error.message });
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    profile: profile.id,
    control: input.control,
    found: false,
    candidatesTried
  };
}

// Perform an action on a logical control. Reuses performUiAction (the generic
// UIA layer) - no pattern logic is duplicated here.
export async function performProfileAction(
  input: ProfileActionInput
): Promise<{
  profile: string;
  control: string;
  selectorUsed?: UiElementSelector;
  result: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw uiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const candidates = getCandidateSelectors(profile, input.control);
  if (candidates.length === 0) {
    throw uiError("PROFILE_CONTROL_NOT_FOUND", `Profile '${input.profile}' has no control named '${input.control}'.`, { profile: input.profile, control: input.control });
  }

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];
  let lastError: unknown = null;

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await performUiAction({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
        selector,
        action: input.action,
        value: input.value,
        rangeValue: input.rangeValue,
        allowCoordinateFallback: input.allowCoordinateFallback,
        forceCoordinateClick: input.forceCoordinateClick,
        includeProcessPopups: input.includeProcessPopups,
        maxDepth: input.maxDepth,
        maxNodes: input.maxNodes,
        timeoutMs: input.timeoutMs
      });
      return {
        profile: profile.id,
        control: input.control,
        selectorUsed: selector,
        result
      };
    } catch (error) {
      lastError = error;
      if (error instanceof HelperError) {
        // ELEMENT_NOT_FOUND / ELEMENT_AMBIGUOUS -> try next candidate.
        // PATTERN_NOT_SUPPORTED / ACTION_FAILED -> these mean the element was
        // found but the action failed; trying other candidates is unlikely to
        // help, but we still try and surface the last error.
        candidatesTried.push({ selector, outcome: error.code, message: error.message });
        if (error.code === "PATTERN_NOT_SUPPORTED" || error.code === "ACTION_FAILED" || error.code === "COORDINATE_FALLBACK_DISABLED") {
          break;
        }
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  throw toUiError(lastError ?? new Error("All candidate selectors failed."));
}

// Resolve + return a list of profile ids (for profile_list).
export function profileList() {
  return { profiles: listProfiles().map((p) => ({ id: p.id, displayName: p.displayName, processNames: p.processNames, controlCount: Object.keys(p.controls).length })) };
}

// Query helper for the profile layer (used by resolve). Kept for completeness;
// resolveProfileControl uses getUiElement directly.
export async function queryProfileControl(input: ProfileResolveInput) {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw uiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const candidates = getCandidateSelectors(profile, input.control);
  if (candidates.length === 0) {
    throw uiError("PROFILE_CONTROL_NOT_FOUND", `Profile '${input.profile}' has no control named '${input.control}'.`, { profile: input.profile, control: input.control });
  }
  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  return queryUi({
    hwnd: windowSel.hwnd,
    pid: windowSel.pid,
    processName: windowSel.processName,
    titleContains: windowSel.titleContains,
    selector: candidates[0]!,
    includeProcessPopups: input.includeProcessPopups,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    includePatterns: true,
    maxResults: 100,
    timeoutMs: input.timeoutMs
  });
}
