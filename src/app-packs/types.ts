// App Pack type definitions.
//
// An App Pack is a declarative JSON directory that adapts the generic Windows
// UI Automation core to one desktop application. Packs contain NO executable
// code - only JSON, validated by JSON Schema at load time. See
// app-packs/schemas/ for the public JSON Schema files.

import type { UiElementSelector } from "../uia/types.js";
import type { SelectorConfidence } from "../profiles/types.js";
import type { BackgroundPolicy, InteractionMode, PackInteractionConfig } from "../interaction.js";

// 4.1 manifest.json ---------------------------------------------------------

// NOTE: "internal" visibility was REMOVED (batch 2): no composition engine
// exists, so an internal workflow would be unreachable. A pack that declares
// `"visibility": "internal"` fails schema validation at load time.
export type CatalogVisibility = "session" | "hidden";

export type PackManifest = {
  schemaVersion: number;
  id: string;
  displayName: string;
  version: string;
  description?: string;
  profileFile?: string;
  controlsFile?: string;
  actionsFile?: string;
  workflowsFile?: string;
  catalogVisibility?: CatalogVisibility;
  enabled?: boolean;
};

// 4.2 profile.json ----------------------------------------------------------

export type PackMainWindowRule = {
  title?: string;
  titleMatch?: "exact" | "contains" | "regex";
  frameworkId?: string;
  className?: string;
};

export type PackProfile = {
  id: string;
  displayName?: string;
  executableNames: string[];
  executableEnv?: string;
  mainWindow?: PackMainWindowRule;
  titleContains?: string[];
  processNames?: string[];
  launch?: {
    reuseIfRunning?: boolean;
    waitForWindow?: boolean;
    timeoutMs?: number;
    noActivate?: boolean;
  };
  security?: {
    requiresAsInvoker?: boolean;
  };
  // Interaction-mode defaults for this pack (auto/background/foregroundDemo).
  // The core resolves mode as: caller explicit > workflow config > this > auto.
  interaction?: PackInteractionConfig;
  // AutomationId regexes that identify menu rows which open a submenu; used
  // by the generic openMenu/openSubmenu composites to label items.
  submenuAidPatterns?: string[];
};

// 4.3 controls.json ---------------------------------------------------------

export type PackControlEntry = {
  selectors: UiElementSelector[];
  // Confidence labels accepted in pack files ("stable"/"conditionally-stable"/
  // "fragile" are catalog-style labels mapped to core labels by the adapter).
  confidence?: SelectorConfidence | "stable" | "conditionally-stable" | "fragile";
  description?: string;
  notes?: string;
  // Page-navigation group: controls in the same group are mutually exclusive
  // pages (e.g. sidebar nav). Used by state capture/restore to find the
  // ACTUALLY selected page before a navigation action.
  selectionGroup?: string;
  // Menu-routing hints for composite actions. All optional; when absent the
  // core falls back to generic behavior. This is how app-specific menu
  // structure is expressed WITHOUT core code changes.
  menu?: {
    // True when the control is a menu section row whose submenu opens via
    // keyboard-Right rather than InvokePattern.
    opensSubmenu?: boolean;
    // True when the control is a menu command row.
    command?: boolean;
    // "keyboard-enter": trigger via focus + Enter (non-blocking) instead of
    // InvokePattern. Needed for commands that open a modal dialog which
    // blocks InvokePattern.Invoke().
    invokeMode?: "pattern" | "keyboard-enter";
    // Logical control name of the menu panel window that receives keyboard
    // events (e.g. a Qt::Tool top-level window). Resolved via the profile.
    panelControl?: string;
  };
};

export type PackControls = {
  controls: Record<string, PackControlEntry | UiElementSelector | UiElementSelector[]>;
};

// 4.4 actions.json ----------------------------------------------------------

export type PackExpectCondition =
  | "exists"
  | "notExists"
  | "visible"
  | "hidden"
  | "enabled"
  | "disabled"
  | "valueEquals"
  | "valueContains"
  | "toggleStateEquals"
  | "selected"
  | "notSelected"
  | "expanded"
  | "collapsed"
  | "countEquals";

export type PackDefaultExpect = {
  // Logical control name (resolved via the pack) OR a full UiElementSelector.
  profileControl?: string;
  selector?: UiElementSelector;
  condition: PackExpectCondition;
  timeoutMs?: number;
  pollIntervalMs?: number;
  expectedValue?: string;
  toggleState?: "On" | "Off" | "Indeterminate";
  expectedCount?: number;
};

export type PackActionContract = {
  control: string;
  action: string;
  idempotent?: boolean;
  retrySafe?: boolean;
  destructive?: boolean;
  requiresConfirmation?: boolean;
  defaultExpect?: PackDefaultExpect | false;
  preferredMethod?: string;
  fallbackPolicy?: "default" | "disabled";
  maxAttempts?: number;
  // Page-navigation group this control belongs to (optional; must match the
  // controls' own selectionGroup when both are declared).
  selectionGroup?: string;
  // Declared background capability of this action:
  //   safe               - verified to need no activation and no global input.
  //   bestEffort         - usually works in background, but the app or UIA
  //                        provider may refuse; failures surface as errors and
  //                        are NEVER auto-upgraded to foreground.
  //   foregroundRequired - rejected up front in background mode
  //                        (FOREGROUND_REQUIRED / PIPELINE_NOT_BACKGROUND_SAFE).
  backgroundPolicy?: BackgroundPolicy;
};

export type PackActions = {
  contracts: PackActionContract[];
};

// 4.5 workflows.json --------------------------------------------------------

export type PackCaptureEntry = {
  saveAs: string;
  read?: { tool?: string; args?: Record<string, unknown> };
};

export type PackWorkflowStep = {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
  exports?: Record<string, string>;
  expect?: PackDefaultExpect | false;
  retry?: {
    maxAttempts?: number;
    delayMs?: number;
    backoffMultiplier?: number;
    onlyCodes?: string[];
  };
  captureBefore?: PackCaptureEntry;
  // Finally-only: error codes tolerated (step reported as skipped).
  ignoreCodes?: string[];
};

export type PackWorkflow = {
  id: string;
  description?: string;
  safe?: boolean;
  tested?: boolean;
  restoresState?: boolean;
  visibility?: CatalogVisibility;
  // Workflow-level interaction mode (priority between the caller's explicit
  // interactionMode and the pack profile default).
  interactionMode?: InteractionMode;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  steps: PackWorkflowStep[];
  finally?: PackWorkflowStep[];
  restore?: "always" | "never" | "onFailure";
  captureBefore?: PackCaptureEntry[];
};

// Loaded pack (validated, in memory) ---------------------------------------

export type PackSourceKind = "cli" | "env" | "appdata" | "local" | "examples" | "explicit";

export type LoadedPack = {
  manifest: PackManifest;
  profile: PackProfile;
  controls: PackControls;
  actions: PackActions;
  workflows: { workflows: PackWorkflow[] };
  // Absolute directory of the pack (never surfaced to MCP clients verbatim;
  // app_pack_list returns source labels only).
  dir: string;
  source: string;
  sourceKind: PackSourceKind;
  loadedAtMs: number;
  errors: string[];
};

export type PackSnapshot = {
  manifestVersion: string;
  controlsVersion: number;
  workflowsVersion: number;
  packVersion: string;
};
