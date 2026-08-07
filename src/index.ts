#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type * as SchemasModule from "./schemas.js";
import type * as WindowsModule from "./windows.js";
import type * as ProfilesModule from "./profiles/registry.js";
import type { ProfileRunStepsInput } from "./schemas.js";
import type { UiaDeps } from "./profiles/registry.js";
import { McpUiError, suggestionFor } from "./uia/results.js";
import { estimateJsonBytes, MAX_STEP_RESULT_BYTES } from "./outputs.js";
import {
  autoResolveTarget,
  bindLaunchTarget,
  getTarget,
  rebindTargetByRules,
  recordTargetOperation,
  resolveTargetRef,
  type TargetBinding,
  type TargetOperationRecord
} from "./targets.js";
import { getContract, contracts, toMcpToolDefinition } from "./contracts.js";
import { executeValidatedTool, type ToolExecutorContext } from "./executor.js";
import { registry as packRegistry, getAppProfile } from "./app-packs/registry.js";
import { loadPackFromDir } from "./app-packs/loader.js";
import { validatePack } from "./app-packs/validator.js";
import { listWorkflows, getWorkflow, runWorkflow } from "./app-packs/workflows.js";
import { probeApp } from "./app-packs/probe.js";
import {
  runPipeline,
  continuePipeline,
  validatePipelineStatic,
  type ExecutionContext
} from "./pipeline.js";
import {
  backgroundUnsafePipelineSteps,
  pipelineNotBackgroundSafeError,
  resolveContinuationInteraction,
  resolveInteractionMode,
  type InteractionMode
} from "./interaction.js";
import { validateReferences } from "./piping.js";
import { getRun, runTtlRemainingMs } from "./runs.js";

type RuntimeModules = {
  version: string;
  schemas: typeof SchemasModule;
  windows: typeof WindowsModule;
  profiles: typeof ProfilesModule;
};

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = ["dist", "src"].includes(path.basename(moduleRoot)) ? path.dirname(moduleRoot) : moduleRoot;
const hotReloadEnabled = process.env.SCREENSHOTTOOL_HOT_RELOAD !== "0";
let runtimeCache: RuntimeModules | null = null;

// Single source of truth for the server version: read from package.json once
// at startup so it can't drift from the npm package version.
const packageVersion = readPackageVersion();

function readPackageVersion(): string {
  const packageJsonPath = path.join(runtimeRoot, "package.json");
  try {
    const content = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── CLI args ──
//   --app-pack-dir <dir>   load App Packs from this directory (highest priority)

function parseCliArgs(): { appPackDir?: string } {
  const argv = process.argv.slice(2);
  let appPackDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--app-pack-dir" && i + 1 < argv.length) {
      appPackDir = argv[i + 1];
    } else if (arg.startsWith("--app-pack-dir=")) {
      appPackDir = arg.slice("--app-pack-dir=".length);
    }
  }
  return { appPackDir };
}

function envPackDirs(): string[] | undefined {
  const raw = process.env.SCREENSHOT_MCP_APP_PACK_DIRS;
  if (!raw) return undefined;
  return raw.split(path.delimiter).map((d) => d.trim()).filter((d) => d.length > 0);
}

const cliArgs = parseCliArgs();

const server = new Server(
  {
    name: "screenshottool-mcp",
    version: packageVersion
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Tools are registered from the contract table (src/contracts.ts). Each entry
// carries the MCP-standard inputSchema + outputSchema + annotations (+ _meta
// with pipeSafeFields), so a first-time client can derive contracts from
// tools/list alone.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(contracts).map((c) => toMcpToolDefinition(c))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const runtime = await loadRuntime();
    const uiaDeps = runtime.profiles.buildUiaDeps(runtime.windows);

    // EVERY tool call - including the pipeline-orchestration tools - goes
    // through executeValidatedTool: read contract -> validate input ->
    // dispatch -> validate output. There is exactly one execution path, so
    // plain calls and pipeline steps behave identically.
    const executor = makeExecutor(runtime, uiaDeps);
    return jsonResult(await executeValidatedTool(name, args, executor));
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof McpUiError) {
      // Structured errors: isError + text content (legacy clients) +
      // structuredContent (machine-readable { success, error: { code,
      // message, details, suggestion?, retryable? } }). Every tool's public
      // outputSchema accepts this shape (withToolError in contracts.ts), so a
      // business error can NEVER surface as an outputSchema mismatch.
      const retryable = error.code === "WINDOW_NOT_FOUND_FOR_PROCESS"
        || error.code === "STALE_WINDOW_HANDLE"
        || error.code === "ELEMENT_NOT_AVAILABLE"
        || error.code === "UIA_ROOT_UNAVAILABLE"
        || error.code === "TARGET_WINDOW_NOT_READY"
        || error.code === "POPUP_NOT_READY"
        || error.code === "PROVIDER_BUSY"
        || error.code === "TIMEOUT";
      const suggestion = suggestionFor(error.code, error.suggestion);
      const structured = {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          ...(suggestion !== undefined ? { suggestion } : {}),
          ...(retryable !== undefined ? { retryable } : {})
        }
      };
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(structured, null, 2)
          }
        ],
        structuredContent: structured
      };
    }
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: formatError(error)
        }
      ]
    };
  }
});

// ── App Pack tools ──

function packSummary(packId: string) {
  const pack = packRegistry.getPack(packId);
  if (!pack) return undefined;
  const v = validatePack(pack);
  return {
    id: pack.manifest.id,
    displayName: pack.manifest.displayName,
    version: pack.manifest.version,
    source: pack.source,
    catalogVisibility: pack.manifest.catalogVisibility ?? "session",
    controls: Object.keys(pack.controls.controls).length,
    workflows: pack.workflows.workflows.length,
    valid: v.errors.length === 0,
    ...((pack.manifest.catalogVisibility ?? "session") === "hidden" ? { hidden: true } : {}),
    ...(pack.errors.length > 0 ? { error: pack.errors.join("; ") } : {})
  };
}

async function appPackListTool(_args: unknown, _runtime: RuntimeModules) {
  const packs = packRegistry
    .listPacks("session")
    .map((p) => packSummary(p.manifest.id))
    .filter((p) => p !== undefined);
  return { packs };
}

async function resolveSemanticControlTool(args: unknown, _runtime: RuntimeModules) {
  const input = args as import("./schemas.js").ResolveSemanticControlInput;
  const { resolveSemanticControl } = await import("./app-packs/semantics.js");
  return resolveSemanticControl(input);
}

