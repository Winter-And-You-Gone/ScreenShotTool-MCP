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
import { McpUiError } from "./uia/results.js";
import { getContract, contracts } from "./contracts.js";
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

// Tools are registered from the contract table (src/contracts.ts): one entry
// per tool with description + input JSON Schema.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(contracts).map((c) => ({
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const runtime = await loadRuntime();
    const uiaDeps = runtime.profiles.buildUiaDeps(runtime.windows);

    // Pipeline-orchestration tools run through the pipeline engine and are
    // handled here rather than in dispatchToolValue so they cannot recurse.
    switch (name) {
      case "run_steps":
        return jsonResult(await runStepsTool(args, runtime, uiaDeps));
      case "profile_run_steps":
        return jsonResult(await profileRunStepsTool(args, runtime, uiaDeps));
      case "run_workflow":
        return jsonResult(await runWorkflowTool(args, runtime, uiaDeps));
      case "continue_run":
        return jsonResult(await continueRunTool(args, runtime, uiaDeps));
      case "validate_steps":
        return jsonResult(await validateStepsTool(args, runtime));
      case "app_pack_list":
        return jsonResult(await appPackListTool(args, runtime));
      case "app_pack_describe":
        return jsonResult(await appPackDescribeTool(args, runtime));
      case "app_pack_validate":
        return jsonResult(await appPackValidateTool(args, runtime));
      case "app_pack_reload":
        return jsonResult(await appPackReloadTool(args, runtime));
      case "app_pack_probe":
        return jsonResult(await appPackProbeTool(args, runtime));
    }
    return jsonResult(await dispatchToolValue(name, args, runtime, uiaDeps));
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (error instanceof McpUiError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: false, code: error.code, message: error.message, details: error.details ?? {} }, null, 2)
          }
        ]
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

async function appPackDescribeTool(args: unknown, runtime: RuntimeModules) {
  const input = parseArgs(runtime.schemas.appPackDescribeSchema, args);
  const pack = packRegistry.getPack(input.pack);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack, loaded: packRegistry.listPacks("all").map((p) => p.manifest.id) });
  }
  const profile = getAppProfile(pack.manifest.id)!;

  const controls = Object.entries(pack.controls.controls).map(([name, raw]) => {
    const selectors = Array.isArray(raw) ? raw
      : "selectors" in raw && Array.isArray((raw as { selectors?: unknown[] }).selectors)
        ? (raw as { selectors: unknown[] }).selectors
        : [raw];
    const entry = raw as { confidence?: string; description?: string; notes?: string; menu?: unknown };
    return {
      name,
      selectorCount: selectors.length,
      confidence: entry.confidence ?? "source-derived",
      description: entry.description ?? entry.notes ?? "",
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
    ...(c.requiresConfirmation ? { requiresConfirmation: true } : {})
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
      security: pack.profile.security
    },
    controls,
    actions,
    workflows,
    limitations,
    pipeSafe: {
      profile_launch: ["pid", "hwnd", "title"],
      profile_action: ["result", "selectorUsed"],
      ui_wait: ["matched", "timedOut"]
    }
  };
}

async function appPackValidateTool(args: unknown, runtime: RuntimeModules) {
  const input = parseArgs(runtime.schemas.appPackValidateSchema, args);
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
  return {
    reloaded: true,
    loadedPacks: result.loadedPacks.map((p) => packSummary(p.manifest.id)).filter((p) => p !== undefined),
    errors: result.issues
  };
}

async function appPackProbeTool(args: unknown, runtime: RuntimeModules) {
  const input = parseArgs(runtime.schemas.appPackProbeSchema, args);
  return probeApp(
    {
      listWindows: (f) => runtime.windows.listWindows(f),
      catalogUi: (c) => runtime.windows.catalogUi(c),
      inspectUiTree: (c) => runtime.windows.inspectUiTree(c as never)
    },
    input
  );
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

function pipelineExecutionContext(runtime: RuntimeModules, uiaDeps: UiaDeps, packId?: string): ExecutionContext {
  return {
    dispatch: (tool, toolArgs) => dispatchToolValue(tool, toolArgs, runtime, uiaDeps),
    pack: packId ? packContext(packId) : undefined,
    expectDeps: {
      getUiElement: (i) => uiaDeps.getUiElement(i),
      queryUi: (i) => uiaDeps.queryUi(i)
    }
  };
}

async function runStepsTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = parseArgs(runtime.schemas.runStepsSchema, args);
  // Backward-compatible structural pre-check: invalid placeholder references
  // (forward/unknown step ids) fail the whole call with InvalidParams before
  // any step runs, exactly like the pre-pipeline run_steps.
  const refCheck = validateReferences(input.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args ?? {} })));
  if (!refCheck.ok) {
    throw new McpError(ErrorCode.InvalidParams, refCheck.message);
  }
  const result = await runPipeline(input, pipelineExecutionContext(runtime, uiaDeps));
  return withRunTtl(result);
}

