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
  pagesFile?: string;
  componentsFile?: string;
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

// Declared per-control search scope for UIA queries. These are LOCAL bounds -
// the core never raises global query limits because one deep control needs a
// deeper walk. rootControl resolves to the logical control's first selector.
export type PackSearchScope = {
  rootControl?: string;
  maxDepth?: number;
  depthStrategy?: "fixed" | "auto";
  maxResults?: number;
};

// Declared scroll relationship for deep controls. The generic ensureVisible
// composite resolves the control, tries ScrollItemPattern first, then drives
// the declared scrollContainer (RangeValue pattern or window-message wheel),
// then re-resolves the control and verifies it is fully visible.
export type PackVisibility = {
  scrollContainer?: string;
  strategies?: Array<"ScrollItemPattern" | "RangeValueScroll" | "WindowMessageWheel">;
  margin?: number;
};

// Business-state postcondition reference. Unlike a raw selector, the control
// is ALWAYS a logical pack control so the core can resolve it through the
// profile and cross-validate it at pack load time.
export type PackBusinessPostcondition = PackDefaultExpect & { profileControl: string };

// Combined control-state requirement for selection-style actions. `any` /
// `all` accept the same conditions as PackExpectCondition (selected,
// toggleStateEquals, ...). controlState is about the CONTROL itself;
// postconditions prove the business content switched.
export type PackControlStateRequirement = {
  any?: PackDefaultExpect[];
  all?: PackDefaultExpect[];
};

// Fallback methods a pack may declare. Sourced from the shared runtime enum
// (src/app-packs/enums.ts) so the schema, validator and executor stay in
// lockstep - only methods with a real executor mapping belong here.
import type { FallbackMethod } from "./enums.js";

export type PackFallbackMethod = FallbackMethod;

export type PackFallbackPolicy = {
  enabled?: boolean;
  methods?: PackFallbackMethod[];
  forbidden?: Array<"PhysicalMouse" | "GlobalKeyboard" | string>;
};

export type PackControlRole =
  | "pageRoot"
  | "navigation"
  | "card"
  | "tab"
  | "toggle"
  | "button"
  | "input"
  | "combo"
  | "switch"
  | "slider"
  | "table"
  | "tree"
  | "scrollArea"
  | "statusMarker"
  | "contentMarker"
  | "container"
  | "other";

export type PackControlEntry = {
  selectors: UiElementSelector[];
  // Confidence labels accepted in pack files ("stable"/"conditionally-stable"/
  // "fragile" are catalog-style labels mapped to core labels by the adapter).
  confidence?: SelectorConfidence | "stable" | "conditionally-stable" | "fragile";
  description?: string;
  notes?: string;
  // Semantic map metadata (general - never app-specific). See pages.json /
  // components.json for the page/component/group graph.
  aliases?: string[];
  page?: string;
  parent?: string;
  // Semantic selection group id (declared in pages.json selectionGroups).
  group?: string;
  role?: PackControlRole;
  // Local search bounds for this control (see PackSearchScope).
  search?: PackSearchScope;
  // Scroll relationship for the generic ensureVisible composite.
  visibility?: PackVisibility;
  // Control-state requirement (selected/toggleState...) used by
  // ensureSelected IN ADDITION to the business postconditions below.
  controlState?: PackControlStateRequirement;
  // Business postconditions proving content switched. AND-combined
  // (any/all semantics inside each entry); evaluated by ensureSelected
  // together with controlState - UIA toggleState alone never proves content.
  postconditions?: PackBusinessPostcondition[];
  // Actions this control really supports (informational + validation).
  supportedActions?: string[];
  // Fallback chain for pattern failures. forbidden methods are validated at
  // load time; PhysicalMouse/GlobalKeyboard may never be enabled by a pack.
  fallbackPolicy?: PackFallbackPolicy;
  // Page-navigation group: controls in the same group are mutually exclusive
  // pages (e.g. sidebar nav). Used by state capture/restore to find the
  // ACTUALLY selected page before a navigation action. (Legacy - prefer the
  // semantic `group` declared in pages.json; conflicts are validation errors.)
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

// 4.3b pages.json -----------------------------------------------------------

// A top-level page of the application: how to reach it, its root container,
// content-level ready markers (page content visibility, NOT just a nav
// toggle's selected state), scroll containers and its components.
export type PackPage = {
  id: string;
  displayName?: string;
  aliases?: string[];
  // Navigation control (sidebar / nav button) that switches to this page.
  navigationControl?: string;
  // Root container of the page content.
  rootControl?: string;
  // Content-level readiness markers: at least one must be satisfiable for
  // the page to count as ready (verified by postcondition conditions).
  readyMarkers?: PackBusinessPostcondition[];
  scrollContainers?: string[];
  components?: string[];
};

// A mutually-exclusive selection group (channels, tabs, modes). The core
// never hardcodes which member is "the" current one - the model picks the
// member it wants; the group only proves the members are alternatives.
export type PackSelectionGroup = {
  id: string;
  role?: string;
  parent?: string;
  members: string[];
  selectionMode?: "single" | "multi";
};

export type PackPages = {
  pages: PackPage[];
  selectionGroups?: PackSelectionGroup[];
};

// 4.3c components.json ------------------------------------------------------

// A visible card / region / component on a page, with its child controls.
// Components map to real UI structure - NOT to natural-language tasks.
export type PackComponent = {
  id: string;
  displayName?: string;
  aliases?: string[];
  page?: string;
  role?: string;
  rootControl?: string;
  children?: string[];
  // Third-priority mapping status for complex or low-frequency internals.
  mappingStatus?: "full" | "partial";
  reason?: string;
};

export type PackComponents = {
  components: PackComponent[];
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
  pages?: PackPages;
  components?: PackComponents;
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