async function appPackDescribeTool(args: unknown, runtime: RuntimeModules) {
  const input = args as import("./schemas.js").AppPackDescribeInput;
  const pack = packRegistry.getPack(input.pack);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack, loaded: packRegistry.listPacks("all").map((p) => p.manifest.id) });
  }
  const profile = getAppProfile(pack.manifest.id)!;
  const p = pack; // stable non-undefined reference for narrowing across awaits

  const include = input.include ?? ["pages", "components", "relationships"];
  const compact = input.compact === true;

  const controls = Object.entries(pack.controls.controls).map(([name, raw]) => {
    const selectors = Array.isArray(raw) ? raw
      : "selectors" in raw && Array.isArray((raw as { selectors?: unknown[] }).selectors)
        ? (raw as { selectors: unknown[] }).selectors
        : [raw];
    const entry = raw as { confidence?: string; description?: string; notes?: string; menu?: unknown; page?: string; group?: string; role?: string };
    return {
      name,
      selectorCount: selectors.length,
      confidence: entry.confidence ?? "source-derived",
      description: entry.description ?? entry.notes ?? "",
      ...(entry.page ? { page: entry.page } : {}),
      ...(entry.group ? { group: entry.group } : {}),
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.menu ? { menu: entry.menu } : {})
    };
  });

  const actions = pack.actions.contracts.map((c) => ({
    control: c.control,
    action: c.action,
    idempotent: c.idempotent,
    retrySafe: c.retrySafe,
    destructive: c.destructive,
    ...(c.defaultExpect ? { defaultExpect: c.defaultExpect } : {}),
    ...(c.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(c.backgroundPolicy ? { backgroundPolicy: c.backgroundPolicy } : {})
  }));

  const workflows = listWorkflows(pack);

  // Known limitations: controls declared unsupported.
  const limitations: string[] = [];
  for (const [name, raw] of Object.entries(pack.controls.controls)) {
    const confidence = typeof raw === "object" && !Array.isArray(raw) && "confidence" in (raw as object)
      ? (raw as { confidence?: string }).confidence
      : undefined;
    if (confidence === "unsupported") {
      limitations.push(`Control '${name}' is marked unsupported (cannot be operated via UIA in the current build).`);
    }
  }
  if (pack.errors.length > 0) limitations.push(...pack.errors);

  return {
    pack: pack.manifest.id,
    displayName: pack.manifest.displayName,
    version: pack.manifest.version,
    source: pack.source,
    profile: {
      executableNames: pack.profile.executableNames,
      executableEnv: pack.profile.executableEnv,
      mainWindow: pack.profile.mainWindow,
      launch: pack.profile.launch,
      security: pack.profile.security,
      interaction: pack.profile.interaction
    },
    controls,
    actions,
    workflows,
    limitations,
    pipeSafe: {
      profile_launch: ["pid", "hwnd", "title", "interaction"],
      profile_action: ["result", "selectorUsed", "interaction"],
      ui_wait: ["matched", "timedOut"]
    },
    defaultInteractionMode: pack.profile.interaction?.defaultMode ?? "auto",
    // Generic model usage guidance - NEVER app-specific (no control names).
    // Returned by every pack so first-time clients pick the right tool, bind
    // the right target, and avoid anti-patterns.
    usageGuidance: {
      preferredLaunchTool: "profile_launch",
      preferredTargetBinding: "targetRef",
      recommendedOrder: [
        "profile_launch",
        "resolve_semantic_control (for natural-language composite targets)",
        "profile_action (following the suggestedPath; use ensureSelected for selection-group controls)",
        "scoped ui_query",
        "ui_catalog",
        "ui_inspect_tree"
      ],
      antiPatterns: [
        "Do not use launch_app when this pack is available.",
        "Do not enumerate the full UI tree before trying profile controls.",
        "Do not manually convert screen coordinates to window coordinates.",
        "Do not infer a process crash only because no window is currently found.",
        "Do not reuse an old hwnd after the window was recreated; pass the targetRef.",
        "Do not guess a control id for a natural-language goal - run resolve_semantic_control first and follow its suggestedPath.",
        "Do not invoke a selection-group control with raw invoke when ensureSelected is the recommended action."
      ]
    }
  };

  // Semantic map (pages/components/selectionGroups/relationships) when the
  // pack declares pages.json/components.json and the caller asks for them.
  if (p.pages || p.components) {
    const { describeSemanticMap } = await import("./app-packs/semantics.js");
    const map = describeSemanticMap(p, include, input.page, compact);
    const out = {
      pack: p.manifest.id,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      source: p.source,
      profile: {
        executableNames: p.profile.executableNames,
        executableEnv: p.profile.executableEnv,
        mainWindow: p.profile.mainWindow,
        launch: p.profile.launch,
        security: p.profile.security,
        interaction: p.profile.interaction
      },
      controls,
      actions,
      workflows,
      limitations,
      pipeSafe: {
        profile_launch: ["pid", "hwnd", "title", "interaction"],
        profile_action: ["result", "selectorUsed", "interaction"],
        ui_wait: ["matched", "timedOut"]
      },
      defaultInteractionMode: p.profile.interaction?.defaultMode ?? "auto",
      usageGuidance: {
        preferredLaunchTool: "profile_launch",
        preferredTargetBinding: "targetRef",
        recommendedOrder: [
          "profile_launch",
          "resolve_semantic_control (for natural-language composite targets)",
          "profile_action (following the suggestedPath; use ensureSelected for selection-group controls)",
          "scoped ui_query",
          "ui_catalog",
          "ui_inspect_tree"
        ],
        antiPatterns: [
          "Do not use launch_app when this pack is available.",
          "Do not enumerate the full UI tree before trying profile controls.",
          "Do not manually convert screen coordinates to window coordinates.",
          "Do not infer a process crash only because no window is currently found.",
          "Do not reuse an old hwnd after the window was recreated; pass the targetRef.",
          "Do not guess a control id for a natural-language goal - run resolve_semantic_control first and follow its suggestedPath.",
          "Do not invoke a selection-group control with raw invoke when ensureSelected is the recommended action."
        ]
      }
    };
    return {
      ...out,
      ...(include.includes("pages") ? { pages: map.pages } : {}),
      ...(include.includes("pages") ? { selectionGroups: map.selectionGroups } : {}),
      ...(include.includes("components") ? { components: map.components } : {}),
      ...(include.includes("relationships") || include.includes("controls") ? { relationships: map.relationships } : {})
    };
  }
  return {
    pack: p.manifest.id,
    displayName: p.manifest.displayName,
    version: p.manifest.version,
    source: p.source,
    profile: {
      executableNames: p.profile.executableNames,
      executableEnv: p.profile.executableEnv,
      mainWindow: p.profile.mainWindow,
      launch: p.profile.launch,
      security: p.profile.security,
      interaction: p.profile.interaction
    },
    controls,
    actions,
    workflows,
    limitations,
    pipeSafe: {
      profile_launch: ["pid", "hwnd", "title", "interaction"],
      profile_action: ["result", "selectorUsed", "interaction"],
      ui_wait: ["matched", "timedOut"]
    },
    defaultInteractionMode: p.profile.interaction?.defaultMode ?? "auto",
    // Generic model usage guidance - NEVER app-specific (no control names).
    // Returned by every pack so first-time clients pick the right tool, bind
    // the right target, and avoid anti-patterns.
    usageGuidance: {
      preferredLaunchTool: "profile_launch",
      preferredTargetBinding: "targetRef",
      recommendedOrder: [
        "profile_launch",
        "resolve_semantic_control (for natural-language composite targets)",
        "profile_action (following the suggestedPath; use ensureSelected for selection-group controls)",
        "scoped ui_query",
        "ui_catalog",
        "ui_inspect_tree"
      ],
      antiPatterns: [
        "Do not use launch_app when this pack is available.",
        "Do not enumerate the full UI tree before trying profile controls.",
        "Do not manually convert screen coordinates to window coordinates.",
        "Do not infer a process crash only because no window is currently found.",
        "Do not reuse an old hwnd after the window was recreated; pass the targetRef.",
        "Do not guess a control id for a natural-language goal - run resolve_semantic_control first and follow its suggestedPath.",
        "Do not invoke a selection-group control with raw invoke when ensureSelected is the recommended action."
      ]
    }
  };
}

async function appPackValidateTool(args: unknown, runtime: RuntimeModules) {
  const input = args as import("./schemas.js").AppPackValidateInput;
  if (input.packPath) {
    // Local validation: load the single pack directory without installing it.
    const loaded = await loadPackFromDir(input.packPath);
    if (!loaded) {
      throw new McpUiError("PACK_NOT_FOUND", `Directory '${input.packPath}' is not a loadable App Pack (missing or invalid manifest.json).`, { packPath: input.packPath });
    }
    const v = validatePack(loaded);
    return { pack: loaded.manifest.id, valid: v.valid, errors: v.errors, warnings: v.warnings, checked: v.checked };
  }
  const pack = packRegistry.getPack(input.pack!);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack });
  }
  const v = validatePack(pack);
  return { pack: pack.manifest.id, valid: v.valid, errors: v.errors, warnings: v.warnings, checked: v.checked };
}

async function appPackReloadTool(_args: unknown, _runtime: RuntimeModules) {
  const result = await packRegistry.load(cliArgs.appPackDir, envPackDirs());
  // Reflect the registry's ACTUAL outcome: a reload whose new config fails
  // validation keeps the previous packs and reports reloaded:false.
  return {
    reloaded: result.reloaded,
    loadedPacks: result.loadedPacks.map((p) => packSummary(p.manifest.id)).filter((p) => p !== undefined),
    errors: result.issues
  };
}

async function appPackProbeTool(args: unknown, runtime: RuntimeModules) {
  const input = args as import("./schemas.js").AppPackProbeInput;
  return probeApp(
    {
      listWindows: (f) => runtime.windows.listWindows(f),
      catalogUi: (c) => runtime.windows.catalogUi(c),
      inspectUiTree: (c) => runtime.windows.inspectUiTree(c as never)
    },
    input
  );
}

// ── Tool contract discovery tools ──

async function toolContractListTool(_args: unknown, _runtime: RuntimeModules) {
  const tools = Object.values(contracts).map((c) => ({
    name: c.name,
    schemaVersion: c.schemaVersion,
    outputSchema: c.outputSchema,
    pipeSafeFields: c.pipeSafeFields,
    annotations: {
      readOnly: c.annotations?.readOnly ?? false,
      destructive: c.annotations?.destructive ?? false,
      idempotent: c.annotations?.idempotent ?? false,
      retrySafe: c.annotations?.retrySafe ?? false,
      needsExpect: c.annotations?.needsExpect ?? false
    }
  }));
  return { tools };
}

