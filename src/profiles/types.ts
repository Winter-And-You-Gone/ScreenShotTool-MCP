// App profile interfaces.
//
// A profile maps logical control names (e.g. "mainWindow", "connectButton")
// to UiElementSelectors, and identifies the target app by process name /
// title. Profiles live in the TS layer and are pure data + selector
// generation; they never touch PowerShell. The UIA functions are injected by
// the caller (index.ts), so a hot-reload of windows.js does not leave the
// profile layer holding a stale module instance (and a second worker).

import type { UiElementSelector, WindowSelector } from "../uia/types.js";

// Confidence label for a control's selectors.
// - "runtime-verified": a live UIA probe resolved this control to a unique
//   element against the running app (non-elevated, asInvoker build).
// - "source-derived": the AutomationId was confirmed by reading the app's
//   source (setObjectName) but NOT yet verified against the live tree.
// - "action-limited": the control is reachable but lacks standard UIA
//   patterns (e.g. a custom-painted widget); only fallback actions apply.
// - "unsupported": the control cannot be operated via UIA/fallback at all.
// - "ambiguous": multiple elements matched; needs a more specific selector.
export type SelectorConfidence =
  | "runtime-verified"
  | "source-derived"
  | "action-limited"
  | "unsupported"
  | "ambiguous";

export type ControlEntry = {
  selectors: UiElementSelector[];
  confidence: SelectorConfidence;
  notes?: string;
};

export type AppProfile = {
  id: string;
  displayName: string;
  processNames: string[];
  titleContains?: string[];
  // Executable file name(s) used by profile_launch to resolve the binary.
  // Never stores an absolute path; resolution uses exePath > env var > config
  // > common build dirs > PATH at runtime.
  executableNames?: string[];
  // Environment variable name (e.g. "VAPORVIEW_EXE") that overrides the
  // executable path. Machine-specific paths must come through this, not source.
  executableEnv?: string;
  // When true, profile_launch reads the resolved executable's embedded Win32
  // manifest and REJECTS a requireAdministrator/highestAvailable build before
  // spawning it (VAPORVIEW_OLD_ELEVATED_BUILD): a non-elevated MCP cannot
  // inspect an elevated process, and spawning it would trigger a UAC prompt.
  // The latest VaporView builds asInvoker; old builds were requireAdministrator.
  requiresAsInvoker?: boolean;
  // Each logical control maps to one or more candidate selectors (tried in
  // order) plus a confidence label. For backwards compatibility a bare
  // selector / selector[] is also accepted and wrapped with the default
  // confidence "source-derived".
  controls: Record<string, ControlEntry | UiElementSelector | UiElementSelector[]>;
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
  confidence?: SelectorConfidence;
  candidatesTried: Array<{
    selector: UiElementSelector;
    outcome: "found" | "not-found" | "ambiguous" | "error";
    message?: string;
  }>;
  element?: unknown;
};

// Normalize a control entry to a ControlEntry (wrapping bare selectors).
export function normalizeControlEntry(
  entry: ControlEntry | UiElementSelector | UiElementSelector[] | undefined
): ControlEntry | undefined {
  if (!entry) {
    return undefined;
  }
  if (Array.isArray(entry)) {
    return { selectors: entry, confidence: "source-derived" };
  }
  // ControlEntry shape (has `selectors`)
  if ("selectors" in entry && Array.isArray((entry as ControlEntry).selectors)) {
    return entry as ControlEntry;
  }
  // Bare selector object
  return { selectors: [entry as UiElementSelector], confidence: "source-derived" };
}

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
  const entry = normalizeControlEntry(profile.controls[control]);
  if (!entry) {
    return [];
  }
  return entry.selectors;
}

export function getControlConfidence(
  profile: AppProfile,
  control: string
): SelectorConfidence | undefined {
  return normalizeControlEntry(profile.controls[control])?.confidence;
}