async function profileRunStepsTool(args: unknown, runtime: RuntimeModules, uiaDeps: UiaDeps) {
  const input = parseArgs(runtime.schemas.profileRunStepsSchema, args);
  const pack = packRegistry.getPack(input.profile);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.profile}' is loaded.`, { pack: input.profile, loaded: packRegistry.listPacks("all").map((p) => p.manifest.id) });
  }
  const profile = getAppProfile(input.profile)!;

  // 1. Launch / attach to the app.
  const launchResult = await runtime.profiles.launchProfile(
    uiaDeps,
    async (i) => runtime.windows.launchApp({
      exePath: i.exePath,
      args: i.args ?? [],
      waitForWindow: i.waitForWindow ?? true,
      noActivate: i.noActivate ?? true,
      startMinimized: i.startMinimized ?? false,
      timeoutMs: i.timeoutMs ?? 30000
    }),
    runtime.windows.listWindows,
    {
      profile: input.profile,
      ...(input.launch?.exePath ? { exePath: input.launch.exePath } : {}),
      ...(input.launch?.args ? { args: input.launch.args } : {}),
      ...(input.launch?.reuseIfRunning !== undefined ? { reuseIfRunning: input.launch.reuseIfRunning } : {}),
      ...(input.launch?.waitForWindow !== undefined ? { waitForWindow: input.launch.waitForWindow } : {}),
      ...(input.launch?.noActivate !== undefined ? { noActivate: input.launch.noActivate } : {}),
      ...(input.launch?.timeoutMs !== undefined ? { timeoutMs: input.launch.timeoutMs } : {})
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
    {
      dispatch: (tool, toolArgs) => dispatchToolValue(tool, toolArgs, runtime, uiaDeps),
      pack: { id: pack.manifest.id, actions: pack.actions, profile, version: pack.manifest.version },
      autoContext,
      expectDeps: {
        getUiElement: (i) => uiaDeps.getUiElement(i),
        queryUi: (i) => uiaDeps.queryUi(i)
      }
    }
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
  const input = parseArgs(runtime.schemas.runWorkflowSchema, args);
  const pack = packRegistry.getPack(input.pack);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack });
  }
  const workflow = getWorkflow(pack, input.workflow);
  if (!workflow) {
    throw new McpUiError("WORKFLOW_NOT_FOUND", `Pack '${input.pack}' has no workflow named '${input.workflow}'.`, { pack: input.pack, workflow: input.workflow, available: pack.workflows.workflows.map((w) => w.id) });
  }
  const profile = getAppProfile(input.pack)!;
  const result = await runWorkflow({
    pack,
    workflow,
    inputs: input.inputs ?? {},
    profile,
    dispatch: (tool, toolArgs) => dispatchToolValue(tool, toolArgs, runtime, uiaDeps),
    expectDeps: {
      getUiElement: (i) => uiaDeps.getUiElement(i),
      queryUi: (i) => uiaDeps.queryUi(i)
    }
  });
  return { ...withRunTtl(result), pack: input.pack, workflow: input.workflow };
}