async function toolContractDescribeTool(args: unknown, _runtime: RuntimeModules) {
  const input = args as import("./schemas.js").ToolContractDescribeInput;
  const contract = getContract(input.tool);
  if (!contract) {
    throw new McpUiError("TOOL_NOT_FOUND", `No tool named '${input.tool}'.`, { tool: input.tool, tools: Object.keys(contracts) });
  }
  const { contractExamples } = await import("./contracts.js");
  return {
    name: contract.name,
    schemaVersion: contract.schemaVersion,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    pipeSafeFields: contract.pipeSafeFields,
    annotations: {
      readOnly: contract.annotations?.readOnly ?? false,
      destructive: contract.annotations?.destructive ?? false,
      idempotent: contract.annotations?.idempotent ?? false,
      retrySafe: contract.annotations?.retrySafe ?? false,
      needsExpect: contract.annotations?.needsExpect ?? false
    },
    examples: contractExamples(contract)
  };
}

// ── Pipeline tools ──

function packContext(packId: string): { id: string; actions: import("./app-packs/types.js").PackActions; profile: import("./profiles/types.js").AppProfile; version: string } {
  const pack = packRegistry.getPack(packId);
  const profile = getAppProfile(packId);
  if (!pack || !profile) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${packId}' is loaded.`, { pack: packId });
  }
  return { id: pack.manifest.id, actions: pack.actions, profile, version: pack.manifest.version };
}

// The SINGLE pipeline ExecutionContext factory. Every high-level entry
// (run_steps / profile_run_steps / run_workflow / continue_run / internal
// workflow execution) builds its context through this function - no entry
// hand-assembles the object literal. Unified pieces: dispatch (through the
// unified executor), contract table, profile registry, App Pack registry,
// foreground reads, interaction context, run store, and clock/deadline.
export type PipelineContextOptions = {
  runtime: RuntimeModules;
  uiaDeps: UiaDeps;
  packId?: string;
  // Resolved interaction mode (explicit > workflow > pack default > auto).
  interactionMode?: InteractionMode;
  interaction?: ExecutionContext["interaction"];
  // Window/process context auto-injected into steps (profile_run_steps).
  autoContext?: ExecutionContext["autoContext"];
  // Workflow inputs (${inputs.x}).
  inputs?: Record<string, unknown>;
};

export function createPipelineExecutionContext(options: PipelineContextOptions): ExecutionContext {
  const { runtime, uiaDeps, packId } = options;
  const executor = makeExecutor(runtime, uiaDeps);
  return {
    dispatch: (tool, toolArgs) => executeValidatedTool(tool, toolArgs, executor),
    pack: packId ? packContext(packId) : undefined,
    // Lets page/selection capture resolve a profile for pack-less
    // run_steps pipelines that carry {profile} in their step args.
    resolveProfile: (id) => getAppProfile(id),
    resolvePackActions: (id) => packRegistry.getPack(id)?.actions,
    // foregroundDemo cleanup: restore the previous foreground window when the
    // pipeline finishes.
    restoreForeground: (hwnd) => runtime.windows.restoreForegroundWindow(hwnd),
    // Real foreground reads for the pipeline-level interaction report.
    getForeground: () => runtime.windows.getForegroundWindowHwnd(),
    expectDeps: {
      getUiElement: (i) => uiaDeps.getUiElement(i),
      queryUi: (i) => uiaDeps.queryUi(i)
    },
    interactionMode: options.interactionMode,
    ...(options.interaction ? { interaction: options.interaction } : {}),
    ...(options.autoContext ? { autoContext: options.autoContext } : {}),
    ...(options.inputs ? { inputs: options.inputs } : {})
  };
}

// The one place where input parsing + raw dispatch live. executeValidatedTool
// wraps this with output validation.
function makeExecutor(runtime: RuntimeModules, uiaDeps: UiaDeps): ToolExecutorContext {
  return {
    parseInput: (tool, args) => {
      const schema = runtime.schemas.toolZodSchemas[tool];
      if (!schema) return { ok: true, value: args };
      const parsed = schema.safeParse(args ?? {});
      if (parsed.success) return { ok: true, value: parsed.data };
      return { ok: false, message: z.prettifyError(parsed.error) };
    },
    dispatch: (tool, input) => dispatchToolValue(tool, input, runtime, uiaDeps)
  };
}

async function runStepsTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = args as import("./schemas.js").RunStepsInput;
  // Backward-compatible structural pre-check: invalid placeholder references
  // (forward/unknown step ids) fail the whole call with InvalidParams before
  // any step runs, exactly like the pre-pipeline run_steps.
  const refCheck = validateReferences(input.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args ?? {} })));
  if (!refCheck.ok) {
    throw new McpError(ErrorCode.InvalidParams, refCheck.message);
  }
  // run_steps has no pack context of its own: the mode comes from the caller,
  // or from the pack default of the profile(s) its steps reference (profile
  // actions inside the pipeline resolve the same default individually, so the
  // pipeline-level preflight must match). Otherwise auto.
  const mode: InteractionMode = input.interactionMode ?? stepsPackDefault(input.steps) ?? "auto";
  const result = await runPipeline(input, createPipelineExecutionContext({
    runtime,
    uiaDeps,
    interactionMode: mode,
    ...(input.foregroundDemo ? { interaction: input.foregroundDemo } : {})
  }));
  return withRunTtl(result);
}

// First non-auto interaction default declared by the packs whose profile ids
// appear as literal step args (steps referencing a profiled app inherit its
// interaction policy at the pipeline level).
function stepsPackDefault(steps: Array<{ args?: Record<string, unknown> }>): InteractionMode | undefined {
  for (const step of steps) {
    const profileId = step.args?.profile;
    if (typeof profileId === "string" && !profileId.startsWith("${")) {
      const pack = packRegistry.getPack(profileId);
      const packDefault = pack?.profile.interaction?.defaultMode;
      if (packDefault && packDefault !== "auto") return packDefault;
    }
  }
  return undefined;
}

async function profileRunStepsTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = args as import("./schemas.js").ProfileRunStepsInput;
  const pack = packRegistry.getPack(input.profile);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.profile}' is loaded.`, { pack: input.profile, loaded: packRegistry.listPacks("all").map((p) => p.manifest.id) });
  }
  const profile = getAppProfile(input.profile)!;

  // Interaction mode: explicit > pack default > auto. Background preflights
  // the steps BEFORE launching (no launch side effects for a refused run);
  // foregroundDemo activates the window at launch and restores the previous
  // foreground when the pipeline finishes.
  const mode: InteractionMode = resolveInteractionMode({ explicit: input.interactionMode, packDefault: profile.interaction?.defaultMode });
  const foregroundDemo = input.foregroundDemo;
  if (mode === "background") {
    // Preflight on the {control, action} steps AND finally (profile_action
    // shape), before the launch - no launch side effects for a refused run.
    const toPreflight = (s: ProfileRunStepsInput["steps"][number]) => ({
      ...(s.id ? { id: s.id } : {}),
      tool: "profile_action" as const,
      args: { profile: input.profile, control: s.control, action: s.action }
    });
    const unsafe = backgroundUnsafePipelineSteps(
      input.steps.map(toPreflight),
      (input.finally ?? []).map(toPreflight),
      (id) => packRegistry.getPack(id)?.actions,
      pack.actions
    );
    if (unsafe.length > 0) {
      const err = pipelineNotBackgroundSafeError(mode, unsafe);
      throw new McpUiError("PIPELINE_NOT_BACKGROUND_SAFE", err.message, err.details);
    }
  }

  // 1. Launch / attach to the app.
  const launchResult = await runtime.profiles.launchProfile(
    uiaDeps,
    async (i) => runtime.windows.launchApp({
      exePath: i.exePath,
      args: i.args ?? [],
      waitForWindow: i.waitForWindow ?? true,
      noActivate: i.noActivate ?? true,
      startMinimized: i.startMinimized ?? false,
      timeoutMs: i.timeoutMs ?? 30000,
      // profile_run_steps launches the app the pipeline will operate on: it
      // must survive the MCP server (independent by default).
      lifetime: i.lifetime ?? "independent"
    }),
    runtime.windows.listWindows,
    {
      profile: input.profile,
      ...(input.launch?.exePath ? { exePath: input.launch.exePath } : {}),
      ...(input.launch?.args ? { args: input.launch.args } : {}),
      ...(input.launch?.reuseIfRunning !== undefined ? { reuseIfRunning: input.launch.reuseIfRunning } : {}),
      ...(input.launch?.waitForWindow !== undefined ? { waitForWindow: input.launch.waitForWindow } : {}),
      ...(input.launch?.noActivate !== undefined ? { noActivate: input.launch.noActivate } : {}),
      ...(input.launch?.timeoutMs !== undefined ? { timeoutMs: input.launch.timeoutMs } : {}),
      interactionMode: mode,
      foregroundDemo
    },
    runtime.windows.getExeManifestLevel
  );
  const autoContext = { profile: input.profile, pid: launchResult.pid, ...(launchResult.hwnd ? { hwnd: String(launchResult.hwnd) } : {}), ...(launchResult.title ? { title: launchResult.title } : {}) };

  // 2. Convert {control, action} steps into profile_action pipeline steps,
  //    injecting profile/pid/hwnd so the model never repeats them.
  const toStep = (s: ProfileRunStepsInput["steps"][number]): import("./pipeline.js").PipelineStepInput => ({
    id: s.id,
    tool: "profile_action",
    args: {
      profile: input.profile,
      pid: launchResult.pid,
      ...(launchResult.hwnd ? { hwnd: String(launchResult.hwnd) } : {}),
      control: s.control,
      action: s.action,
      ...(s.value !== undefined ? { value: s.value } : {}),
      ...(s.index !== undefined ? { index: s.index } : {}),
      ...(s.rangeValue !== undefined ? { rangeValue: s.rangeValue } : {}),
      ...(s.allowCoordinateFallback !== undefined ? { allowCoordinateFallback: s.allowCoordinateFallback } : {}),
      ...(s.allowMessageClickFallback !== undefined ? { allowMessageClickFallback: s.allowMessageClickFallback } : {}),
      ...(s.forceCoordinateClick !== undefined ? { forceCoordinateClick: s.forceCoordinateClick } : {})
    },
    exports: s.exports,
    expect: s.expect,
    retry: s.retry
  });

  // 3. Run through the pipeline engine with pack context (defaultExpect etc.).
  const result = await runPipeline(
    {
      steps: input.steps.map(toStep),
      finally: input.finally?.map(toStep),
      restore: input.restore,
      captureBefore: input.captureBefore,
      maxTotalMs: input.maxTotalMs
    },
    createPipelineExecutionContext({
      runtime,
      uiaDeps,
      packId: pack.manifest.id,
      interactionMode: mode,
      interaction: {
        ...(foregroundDemo ?? {}),
        ...(launchResult.interaction.foregroundBefore ? { foregroundBefore: launchResult.interaction.foregroundBefore } : {})
      },
      autoContext
    })
  );

  return {
    ...withRunTtl(result),
    profile: input.profile,
    pid: launchResult.pid,
    ...(launchResult.hwnd ? { hwnd: String(launchResult.hwnd) } : {}),
    startedByMcp: launchResult.startedByMcp,
    reused: launchResult.reused
  };
}

