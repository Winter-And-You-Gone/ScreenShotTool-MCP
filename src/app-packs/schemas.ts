// Zod schemas for App Pack JSON files (manifest/profile/controls/actions/
// workflows). These are the authoritative runtime validators used by the
// loader and validator; the public JSON Schema files under app-packs/schemas/
// mirror them for tooling outside this server.

import { z } from "zod";

import { hasLocator, normalizeControlType, validateRegex } from "../uia/selectors.js";

const packIdPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const nonEmptyStr = z.string().min(1).max(256);
const optionalTimeout = z.number().int().min(100).max(300_000);
const optionalPoll = z.number().int().min(50).max(10_000);

// Shared selector schema (same locator semantics as ui_element_selector).
export const packSelectorSchema: z.ZodType<import("../uia/types.js").UiElementSelector> = z.object({
  automationId: z.string().min(1).max(256).optional(),
  name: z.string().min(1).max(256).optional(),
  controlType: z.string().min(1).max(256).optional(),
  className: z.string().min(1).max(256).optional(),
  frameworkId: z.string().min(1).max(256).optional(),
  match: z.enum(["exact", "contains", "regex"]).optional(),
  caseSensitive: z.boolean().optional(),
  index: z.number().int().min(0).optional(),
  visibleOnly: z.boolean().optional(),
  enabledOnly: z.boolean().optional(),
  ancestor: z.lazy(() => packSelectorSchema).optional(),
  path: z.array(z.lazy(() => packSelectorSchema)).max(12).optional()
}).strict().refine(
  (value) => hasLocator(value),
  "Selector must provide at least one locator field (automationId, name, controlType, className, frameworkId, ancestor, or path)."
).refine(
  (value) => {
    if (value.match === "regex") {
      const candidate = value.automationId ?? value.name ?? value.className ?? "";
      if (candidate.length === 0) return true;
      return validateRegex(candidate) === null;
    }
    return true;
  },
  "Invalid regex in selector."
).refine(
  (value) => {
    if (value.controlType !== undefined) {
      const normalized = normalizeControlType(value.controlType);
      if (!normalized) return false;
      (value as { controlType?: string }).controlType = normalized;
    }
    return true;
  },
  "Invalid controlType."
);

export const packManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(packIdPattern, "id must match ^[a-z][a-z0-9._-]{0,63}$"),
  displayName: nonEmptyStr,
  version: nonEmptyStr,
  description: z.string().max(1024).optional(),
  profileFile: nonEmptyStr.optional(),
  controlsFile: nonEmptyStr.optional(),
  actionsFile: nonEmptyStr.optional(),
  workflowsFile: nonEmptyStr.optional(),
  catalogVisibility: z.enum(["session", "hidden", "internal"]).optional().default("session"),
  enabled: z.boolean().optional().default(true)
}).strict().refine(
  (value) => value.enabled !== false,
  "enabled:false packs are not loaded"
);

export const packProfileSchema = z.object({
  id: z.string().regex(packIdPattern, "id must match ^[a-z][a-z0-9._-]{0,63}$"),
  displayName: z.string().max(256).optional(),
  executableNames: z.array(nonEmptyStr).min(1).max(16),
  executableEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "executableEnv must be an environment variable name").optional(),
  mainWindow: z.object({
    title: nonEmptyStr.optional(),
    titleMatch: z.enum(["exact", "contains", "regex"]).optional(),
    frameworkId: nonEmptyStr.optional(),
    className: nonEmptyStr.optional()
  }).strict().optional(),
  titleContains: z.array(nonEmptyStr).max(8).optional(),
  processNames: z.array(nonEmptyStr).max(16).optional(),
  launch: z.object({
    reuseIfRunning: z.boolean().optional().default(true),
    waitForWindow: z.boolean().optional().default(true),
    timeoutMs: optionalTimeout.optional().default(30000),
    noActivate: z.boolean().optional().default(true)
  }).strict().optional(),
  security: z.object({
    requiresAsInvoker: z.boolean().optional().default(false)
  }).strict().optional(),
  submenuAidPatterns: z.array(nonEmptyStr).max(16).optional()
}).strict().refine(
  (value) => {
    if (value.executableEnv && !process.env[value.executableEnv] && value.executableNames.length === 0) {
      return false;
    }
    return true;
  },
  "profile must resolve an executable (executableNames or executableEnv)"
);

export const packControlsSchema = z.object({
  controls: z.record(
    nonEmptyStr,
    z.union([
      packSelectorSchema,
      z.array(packSelectorSchema).min(1).max(8),
      z.object({
        selectors: z.array(packSelectorSchema).min(1).max(8),
        confidence: z.enum(["stable", "conditionally-stable", "fragile", "source-derived", "runtime-verified", "unsupported", "action-limited", "ambiguous"]).optional().default("source-derived"),
        description: z.string().max(1024).optional(),
        notes: z.string().max(4096).optional(),
        selectionGroup: nonEmptyStr.optional(),
        menu: z.object({
          opensSubmenu: z.boolean().optional(),
          command: z.boolean().optional(),
          invokeMode: z.enum(["pattern", "keyboard-enter"]).optional(),
          panelControl: nonEmptyStr.optional(),
          sectionControl: nonEmptyStr.optional()
        }).strict().optional()
      }).strict()
    ])
  ).refine((v) => Object.keys(v).length <= 1000, "controls.json may define at most 1000 controls")
}).strict();