async function validateStepsTool(args: unknown, runtime: RuntimeModules) {
  const input = parseArgs(runtime.schemas.validateStepsSchema, args);
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
  const input = parseArgs(runtime.schemas.continueRunSchema, args);
  const snapshot = getRun(input.runId);
  if (!snapshot) {
    return {
      schemaVersion: 1, success: false, runId: input.runId, status: "failed", total: 0, completed: 0,
      stoppedAtIndex: null, completedSteps: [], steps: [], exports: {},
      error: { code: "RUN_EXPIRED", message: `Run '${input.runId}' was not found or has expired (runs are kept in memory for 10 minutes).` },
      finallyResults: [], restoreResults: [], warnings: []
    };
  }

  const result = await continuePipeline({
    runId: input.runId,
    continueFrom: input.continueFrom,
    ctx: pipelineExecutionContext(runtime, uiaDeps, snapshot.packId),
    checkProcessAlive: async (pid) => {
      try {
        const wins = await runtime.windows.listWindows({ pid });
        return wins.length > 0;
      } catch {
        return false;
      }
    },
    checkHwndValid: async (hwnd) => {
      try {
        await runtime.windows.getWindowState({ hwnd });
        return true;
      } catch {
        return false;
      }
    },
    getPackVersion: (packId) => packRegistry.getPack(packId)?.manifest.version
  });
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

async function dispatchToolValue(
  name: string,
  args: unknown,
  runtime: RuntimeModules,
  uiaDeps: UiaDeps
): Promise<unknown> {
  const { schemas, windows, profiles } = runtime;

  switch (name) {
    case "launch_app":
      return await windows.launchApp(parseArgs(schemas.launchAppSchema, args));
    case "list_windows":
      return await windows.listWindows(parseArgs(schemas.listWindowsSchema, args));
    case "capture_window":
      return await windows.captureWindow(parseArgs(schemas.captureWindowSchema, args));
    case "capture_screen_region":
      return await windows.captureScreenRegion(parseArgs(schemas.captureScreenRegionSchema, args));
    case "click_window":
      return await windows.clickWindow(parseArgs(schemas.clickWindowSchema, args));
    case "click_menu_item":
      return await windows.clickMenuItem(parseArgs(schemas.clickMenuItemSchema, args));
    case "move_mouse_window":
      return await windows.moveMouseWindow(parseArgs(schemas.moveMouseWindowSchema, args));
    case "close_app":
      return await windows.closeApp(parseArgs(schemas.closeAppSchema, args).pid);
    case "type_text":
      return await windows.typeText(parseArgs(schemas.typeTextSchema, args));
    case "send_key":
      return await windows.sendKey(parseArgs(schemas.sendKeySchema, args));
    case "read_clipboard":
      return await windows.readClipboard(parseArgs(schemas.readClipboardSchema, args));
    case "write_clipboard":
      return await windows.writeClipboard(parseArgs(schemas.writeClipboardSchema, args));
    case "get_window_state":
      return await windows.getWindowState(parseArgs(schemas.getWindowStateSchema, args));
    case "wait_for_window":
      return await windows.waitForWindow(parseArgs(schemas.waitForWindowSchema, args));
    case "ui_inspect_tree":
      return await windows.inspectUiTree(parseArgs(schemas.uiInspectTreeSchema, args));
    case "ui_query":
      return await windows.queryUi(parseArgs(schemas.uiQuerySchema, args));
    case "ui_get":
      return await windows.getUiElement(parseArgs(schemas.uiGetSchema, args));
    case "ui_action":
      return await windows.performUiAction(parseArgs(schemas.uiActionSchema, args));
    case "ui_wait":
      return await windows.waitForUi(parseArgs(schemas.uiWaitSchema, args));
    case "profile_list":
      return profiles.profileList();
    case "profile_resolve":
      return await profiles.resolveProfileControl(uiaDeps, parseArgs(schemas.profileResolveSchema, args));
    case "profile_action":
      return await profiles.performProfileAction(uiaDeps, parseArgs(schemas.profileActionSchema, args));
    case "profile_launch":
      return await profiles.launchProfile(
        uiaDeps,
        async (i) => windows.launchApp({
          exePath: i.exePath,
          args: i.args ?? [],
          waitForWindow: i.waitForWindow ?? true,
          noActivate: i.noActivate ?? true,
          startMinimized: i.startMinimized ?? false,
          timeoutMs: i.timeoutMs ?? 30000
        }),
        windows.listWindows,
        parseArgs(schemas.profileLaunchSchema, args),
        windows.getExeManifestLevel
      );
    case "ui_catalog": {
      const catInput = parseArgs(schemas.uiCatalogSchema, args);
      const catalog = await windows.catalogUi(catInput);
      const profile = profiles.findProfileForTarget({ processName: catInput.processName, titleContains: catInput.titleContains });
      catalog.controls = profiles.enrichCatalogControls(profile, catalog.controls);
      return catalog;
    }
    case "app_pack_list":
      return appPackListTool(args, runtime);
    case "app_pack_describe":
      return appPackDescribeTool(args, runtime);
    case "app_pack_validate":
      return appPackValidateTool(args, runtime);
    case "app_pack_reload":
      return appPackReloadTool(args, runtime);
    case "app_pack_probe":
      return appPackProbeTool(args, runtime);
    case "workflow_catalog": {
      const input = parseArgs(schemas.workflowCatalogSchema, args);
      const pack = packRegistry.getPack(input.pack);
      if (!pack) {
        throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.pack}' is loaded.`, { pack: input.pack });
      }
      return { workflows: listWorkflows(pack) };
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}

// ── Runtime loading (hot reload) ──

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

async function runtimeVersion(): Promise<string> {
  if (cachedRuntimeVersion && cachedRuntimeVersion.expiresAt > Date.now()) {
    return cachedRuntimeVersion.value;
  }

  const sourceExt = path.basename(moduleRoot) === "dist" ? ".js" : ".ts";
  const files = [
    path.join(moduleRoot, `schemas${sourceExt}`),
    path.join(moduleRoot, `windows${sourceExt}`),
    path.join(moduleRoot, "profiles", `registry${sourceExt}`),
    path.join(moduleRoot, `contracts${sourceExt}`),
    path.join(moduleRoot, `pipeline${sourceExt}`),
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