async function runWorkflowTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = args as import("./schemas.js").RunWorkflowInput;
  const pack = packRegistry.getPack(input.pack);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack });
  }
  const workflow = getWorkflow(pack, input.workflow);
  if (!workflow) {
    throw new McpUiError("WORKFLOW_NOT_FOUND", `Pack '${input.pack}' has no workflow named '${input.workflow}'.`, { pack: input.pack, workflow: input.workflow, available: pack.workflows.workflows.map((w) => w.id) });
  }
  const profile = getAppProfile(input.pack)!;

  // Interaction mode: explicit > workflow > pack default > auto.
  const mode: InteractionMode = resolveInteractionMode({
    explicit: input.interactionMode,
    workflow: workflow.interactionMode,
    packDefault: profile.interaction?.defaultMode
  });
  const foregroundDemo = input.foregroundDemo;

  // Background preflight BEFORE the workflow runs (steps AND finally; no
  // launch side effects for a refused workflow).
  if (mode === "background") {
    const unsafe = backgroundUnsafePipelineSteps(
      workflow.steps,
      workflow.finally ?? [],
      (id) => packRegistry.getPack(id)?.actions,
      pack.actions
    );
    if (unsafe.length > 0) {
      const err = pipelineNotBackgroundSafeError(mode, unsafe);
      throw new McpUiError("PIPELINE_NOT_BACKGROUND_SAFE", err.message, err.details);
    }
  }

  // The pipeline engine injects the resolved interaction context into every
  // interaction-aware step (profile_launch / profile_action / capture_window
  // / launch_app / type_text / send_key), so a foregroundDemo workflow keeps
  // its presentation across the whole run - not just the launch step.

  const result = await runWorkflow({
    pack,
    workflow,
    inputs: input.inputs ?? {},
    profile,
    ctx: createPipelineExecutionContext({
      runtime,
      uiaDeps,
      packId: pack.manifest.id,
      interactionMode: mode,
      ...(foregroundDemo ? { interaction: foregroundDemo } : {})
    })
  });
  return { ...withRunTtl(result), pack: input.pack, workflow: input.workflow };
}

async function validateStepsTool(args: unknown, runtime: RuntimeModules) {
  const input = args as import("./schemas.js").ValidateStepsInput;
  const pack = input.pack ? packRegistry.getPack(input.pack) : undefined;
  const v = validatePipelineStatic(
    { steps: input.steps, finally: input.finally },
    {
      pack: pack ? { id: pack.manifest.id, actions: pack.actions } : undefined,
      getContract,
      parseArgs: (tool, toolArgs) => {
        const schema = runtime.schemas.toolZodSchemas[tool];
        if (!schema) return { ok: true };
        const parsed = schema.safeParse(toolArgs);
        if (parsed.success) return { ok: true };
        return { ok: false, message: z.prettifyError(parsed.error).slice(0, 500) };
      }
    }
  );
  return {
    valid: v.valid,
    errors: v.errors,
    warnings: v.warnings,
    estimatedMaxDurationMs: v.estimatedMaxDurationMs,
    toolCount: v.toolCount,
    maxSteps: 50,
    note: "Static preflight validates contracts, references, and types only; it cannot guarantee a runtime control exists."
  };
}

async function continueRunTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = args as import("./schemas.js").ContinueRunInput;
  const snapshot = getRun(input.runId);
  if (!snapshot) {
    return {
      schemaVersion: 1, success: false, runId: input.runId, status: "failed", total: 0, completed: 0,
      stoppedAtIndex: null, completedSteps: [], steps: [], exports: {},
      error: { code: "RUN_EXPIRED", message: `Run '${input.runId}' was not found or has expired (runs are kept in memory for 10 minutes).` },
      finallyResults: [], restoreResults: [], warnings: []
    };
  }

  // continue_run REUSES the resolved interaction context stored in the run
  // snapshot - it never re-derives the mode from current pack defaults (which
  // may have changed since the original run). Legacy snapshots (created
  // before interaction-context storage) fall back to the pack default and
  // report RUN_INTERACTION_CONTEXT_MISSING.
  const packProfile = snapshot.packId ? getAppProfile(snapshot.packId) : undefined;
  const resolved = resolveContinuationInteraction(snapshot.interaction, packProfile?.interaction?.defaultMode);

  const result = await continuePipeline({
    runId: input.runId,
    continueFrom: input.continueFrom,
    ctx: createPipelineExecutionContext({
      runtime,
      uiaDeps,
      packId: snapshot.packId,
      interactionMode: resolved.mode,
      ...(resolved.interaction ? { interaction: resolved.interaction } : {})
    }),
    // REAL process + window liveness (OpenProcess/GetExitCodeProcess in the
    // helper), never "still has a top-level window" as a proxy for alive.
    checkProcessAlive: async (pid) => {
      try {
        const r = await runtime.windows.checkProcessAlive({ pid });
        return r.processAlive;
      } catch {
        return false;
      }
    },
    checkHwndValid: async (hwnd) => {
      try {
        const r = await runtime.windows.checkProcessAlive({ hwnd });
        return r.windowAlive;
      } catch {
        return false;
      }
    },
    getPackVersion: (packId) => packRegistry.getPack(packId)?.manifest.version
  });
  if (resolved.contextMissing) {
    result.warnings?.push("RUN_INTERACTION_CONTEXT_MISSING: The run snapshot predates interaction-context storage; the interaction mode was re-derived from the current pack default instead of the original run.");
  }
  return withRunTtl(result);
}

// Add remaining TTL info to a run result.
function withRunTtl(result: import("./pipeline.js").PipelineResult): Record<string, unknown> {
  const snapshot = getRun(result.runId);
  return {
    ...result,
    ...(snapshot ? { runTtlRemainingMs: runTtlRemainingMs(snapshot) } : {})
  };
}

// ── Single-tool dispatch (also used by pipeline steps) ──

