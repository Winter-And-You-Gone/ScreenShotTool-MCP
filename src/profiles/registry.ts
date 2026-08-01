// Profile registry + resolution logic.
//
// profile_resolve and profile_action are implemented here in the TS layer:
// they look up candidate selectors for a logical control, try each via the
// generic UIA wrappers, and either return the matched element or re-perform
// the action through performUiAction. No PowerShell is touched directly.
//
// DEPENDENCY INJECTION: this module does NOT import windows.ts. The UIA
// functions are passed in by the caller (index.ts) as a UiaDeps object. This
// guarantees the profile layer always uses the *current* runtime's UIA
// functions after a hot reload, so there is exactly one Windows helper worker
// per process. (Previously registry.ts statically imported windows.js, which
// under hot reload produced a second module instance and a second worker.)

import type { AppProfile, SelectorConfidence } from "./types.js";
import { vaporViewProfile } from "./vaporview.js";
import type { UiElementSelector } from "../uia/types.js";
import type {
  GetResult,
  ActionResult,
  QueryResult
} from "../uia/types.js";
import {
  getCandidateSelectors,
  getControlConfidence,
  normalizeControlEntry,
  profileWindowSelector
} from "./types.js";
import type { ProfileResolveInput, ProfileActionInput } from "../schemas.js";
import { McpUiError } from "../uia/results.js";

// The UIA surface the profile layer needs. index.ts supplies the real
// implementations from the loaded windows.js runtime module.
export type UiaDeps = {
  getUiElement: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    timeoutMs?: number;
  }) => Promise<GetResult>;
  performUiAction: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    action: string;
    value?: string;
    rangeValue?: number;
    allowCoordinateFallback?: boolean;
    forceCoordinateClick?: boolean;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    timeoutMs?: number;
  }) => Promise<ActionResult>;
  queryUi: (input: {
    hwnd?: string | number;
    pid?: number;
    processName?: string;
    titleContains?: string;
    selector: UiElementSelector;
    includeProcessPopups?: boolean;
    maxDepth?: number;
    maxNodes?: number;
    includePatterns?: boolean;
    maxResults?: number;
    timeoutMs?: number;
  }) => Promise<QueryResult>;
};

export const profiles: Record<string, AppProfile> = {
  [vaporViewProfile.id]: vaporViewProfile
};

export function listProfiles(): AppProfile[] {
  return Object.values(profiles);
}

export function getProfile(id: string): AppProfile | undefined {
  return profiles[id];
}