export const packExpectSchema = z.object({
  profileControl: nonEmptyStr.optional(),
  selector: packSelectorSchema.optional(),
  condition: z.enum([
    "exists", "notExists", "visible", "hidden", "enabled", "disabled",
    "valueEquals", "valueContains", "toggleStateEquals", "selected",
    "notSelected", "expanded", "collapsed", "countEquals"
  ]),
  timeoutMs: optionalTimeout.optional().default(5000),
  pollIntervalMs: optionalPoll.optional().default(150),
  expectedValue: z.string().max(4000).optional(),
  toggleState: z.enum(["On", "Off", "Indeterminate"]).optional(),
  expectedCount: z.number().int().min(0).max(100).optional()
}).strict().refine(
  (value) => value.profileControl !== undefined || value.selector !== undefined,
  "defaultExpect requires profileControl or selector"
).refine(
  (value) => !(["valueEquals", "valueContains"].includes(value.condition)) || value.expectedValue !== undefined,
  "valueEquals/valueContains require expectedValue"
).refine(
  (value) => value.condition !== "toggleStateEquals" || value.toggleState !== undefined,
  "toggleStateEquals requires toggleState"
).refine(
  (value) => value.condition !== "countEquals" || value.expectedCount !== undefined,
  "countEquals requires expectedCount"
);

export const packActionsSchema = z.object({
  contracts: z.array(z.object({
    control: nonEmptyStr,
    action: nonEmptyStr,
    idempotent: z.boolean().optional().default(false),
    retrySafe: z.boolean().optional().default(false),
    destructive: z.boolean().optional().default(false),
    requiresConfirmation: z.boolean().optional().default(false),
    defaultExpect: z.union([packExpectSchema, z.literal(false)]).optional(),
    preferredMethod: nonEmptyStr.optional(),
    fallbackPolicy: z.enum(["default", "disabled"]).optional().default("default"),
    maxAttempts: z.number().int().min(1).max(5).optional(),
    selectionGroup: nonEmptyStr.optional()
  }).strict()).max(2000)
}).strict();

const workflowStepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "step id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$").optional(),
  tool: nonEmptyStr,
  args: z.record(z.string(), z.unknown()).optional().default({}),
  exports: z.record(nonEmptyStr, nonEmptyStr).refine((v) => Object.keys(v).length <= 32, "at most 32 exports per step").optional(),
  expect: z.union([packExpectSchema, z.literal(false)]).optional(),
  retry: z.object({
    maxAttempts: z.number().int().min(1).max(5).optional().default(3),
    delayMs: z.number().int().min(0).max(60_000).optional().default(200),
    backoffMultiplier: z.number().min(1).max(10).optional().default(1.5),
    onlyCodes: z.array(nonEmptyStr).max(16).optional()
  }).strict().optional(),
  captureBefore: z.object({
    saveAs: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    read: z.object({
      tool: nonEmptyStr.optional().default("ui_get"),
      args: z.record(z.string(), z.unknown()).optional().default({})
    }).strict().optional()
  }).strict().optional(),
  ignoreCodes: z.array(nonEmptyStr).max(16).optional()
}).strict();

const inputSchemaProperties = z.record(
  nonEmptyStr,
  z.record(z.string(), z.unknown())
);

export const packWorkflowsSchema = z.object({
  workflows: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/, "workflow id must match ^[a-z][a-z0-9_-]{0,63}$"),
    description: z.string().max(1024).optional(),
    safe: z.boolean().optional().default(false),
    tested: z.boolean().optional().default(false),
    restoresState: z.boolean().optional().default(false),
    visibility: z.enum(["session", "hidden", "internal"]).optional().default("session"),
    inputSchema: z.object({
      type: z.literal("object").optional().default("object"),
      properties: inputSchemaProperties.optional().default({}),
      required: z.array(nonEmptyStr).max(32).optional().default([]),
      additionalProperties: z.boolean().optional().default(false)
    }).strict().optional(),
    steps: z.array(workflowStepSchema).min(1).max(50),
    finally: z.array(workflowStepSchema).max(20).optional(),
    captureBefore: z.array(z.object({
      saveAs: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
      read: z.object({
        tool: nonEmptyStr.optional().default("ui_get"),
        args: z.record(z.string(), z.unknown()).optional().default({})
      }).strict().optional()
    }).strict()).max(32).optional(),
    restore: z.enum(["always", "never", "onFailure"]).optional().default("never")
  }).strict()).max(200)
}).strict();