// ── targetRef resolution ──
//
// High-level target tools accept targetRef (preferred), hwnd, pid,
// processName, or titleContains. Resolution priority: targetRef (auto-rebound
// when the window was recreated) > explicit hwnd (direct low-level targeting
// only) > pid/processName/titleContains. When BOTH targetRef and hwnd are
// given, targetRef wins: it is the session identity, and an old explicit hwnd
// must never override the binding's rebind capability (a stale hwnd would
// otherwise force the model to relaunch). When a profile is given with NO
// target at all and exactly one instance is running, the instance is
// auto-bound (targetAutoResolved:true); several instances never resolve
// (TARGET_AMBIGUOUS).

type ResolvedTarget = {
  windowSel: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string };
  targetMeta?: Record<string, unknown>;
  targetBinding?: TargetBinding;
};

// Resolve the App Pack Profile that governs a resolved target. Priority:
//   1. the targetRef binding's own profileId (authoritative - the binding
//      was created by profile_launch for that profile),
//   2. profile inference from the direct window selector (processName /
//      titleContains) when no binding exists.
// A targetRef that already knows its profile must NEVER be re-guessed from
// processName/titleContains (which may be absent or ambiguous).
function resolveProfileForResolvedTarget(
  resolved: ResolvedTarget,
  profiles: RuntimeModules["profiles"]
): import("./profiles/types.js").AppProfile | undefined {
  if (resolved.targetBinding?.profileId) {
    return getAppProfile(resolved.targetBinding.profileId);
  }
  if (resolved.windowSel.processName || resolved.windowSel.titleContains) {
    return profiles.findProfileForTarget({
      processName: resolved.windowSel.processName,
      titleContains: resolved.windowSel.titleContains
    });
  }
  return undefined;
}

async function resolveTargetInput(
  input: { targetRef?: string; profile?: string; pid?: number; hwnd?: string | number; processName?: string; titleContains?: string },
  runtime: RuntimeModules
): Promise<ResolvedTarget> {
  // 1. targetRef is the SESSION identity: resolve (and auto-rebind when the
  //    window was recreated). Wins over an explicit stale hwnd.
  if (input.targetRef) {
    const resolution = await resolveTargetRef(input.targetRef, {
      checkProcessAlive: (i) => runtime.windows.checkProcessAlive(i),
      listWindows: (f) => runtime.windows.listWindows(f)
    });
    if (!resolution.ok) {
      throw resolution.error;
    }
    // The binding carries the Profile/App Pack identity (profileId) created
    // by profile_launch. It MUST survive into the tool dispatch so capture
    // etc. can inherit the pack's interaction/capture defaults without
    // re-guessing the profile from processName/titleContains.
    const binding = getTarget(input.targetRef);
    return {
      windowSel: { ...(resolution.target.hwnd !== undefined ? { hwnd: resolution.target.hwnd } : {}), pid: resolution.target.pid },
      targetMeta: { target: resolution.target },
      ...(binding ? { targetBinding: binding } : {})
    };
  }
  // 2. Explicit hwnd (low-level direct targeting only - diagnostic/transient;
  //    it may change, so prefer a targetRef from profile_launch).
  if (input.hwnd !== undefined) {
    return { windowSel: { hwnd: input.hwnd } };
  }
  // 3. Auto-bind a unique running instance when a profile is specified and
  //    no pid/processName/titleContains was given. Never picks among
  //    multiple instances.
  if (input.profile && input.pid === undefined && input.processName === undefined && input.titleContains === undefined) {
    const profile = getAppProfile(input.profile);
    const pack = packRegistry.getPack(input.profile);
    if (profile) {
      const binding = await autoResolveTarget({
        profileId: profile.id,
        executableNames: profile.executableNames ?? [],
        processNames: profile.processNames,
        titleContains: profile.titleContains,
        mainWindow: pack?.profile.mainWindow,
        listWindows: (f) => runtime.windows.listWindows(f)
      });
      if (binding) {
        return {
          windowSel: { ...(binding.hwnd !== undefined ? { hwnd: binding.hwnd } : {}), pid: binding.pid },
          targetMeta: { targetAutoResolved: true },
          targetBinding: binding
        };
      }
    }
  }
  return { windowSel: { pid: input.pid, processName: input.processName, titleContains: input.titleContains } };
}

// Resolve the executable path actually used by profile_launch (mirrors the
// profile layer's priority chain: explicit exePath > env var > common build
// dirs > PATH). Used only for the OPTIONAL packCompatibility check; a
// resolution failure skips the check (never blocks launch).
async function resolveLaunchedExePath(
  input: { exePath?: string },
  profile: import("./profiles/types.js").AppProfile | undefined
): Promise<string | undefined> {
  const { access } = await import("node:fs/promises");
  const { resolve: resolvePath } = await import("node:path");
  const names = profile?.executableNames ?? [];
  const explicit = input.exePath;
  if (explicit) {
    try { await access(explicit); return resolvePath(explicit); } catch { /* fall through */ }
  }
  if (profile?.executableEnv && process.env[profile.executableEnv]) {
    const p = process.env[profile.executableEnv]!;
    try { await access(p); return resolvePath(p); } catch { /* fall through */ }
  }
  for (const name of names) {
    for (const c of [`./build/Release/${name}`, `./build/Release/Release/${name}`, `./${name}`]) {
      try { await access(c); return resolvePath(c); } catch { /* next */ }
    }
  }
  return undefined;
}

// ── Per-target operation ring (safe lifecycle diagnostics) ──
//
// Records the last N operations against a targetRef: tool name, timestamps,
// before/after process+window liveness, and the outcome class. NEVER records
// sensitive data (passwords, tokens, full text input, screenshot images).
// The ring feeds TARGET_PROCESS_EXITED diagnostics: `lastOperation` is
// temporal context, never a causality claim.
//
// This is the SINGLE wrapper for every targetRef-aware operation: the record
// is created BEFORE the operation starts (so a throw always yields a record)
// and finalized AFTER, with best-effort before/after lifecycle state. The
// caller extracts safe interaction metadata via the context (never by
// hand-writing a second record - exactly one record per operation).
//
// Classification:
//   success             - operation completed; after state still alive.
//   business-error      - structured business failure (ELEMENT_NOT_FOUND,
//                         ACTION_STATE_INCONSISTENT, ...) while the target
//                         session is still alive (or window rebound).
//   protocol-error      - non-target internal/input error; the target was
//                         alive before and cannot be confirmed dead.
//   target-disappeared  - the target process was alive before and is gone
//                         after. The ORIGINAL error is rethrown unchanged.
// A before/after state probe that itself fails NEVER overrides the original
// operation error - diagnostics are best-effort.

// Central registry of operation-tracked tools. Every tool that (a) accepts a
// targetRef AND (b) reads/operates the target window/process MUST be listed
// here so the coverage test can prove the dispatch wiring never regresses to
// untracked. Tools that accept targetRef but are deliberately untracked (pure
// metadata/schema queries) are listed in the coverage test as
// intentionally-untracked.
export const TARGET_OPERATION_TOOLS = new Set([
  "capture_window",
  "click_window",
  "move_mouse_window",
  "click_menu_item",
  "type_text",
  "send_key",
  "get_window_state",
  "wait_for_window",
  "ui_inspect_tree",
  "ui_query",
  "ui_get",
  "ui_action",
  "ui_wait",
  "profile_resolve",
  "profile_action",
  "ui_catalog"
]);

type TargetOperationCtx = {
  // Safe interaction metadata (method names like InvokePattern, PrintWindow,
  // post_message). NEVER user data.
  setInteractionMethod(method: string | undefined): void;
};

async function withTargetOperation<T>(
  tool: string,
  input: { targetRef?: string },
  runtime: RuntimeModules,
  run: (resolved: ResolvedTarget, ctx: TargetOperationCtx) => Promise<T>
): Promise<T> {
  const { targetRef } = input;
  const resolved = await resolveTargetInput(input, runtime);
  if (!targetRef) {
    // No session identity: nothing to correlate, run untracked (identical to
    // the previous behavior). The per-target ring only exists for bound
    // targetRefs.
    return run(resolved, { setInteractionMethod: () => undefined });
  }

  const binding = getTarget(targetRef);
  const targetMeta = resolved.targetMeta?.target as { targetRef?: string; pid?: number; hwnd?: string; rebound?: boolean; previousHwnd?: string } | undefined;
  const pid = targetMeta?.pid ?? binding?.pid;

  // Best-effort BEFORE state. Never throws into the caller.
  let before: { processAlive?: boolean; windowAlive?: boolean; hwnd?: string } = {};
  if (pid !== undefined) {
    try {
      const state = await runtime.windows.checkProcessAlive({ pid, ...(targetMeta?.hwnd ? { hwnd: targetMeta.hwnd } : {}) });
      before = {
        ...(state.processAlive !== undefined ? { processAlive: state.processAlive } : {}),
        ...(state.windowAlive !== undefined ? { windowAlive: state.windowAlive } : {}),
        ...(targetMeta?.hwnd ? { hwnd: String(targetMeta.hwnd) } : {})
      };
    } catch {
      before = { ...(targetMeta?.hwnd ? { hwnd: String(targetMeta.hwnd) } : {}) };
    }
  }

  const record = recordTargetOperation(targetRef, {
    tool,
    startedAt: Date.now(),
    ...(Object.keys(before).length > 0 ? { before } : {})
  });

  let interactionMethod: string | undefined;
  const ctx: TargetOperationCtx = {
    setInteractionMethod: (method) => { interactionMethod = method; }
  };

  try {
    const result = await run(resolved, ctx);
    await finalizeOperationRecord(runtime, record, tool, targetRef, pid, {
      interactionMethod,
      before,
      error: undefined
    });
    return result;
  } catch (error) {
    await finalizeOperationRecord(runtime, record, tool, targetRef, pid, {
      interactionMethod,
      before,
      error
    });
    // The ORIGINAL error is always rethrown - diagnostics never replace it.
    throw error;
  }
}