// Resolve a logical control name to a concrete element by trying each
// candidate selector in order. Returns the first unique match.
//
// Error classification (per spec):
//  - 0 matches (getUiElement returns found:false, or throws ELEMENT_NOT_FOUND):
//    record "not-found", try next candidate.
//  - 1 match: success.
//  - ELEMENT_AMBIGUOUS: record "ambiguous", try next candidate.
//  - Severe errors (WINDOW_NOT_FOUND, WINDOW_AMBIGUOUS, UIA_ROOT_UNAVAILABLE,
//    UIA_ASSEMBLY_UNAVAILABLE, TARGET_PROCESS_EXITED, INVALID_SELECTOR):
//    re-throw immediately - these are NOT "selector didn't match", they mean
//    the environment is broken and continuing would mislead the caller.
//  - Other errors (PATTERN_NOT_SUPPORTED etc.): record "error", try next.
export async function resolveProfileControl(
  deps: UiaDeps,
  input: ProfileResolveInput
): Promise<{
  profile: string;
  control: string;
  found: boolean;
  selectorUsed?: UiElementSelector;
  candidateIndex?: number;
  confidence?: SelectorConfidence;
  notes?: string;
  candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }>;
  element?: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const entry = normalizeControlEntry(profile.controls[input.control]);
  if (!entry) {
    throw new McpUiError(
      "PROFILE_CONTROL_NOT_FOUND",
      `Profile '${input.profile}' has no control named '${input.control}'.`,
      { profile: input.profile, control: input.control }
    );
  }
  const candidates = entry.selectors;
  const confidence = entry.confidence;

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];

  // Codes that mean "the environment is broken", not "this selector didn't
  // match". These short-circuit and propagate.
  const severeCodes = new Set([
    "WINDOW_NOT_FOUND",
    "WINDOW_AMBIGUOUS",
    "UIA_ROOT_UNAVAILABLE",
    "UIA_ASSEMBLY_UNAVAILABLE",
    "TARGET_PROCESS_EXITED",
    "INVALID_SELECTOR"
  ]);

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await deps.getUiElement({
        hwnd: windowSel.hwnd,
        pid: windowSel.pid,
        processName: windowSel.processName,
        titleContains: windowSel.titleContains,
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
          confidence,
          notes: entry.notes,
          candidatesTried,
          element: result.element
        };
      }
      candidatesTried.push({ selector, outcome: "not-found" });
    } catch (error) {
      if (error instanceof McpUiError) {
        if (severeCodes.has(error.code)) {
          throw error;
        }
        const outcome = error.code === "ELEMENT_AMBIGUOUS" ? "ambiguous" : "error";
        candidatesTried.push({ selector, outcome, message: error.message });
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // All candidates exhausted without a unique match.
  throw new McpUiError(
    "PROFILE_CONTROL_NOT_FOUND",
    `Profile '${input.profile}' could not resolve control '${input.control}' to a unique element.`,
    {
      profile: profile.id,
      control: input.control,
      confidence,
      notes: entry.notes,
      attempts: candidatesTried.slice(0, 10)
    }
  );
}

// Perform an action on a logical control. Reuses performUiAction (the generic
// UIA layer) - no pattern logic is duplicated here.
export async function performProfileAction(
  deps: UiaDeps,
  input: ProfileActionInput
): Promise<{
  profile: string;
  control: string;
  selectorUsed?: UiElementSelector;
  confidence?: SelectorConfidence;
  notes?: string;
  result: unknown;
}> {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new McpUiError("PROFILE_NOT_FOUND", `No profile with id '${input.profile}'.`, { profile: input.profile });
  }
  const entry = normalizeControlEntry(profile.controls[input.control]);
  if (!entry) {
    throw new McpUiError(
      "PROFILE_CONTROL_NOT_FOUND",
      `Profile '${input.profile}' has no control named '${input.control}'.`,
      { profile: input.profile, control: input.control }
    );
  }
  const candidates = entry.selectors;
  const confidence = entry.confidence;

  const windowSel = profileWindowSelector(profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains });
  const candidatesTried: Array<{ selector: UiElementSelector; outcome: string; message?: string }> = [];
  let lastError: unknown = null;

  const severeCodes = new Set([
    "WINDOW_NOT_FOUND",
    "WINDOW_AMBIGUOUS",
    "UIA_ROOT_UNAVAILABLE",
    "UIA_ASSEMBLY_UNAVAILABLE",
    "TARGET_PROCESS_EXITED",
    "INVALID_SELECTOR"
  ]);

  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i]!;
    try {
      const result = await deps.performUiAction({
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
        confidence,
        notes: entry.notes,
        result
      };
    } catch (error) {
      lastError = error;
      if (error instanceof McpUiError) {
        if (severeCodes.has(error.code)) {
          throw error;
        }
        if (error.code === "ELEMENT_NOT_FOUND") {
          candidatesTried.push({ selector, outcome: "not-found", message: error.message });
        } else {
          candidatesTried.push({ selector, outcome: error.code, message: error.message });
        }
        // PATTERN_NOT_SUPPORTED / ACTION_FAILED / COORDINATE_FALLBACK_DISABLED:
        // the element was found but the action failed - trying more candidates
        // won't help, so stop and surface the last error.
        if (error.code === "PATTERN_NOT_SUPPORTED" || error.code === "ACTION_FAILED" || error.code === "COORDINATE_FALLBACK_DISABLED") {
          break;
        }
      } else {
        candidatesTried.push({ selector, outcome: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  if (lastError instanceof McpUiError) {
    throw lastError;
  }
  throw new McpUiError("ACTION_FAILED", "All candidate selectors failed.", {
    profile: profile.id,
    control: input.control,
    confidence,
    notes: entry.notes,
    attempts: candidatesTried.slice(0, 10)
  });
}

// profile_list is pure data - no UIA deps needed.
export function profileList() {
  return {
    profiles: listProfiles().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      processNames: p.processNames,
      controlCount: Object.keys(p.controls).length
    }))
  };
}

// Build the UiaDeps object from a loaded windows module. Used by index.ts.
export function buildUiaDeps(windows: {
  getUiElement: (input: never) => Promise<GetResult>;
  performUiAction: (input: never) => Promise<ActionResult>;
  queryUi: (input: never) => Promise<QueryResult>;
}): UiaDeps {
  return {
    getUiElement: windows.getUiElement as UiaDeps["getUiElement"],
    performUiAction: windows.performUiAction as UiaDeps["performUiAction"],
    queryUi: windows.queryUi as UiaDeps["queryUi"]
  };
}