async function finalizeOperationRecord(
  runtime: RuntimeModules,
  record: TargetOperationRecord | undefined,
  tool: string,
  targetRef: string,
  pid: number | undefined,
  opts: { interactionMethod?: string; before?: TargetOperationRecord["before"]; error: unknown }
): Promise<void> {
  if (!record) return;

  // Best-effort AFTER state; a probe failure must never mask the original
  // operation outcome (error or success).
  //
  // The AFTER probe MUST pass the previous hwnd: without a hwnd the Windows
  // helper cannot judge whether the specific window is still alive and would
  // report windowAlive=false for a perfectly healthy target. The previous
  // hwnd is the BEFORE hwnd when recorded, else the resolved target hwnd.
  const previousHwnd = record.before?.hwnd;
  let after: { processAlive?: boolean; windowAlive?: boolean; hwnd?: string } = {};
  let afterDiagnosticsAvailable = false;
  if (pid !== undefined) {
    try {
      const state = await runtime.windows.checkProcessAlive({
        pid,
        ...(previousHwnd !== undefined ? { hwnd: previousHwnd } : {})
      });
      afterDiagnosticsAvailable = true;
      after = {
        ...(state.processAlive !== undefined ? { processAlive: state.processAlive } : {}),
        ...(state.windowAlive !== undefined ? { windowAlive: state.windowAlive } : {}),
        ...(previousHwnd !== undefined && state.windowAlive ? { hwnd: previousHwnd } : {})
      };
    } catch {
      // diagnosticsUnavailable: after stays empty; the original outcome wins.
    }
  }
  // Diagnostics may be unavailable (probe threw) - record that fact instead
  // of fabricating an empty after state. Never promoted to the main error.
  if (!afterDiagnosticsAvailable) {
    record.afterDiagnosticsAvailable = false;
  }

  record.finishedAt = Date.now();
  if (opts.interactionMethod) record.interactionMethod = opts.interactionMethod;

  // UNIFIED window-lifecycle finalization for every outcome (success /
  // business-error / protocol-error share ONE rebind policy; no branch may
  // maintain its own window-selection logic):
  //   Case A: previous hwnd still valid  -> no rebind, keep previousHwnd.
  //   Case B: process alive, previous hwnd gone -> profile-aware rebind
  //           (only windows matching the profile main-window rules qualify).
  //   Case C: process dead -> never rebind (target-disappeared).
  const windowState = await finalizeTargetWindowState(runtime, record, targetRef, pid, after);

  const err = opts.error;
  if (err === undefined) {
    record.result = "success";
    record.after = windowState.after;
    if (windowState.rebound) record.windowRebound = true;
    return;
  }

  if (err instanceof McpUiError) {
    record.errorCode = err.code;
    if (windowState.processExited) {
      record.result = "target-disappeared";
      record.after = windowState.after;
      return;
    }
    record.result = "business-error";
    record.after = windowState.after;
    if (windowState.rebound) record.windowRebound = true;
    return;
  }

  // Non-structured error: internal/protocol. Only classify as
  // target-disappeared when the process was alive before and is provably dead
  // after; otherwise protocol-error.
  if (opts.before?.processAlive === true && windowState.after.processAlive === false) {
    record.result = "target-disappeared";
    record.after = windowState.after;
    return;
  }
  record.result = "protocol-error";
  record.after = windowState.after;
  if (windowState.rebound) record.windowRebound = true;
}

// Shared window-lifecycle finalization for operation records. Returns the
// post-operation window state; MAY update binding.hwnd (only to a window that
// satisfies the profile main-window rules, and only when the previous hwnd is
// genuinely gone). Best-effort: a diagnostics failure never overrides the
// caller's outcome.
async function finalizeTargetWindowState(
  runtime: RuntimeModules,
  record: TargetOperationRecord,
  targetRef: string,
  pid: number | undefined,
  after: { processAlive?: boolean; windowAlive?: boolean; hwnd?: string }
): Promise<{ after: typeof after; rebound: boolean; processExited: boolean }> {
  const processExited = after.processAlive === false;

  // Case A: previous hwnd still valid -> never rebind, never touch binding.
  if (after.processAlive === true && after.windowAlive === true) {
    return { after, rebound: false, processExited: false };
  }

  // Case C: process dead -> never attempt a window rebind.
  if (processExited) {
    return { after, rebound: false, processExited: true };
  }

  // Case B: process alive but the previous window is gone -> profile-aware
  // rebind (single shared algorithm: matchesMainWindow via targets.ts).
  const binding = getTarget(targetRef);
  if (!binding || record.before?.hwnd === undefined) {
    return { after, rebound: false, processExited: false };
  }
  try {
    const rebound = await rebindTargetByRules(binding, {
      checkProcessAlive: (i) => runtime.windows.checkProcessAlive(i),
      listWindows: (f) => runtime.windows.listWindows(f)
    });
    if (rebound) {
      return {
        after: { processAlive: true, windowAlive: true, hwnd: rebound.hwnd! },
        rebound: true,
        processExited: false
      };
    }
  } catch {
    // best-effort: rebind failure keeps the current after state.
  }
  // No valid main window matched -> window-lost-process-alive (never binds a
  // secondary/popup window, never classified as process exit).
  return { after, rebound: false, processExited: false };
}

// Large-tree output guard: results that would flood the client are refused
// with a scoped-query suggestion (TREE_OUTPUT_TOO_LARGE) instead of forcing
// the model to parse a huge persisted dump.
function guardLargeTreeResult(nodes: unknown[] | undefined, tool: string): void {
  if (!nodes || nodes.length === 0) return;
  const bytes = estimateJsonBytes(nodes);
  if (bytes > MAX_STEP_RESULT_BYTES) {
    throw new McpUiError(
      "TREE_OUTPUT_TOO_LARGE",
      `The requested tree is too large (${nodes.length} nodes, ~${Math.round(bytes / 1024)} KiB; the per-result budget is ${Math.round(MAX_STEP_RESULT_BYTES / 1024)} KiB).`,
      { tool, nodes: nodes.length, bytes },
      "Use ui_query with rootSelector, nameContains, fields, and maxResults, or pass rootSelector/fields to this tool to scope the output."
    );
  }
}

// Raw dispatch: input is ALREADY validated/parsed (the unified executor did
// it). Orchestration tools (run_steps etc.) receive their parsed input too.
// Merge resolved-target metadata into a tool result WITHOUT overwriting
// result-owned fields (e.g. capture_window's `target` is a window title
// string while targetMeta.target is the resolution object - the result's own
// field must win to satisfy its outputSchema).
function mergeTargetMeta(result: Record<string, unknown>, targetMeta: Record<string, unknown>): Record<string, unknown> {
  const out = { ...result };
  for (const [k, v] of Object.entries(targetMeta)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

// Exported for the operation-wrapper tests (test-only hook; not an MCP tool).
export async function dispatchToolValue(
  name: string,
  input: unknown,
  runtime: RuntimeModules,
  uiaDeps: UiaDeps
): Promise<unknown> {
  const { windows, profiles } = runtime;

  switch (name) {
    case "run_steps":
      return runStepsTool(input, runtime, uiaDeps);
    case "profile_run_steps":
      return profileRunStepsTool(input, runtime, uiaDeps);
    case "run_workflow":
      return runWorkflowTool(input, runtime, uiaDeps);
    case "continue_run":
      return continueRunTool(input, runtime, uiaDeps);
    case "validate_steps":
      return validateStepsTool(input, runtime);
    case "app_pack_list":
      return appPackListTool(input, runtime);
    case "app_pack_describe":
      return appPackDescribeTool(input, runtime);
    case "app_pack_validate":
      return appPackValidateTool(input, runtime);
    case "app_pack_reload":
      return appPackReloadTool(input, runtime);
    case "app_pack_probe":
      return appPackProbeTool(input, runtime);
    case "tool_contract_list":
      return toolContractListTool(input, runtime);
    case "tool_contract_describe":
      return toolContractDescribeTool(input, runtime);
    case "launch_app":
      return await windows.launchApp(input as import("./schemas.js").LaunchAppInput);
    case "list_windows":
      return await windows.listWindows(input as import("./schemas.js").ListWindowsInput);
    case "capture_window": {
      // Interaction mode resolution order:
      //   1. explicit interactionMode on this call,
      //   2. the targetRef binding's Profile/App Pack default,
      //   3. profile inferred from the direct window selector,
      //   4. generic auto/default.
      const captureInput = input as import("./schemas.js").CaptureWindowInput;
      return await withTargetOperation(
        "capture_window",
        captureInput,
        runtime,
        async (resolved, ctx) => {
          const targetProfile = resolveProfileForResolvedTarget(resolved, profiles);
          const captureMode: InteractionMode = resolveInteractionMode({
            explicit: captureInput.interactionMode,
            packDefault: targetProfile?.interaction?.defaultMode
          });
          const captureResult = await windows.captureWindow({ ...captureInput, ...resolved.windowSel }, captureMode);
          // Safe interaction metadata (e.g. PrintWindow) for the ring.
          ctx.setInteractionMethod(captureResult.interaction?.method);
          return resolved.targetMeta ? mergeTargetMeta(captureResult as unknown as Record<string, unknown>, resolved.targetMeta) : captureResult;
        }
      );
    }
    case "capture_screen_region":
      return await windows.captureScreenRegion(input as import("./schemas.js").CaptureScreenRegionInput);
    case "click_window": {
      // Low-level window tools accept targetRef too: once a target session
      // exists (profile_launch), the SAME session identity applies here, so a
      // stale hwnd never forces a manual relaunch. This is lifecycle
      // consistency, not an encouragement of coordinate fallbacks.
      const clickInput = input as import("./schemas.js").ClickWindowInput;
      return await withTargetOperation(
        "click_window",
        clickInput,
        runtime,
        async (resolved, ctx) => {
          const clickResult = await windows.clickWindow({ ...clickInput, ...resolved.windowSel });
          ctx.setInteractionMethod(clickResult.method);
          return resolved.targetMeta ? { ...clickResult, ...resolved.targetMeta } : clickResult;
        }
      );
    }
    case "click_menu_item": {
      const menuInput = input as import("./schemas.js").ClickMenuItemInput;
      return await withTargetOperation(
        "click_menu_item",
        menuInput,
        runtime,
        async (resolved, ctx) => {
          const menuResult = await windows.clickMenuItem({ ...menuInput, ...resolved.windowSel });
          ctx.setInteractionMethod(menuResult.method);
          return resolved.targetMeta ? { ...menuResult, ...resolved.targetMeta } : menuResult;
        }
      );
    }
    case "move_mouse_window": {
      const moveInput = input as import("./schemas.js").MoveMouseWindowInput;
      return await withTargetOperation(
        "move_mouse_window",
        moveInput,
        runtime,
        async (resolved, ctx) => {
          const moveResult = await windows.moveMouseWindow({ ...moveInput, ...resolved.windowSel });
          ctx.setInteractionMethod(moveResult.method);
          return resolved.targetMeta ? { ...moveResult, ...resolved.targetMeta } : moveResult;
        }
      );
    }
    case "close_app":
      return await windows.closeApp((input as import("./schemas.js").CloseAppInput).pid);
    case "type_text": {
      const typeInput = input as import("./schemas.js").TypeTextInput;
      return await withTargetOperation(
        "type_text",
        typeInput,
        runtime,
        async (resolved, ctx) => {
          const typeResult = await windows.typeText({ ...typeInput, ...resolved.windowSel });
          ctx.setInteractionMethod("post_message");
          return resolved.targetMeta ? { ...typeResult, ...resolved.targetMeta } : typeResult;
        }
      );
    }
    case "send_key": {
      const keyInput = input as import("./schemas.js").SendKeyInput;
      return await withTargetOperation(
        "send_key",
        keyInput,
        runtime,
        async (resolved, ctx) => {
          const keyResult = await windows.sendKey({ ...keyInput, ...resolved.windowSel });
          ctx.setInteractionMethod("post_message");
          return resolved.targetMeta ? { ...keyResult, ...resolved.targetMeta } : keyResult;
        }
      );
    }
    case "read_clipboard":
      return await windows.readClipboard(input as import("./schemas.js").ReadClipboardInput);
    case "write_clipboard":
      return await windows.writeClipboard(input as import("./schemas.js").WriteClipboardInput);
    case "get_window_state": {
      const stateInput = input as import("./schemas.js").GetWindowStateInput;
      return await withTargetOperation(
        "get_window_state",
        stateInput,
        runtime,
        async (resolved) => {
          const stateResult = await windows.getWindowState({ ...stateInput, ...resolved.windowSel });
          return resolved.targetMeta ? { ...stateResult, ...resolved.targetMeta } : stateResult;
        }
      );
    }
    case "wait_for_window": {
      const waitInput = input as import("./schemas.js").WaitForWindowInput;
      return await withTargetOperation(
        "wait_for_window",
        waitInput,
        runtime,
        async (resolved) => {
          const waitResult = await windows.waitForWindow({ ...waitInput, ...resolved.windowSel });
          return resolved.targetMeta ? { ...waitResult, ...resolved.targetMeta } : waitResult;
        }
      );
    }
    case "ui_inspect_tree": {
      const treeInput = input as import("./schemas.js").UiInspectTreeInput;
      return await withTargetOperation(
        "ui_inspect_tree",
        treeInput,
        runtime,
        async (resolved, ctx) => {
          const treeResult = await windows.inspectUiTree({ ...treeInput, ...resolved.windowSel });
          guardLargeTreeResult(treeResult.nodes, "ui_inspect_tree");
          ctx.setInteractionMethod("UIAQuery");
          return resolved.targetMeta ? { ...treeResult, ...resolved.targetMeta } : treeResult;
        }
      );
    }
    case "ui_query": {
      const queryInput = input as import("./schemas.js").UiQueryInput;
      return await withTargetOperation(
        "ui_query",
        queryInput,
        runtime,
        async (resolved, ctx) => {
          const queryResult = await windows.queryUi({ ...queryInput, ...resolved.windowSel });
          ctx.setInteractionMethod("UIAQuery");
          return resolved.targetMeta ? { ...queryResult, ...resolved.targetMeta } : queryResult;
        }
      );
    }
    case "ui_get": {
      const getInput = input as import("./schemas.js").UiGetInput;
      return await withTargetOperation(
        "ui_get",
        getInput,
        runtime,
        async (resolved, ctx) => {
          const getResult = await windows.getUiElement({ ...getInput, ...resolved.windowSel });
          ctx.setInteractionMethod("UIAQuery");
          return resolved.targetMeta ? { ...getResult, ...resolved.targetMeta } : getResult;
        }
      );
    }
    case "ui_action": {
      const actionInput = input as import("./schemas.js").UiActionInput;
      return await withTargetOperation(
        "ui_action",
        actionInput,
        runtime,
        async (resolved, ctx) => {
          const actionResult = await windows.performUiAction({ ...actionInput, ...resolved.windowSel });
          ctx.setInteractionMethod(actionResult.method);
          return resolved.targetMeta ? { ...actionResult, ...resolved.targetMeta } : actionResult;
        }
      );
    }
    case "ui_wait": {
      const waitInput = input as import("./schemas.js").UiWaitInput;
      return await withTargetOperation(
        "ui_wait",
        waitInput,
        runtime,
        async (resolved, ctx) => {
          const waitResult = await windows.waitForUi({ ...waitInput, ...resolved.windowSel });
          ctx.setInteractionMethod("UIAQuery");
          return resolved.targetMeta ? { ...waitResult, ...resolved.targetMeta } : waitResult;
        }
      );
    }
    case "profile_list":
      return profiles.profileList();
    case "profile_resolve": {
      const resolveInput = input as import("./schemas.js").ProfileResolveInput;
      return await withTargetOperation(
        "profile_resolve",
        resolveInput,
        runtime,
        async (resolved, ctx) => {
          const resolveResult = await profiles.resolveProfileControl(uiaDeps, { ...resolveInput, ...resolved.windowSel });
          ctx.setInteractionMethod("UIAQuery");
          return resolved.targetMeta ? { ...resolveResult, ...resolved.targetMeta } : resolveResult;
        }
      );
    }
    case "profile_action": {
      const actionInput = input as import("./schemas.js").ProfileActionInput;
      return await withTargetOperation(
        "profile_action",
        actionInput,
        runtime,
        async (resolved, ctx) => {
          const actionResult = await profiles.performProfileAction(uiaDeps, { ...actionInput, ...resolved.windowSel });
          ctx.setInteractionMethod(actionResult.interaction?.method);
          return resolved.targetMeta ? { ...actionResult, ...resolved.targetMeta } : actionResult;
        }
      );
    }
    case "profile_launch": {
      const launchInput = input as import("./schemas.js").ProfileLaunchInput;
      const launchResult = await profiles.launchProfile(
        uiaDeps,
        async (i) => windows.launchApp({
          exePath: i.exePath,
          args: i.args ?? [],
          waitForWindow: i.waitForWindow ?? true,
          noActivate: i.noActivate ?? true,
          startMinimized: i.startMinimized ?? false,
          timeoutMs: i.timeoutMs ?? 30000,
          // profile_launch launches desktop apps the user wants to operate:
          // the app must survive the MCP server (independent by default).
          lifetime: i.lifetime ?? "independent"
        }),
        windows.listWindows,
        launchInput,
        windows.getExeManifestLevel
      );
      // Register the stable target binding so later calls can pass targetRef
      // instead of pid/hwnd (and survive window recreation via auto-rebind).
      const profile = getAppProfile(launchInput.profile);
      const pack = packRegistry.getPack(launchInput.profile);
      const binding = bindLaunchTarget({
        profileId: launchResult.profile,
        executableNames: profile?.executableNames ?? [],
        processNames: profile?.processNames ?? [],
        titleContains: profile?.titleContains,
        mainWindow: pack?.profile.mainWindow,
        pid: launchResult.pid,
        ...(launchResult.hwnd ? { hwnd: launchResult.hwnd } : {}),
        ...(launchResult.title ? { title: launchResult.title } : {}),
        // startedByMcp and lifetime are SEPARATE concepts: a process can be
        // started by the MCP server yet be independent of its lifetime (the
        // profile_launch default). lifetime records the launch contract.
        ...(launchResult.startedByMcp ? { startedByMcp: true, startedAt: Date.now() } : {}),
        ...(launchResult.lifetime ? { lifetime: launchResult.lifetime } : {})
      });
      // OPTIONAL App Pack ↔ EXE compatibility check. A mismatch is a WARNING
      // (never a launch block): layout changes do not necessarily invalidate
      // every selector. `checked` is false when the pack declares no
      // testedAgainst metadata.
      let packCompatibility: import("./app-packs/compatibility.js").PackCompatibility | undefined;
      const resolvedExePath = await resolveLaunchedExePath(launchInput, profile);
      if (resolvedExePath) {
        const { checkPackCompatibility } = await import("./app-packs/compatibility.js");
        packCompatibility = await checkPackCompatibility(pack, resolvedExePath, (p) => windows.getExeIdentity(p));
      }
      return {
        ...launchResult,
        targetRef: binding.targetRef,
        ...(packCompatibility ? { packCompatibility } : {})
      };
    }
    case "ui_catalog": {
      const catInput = input as import("./schemas.js").UiCatalogInput;
      return await withTargetOperation(
        "ui_catalog",
        catInput,
        runtime,
        async (resolved, ctx) => {
          const catalog = await windows.catalogUi({ ...catInput, ...resolved.windowSel });
          guardLargeTreeResult(catalog.controls, "ui_catalog");
          ctx.setInteractionMethod("UIAQuery");
          const profile = resolveProfileForResolvedTarget(resolved, profiles);
          if (!catInput.summaryOnly) {
            catalog.controls = profiles.enrichCatalogControls(profile, catalog.controls);
          }
          return resolved.targetMeta ? { ...catalog, ...resolved.targetMeta } : catalog;
        }
      );
    }
    case "app_pack_list":
      return appPackListTool(input, runtime);
    case "app_pack_describe":
      return appPackDescribeTool(input, runtime);
    case "resolve_semantic_control":
      return resolveSemanticControlTool(input, runtime);
    case "app_pack_validate":
      return appPackValidateTool(input, runtime);
    case "app_pack_reload":
      return appPackReloadTool(input, runtime);
    case "app_pack_probe":
      return appPackProbeTool(input, runtime);
    case "workflow_catalog": {
      const wcInput = input as import("./schemas.js").WorkflowCatalogInput;
      const pack = packRegistry.getPack(wcInput.pack);
      if (!pack) {
        throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${wcInput.pack}' is loaded.`, { pack: wcInput.pack });
      }
      const profile = getAppProfile(wcInput.pack);
      return {
        defaultInteractionMode: profile?.interaction?.defaultMode ?? "auto",
        workflows: listWorkflows(pack)
      };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

// ── Runtime loading ──
//
// HOT-RELOAD BOUNDARY: only the modules below are dynamically loaded and may
// hot-reload at runtime (schemas / windows / profiles-registry, plus the
// PowerShell helper). Everything else in src/ (pipeline, contracts, executor,
// app-packs, interaction, ...) is imported statically and requires a server
// restart to pick up changes - modifying it while the server runs is NOT
// supported and may produce mixed old/new module state. App Pack JSON is
// reloaded independently via app_pack_reload.

async function loadRuntime(): Promise<RuntimeModules> {
  const version = hotReloadEnabled ? await runtimeVersion() : "static";
  if (runtimeCache?.version === version) {
    return runtimeCache;
  }

  runtimeCache?.windows.shutdownHelper();
  const suffix = hotReloadEnabled ? `?v=${encodeURIComponent(version)}` : "";
  const schemas = await import(`./schemas.js${suffix}`) as typeof SchemasModule;
  const windows = await import(`./windows.js${suffix}`) as typeof WindowsModule;
  const profiles = await import(`./profiles/registry.js${suffix}`) as typeof ProfilesModule;

  runtimeCache = { version, schemas, windows, profiles };
  if (version !== "static") {
    console.error(`screenshottool-mcp hot reload loaded runtime ${version}.`);
  }
  return runtimeCache;
}

const RUNTIME_VERSION_CACHE_MS = 1000;
let cachedRuntimeVersion: { value: string; expiresAt: number } | null = null;

// Version = mtimes of EXACTLY the modules that are dynamically loaded (the
// hot-reload boundary). pipeline/contracts/executor/app-packs are NOT
// tracked: they are statically imported and require a restart.
async function runtimeVersion(): Promise<string> {
  if (cachedRuntimeVersion && cachedRuntimeVersion.expiresAt > Date.now()) {
    return cachedRuntimeVersion.value;
  }

  const sourceExt = path.basename(moduleRoot) === "dist" ? ".js" : ".ts";
  const files = [
    path.join(moduleRoot, `schemas${sourceExt}`),
    path.join(moduleRoot, `windows${sourceExt}`),
    path.join(moduleRoot, "profiles", `registry${sourceExt}`),
    path.join(runtimeRoot, "scripts", "win-capture.ps1")
  ];
  const versions = await Promise.all(files.map(async (file) => `${path.basename(file)}:${await fileMtimeMs(file)}`));
  const value = versions.join("|");

  cachedRuntimeVersion = { value, expiresAt: Date.now() + RUNTIME_VERSION_CACHE_MS };
  return value;
}

async function fileMtimeMs(file: string): Promise<number> {
  try {
    return Math.trunc((await stat(file)).mtimeMs);
  } catch {
    return 0;
  }
}

function shutdownRuntime(): void {
  runtimeCache?.windows.shutdownHelper();
}

function parseArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new McpError(ErrorCode.InvalidParams, z.prettifyError(parsed.error));
  }

  return parsed.data;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ],
    // structuredContent carries the machine-readable result for clients that
    // support it; the text content is preserved for compatibility. Array
    // results are wrapped under "items" because the protocol requires an
    // object for structuredContent.
    structuredContent: Array.isArray(value) ? { items: value } : (value as Record<string, unknown>)
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// ── Startup ──
//
// The server only connects when index.ts is the ENTRY module (direct run /
// dist build). Tests import the module for the dispatch/wrapper machinery and
// must not connect a stdio transport or load packs.

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await packRegistry.load(cliArgs.appPackDir, envPackDirs());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const { windows } = await loadRuntime();

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      shutdownRuntime();
      process.exit(0);
    });
  }
  process.once("exit", () => {
    shutdownRuntime();
  });

  const packCount = packRegistry.listPacks("all").length;
  console.error(`screenshottool-mcp ready. Default output directory: ${windows.getDefaultOutputDir()}. Hot reload: ${hotReloadEnabled ? "enabled" : "disabled"}. App Packs loaded: ${packCount}.`);
}
