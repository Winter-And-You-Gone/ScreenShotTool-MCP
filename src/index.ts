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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { schemas } = await loadRuntime();

  return {
    tools: [
      // ════════════════════════════════════════════════════════════════
      // MCP 工具使用原则（AI Agent 必读）：
      //
      // 1. 截图很慢（1-5s），优先用 list_windows / get_window_state /
      //    click_window 验证状态，或用目标应用日志代替截图。
      //
      // 2. 不支持鼠标拖拽、拖动、手势、连续移动——click_window 只发
      //    单次按下+抬起。不需要反复尝试拖拽，直接请求人类操作。
      //
      // 3. move_mouse_window 只投递假消息，不移动真实光标。Qt/Electron
      //    等现代框架读取系统鼠标位置，不会响应假消息。不要依赖它触
      //    发 tooltip/hover/右键菜单，需要就请求人类操作。
      // ════════════════════════════════════════════════════════════════
      {
        name: "launch_app",
        description: "Launch a Windows .exe and optionally wait for its first visible window. Use noActivate for best-effort background launch.",
        inputSchema: schemas.toolInputSchemas.launch_app
      },
      {
        name: "list_windows",
        description: "List visible top-level Windows desktop windows, optionally filtered by pid, process name, or title substring.",
        inputSchema: schemas.toolInputSchemas.list_windows
      },
      {
        name: "capture_window",
        description: "IMPORTANT: screenshots are SLOW (each costs 1-5s and can block the target app). Prefer click_window + state checks (get_window_state, list_windows) or reading app logs/info instead of taking screenshots. Only capture when you actually need visual content. 'print' mode (default) uses PrintWindow API — works on occluded/minimized windows, but cannot capture separate top-level windows like Qt tooltips, popups, or Electron child windows. 'screen' mode uses CopyFromScreen (requires visible area, captures whatever is on top); only use when print fails or you need to capture separate popup/tooltip windows. noActivate avoids stealing focus.",
        inputSchema: schemas.toolInputSchemas.capture_window
      },
      {
        name: "capture_screen_region",
        description: "IMPORTANT: screenshots are SLOW (each costs 1-5s). Avoid this when possible — prefer window-relative capture or reading state via list_windows/get_window_state instead. Captures a screen-space rectangle in physical pixels. Copies whatever is currently visible at that screen region — if other windows occlude the target, the occluder is captured instead. Subject to multi-monitor coordinate and DPI considerations.",
        inputSchema: schemas.toolInputSchemas.capture_screen_region
      },
      {
        name: "click_window",
        description: "LIMITATION: only sends down/up messages — does NOT support drag-and-drop, pinch-to-zoom, or any gesture/sequence. Does NOT move the physical cursor. If you need drag or real mouse input, ask the human to do it. Posts mouse click messages to a window-relative coordinate.",
        inputSchema: schemas.toolInputSchemas.click_window
      },
      {
        name: "click_menu_item",
        description: "Invoke a native Windows menu item by menu path without moving the physical cursor or using keyboard shortcuts.",
        inputSchema: schemas.toolInputSchemas.click_menu_item
      },
      {
        name: "move_mouse_window",
        description: "LIMITATION: posts a fake WM_MOUSEMOVE message — does NOT move the real cursor, does NOT trigger Qt/Electron tooltips (those read QCursor::pos()), does NOT work for hover-dependent UI in modern apps. If you need real hover to trigger UI changes, ask the human to do it. Posts a WM_MOUSEMOVE message to a window-relative coordinate.",
        inputSchema: schemas.toolInputSchemas.move_mouse_window
      },
      {
        name: "close_app",
        description: "Terminate a process and its descendants via taskkill /T /F.",
        inputSchema: schemas.toolInputSchemas.close_app
      },
      {
        name: "type_text",
        description: "Type text into a window via SendInput Unicode. noActivate uses PostMessage WM_CHAR so the target window doesn't need focus. For standard Edit/RichEdit controls EM_REPLACESEL may be used, which replaces the current selection rather than inserting at the caret.",
        inputSchema: schemas.toolInputSchemas.type_text
      },
      {
        name: "send_key",
        description: "Send a keystroke with optional modifiers. noActivate uses PostMessage WM_KEYDOWN/WM_KEYUP so the target window doesn't need focus.",
        inputSchema: schemas.toolInputSchemas.send_key
      },
      {
        name: "read_clipboard",
        description: "Read the current text content of the Windows clipboard. Returns available=false when no text is on the clipboard.",
        inputSchema: schemas.toolInputSchemas.read_clipboard
      },
      {
        name: "write_clipboard",
        description: "Write text to the Windows clipboard. Supports Unicode including CJK and newlines. Pass an empty string to clear the clipboard. Use before send_key Ctrl+V for faster input than type_text.",
        inputSchema: schemas.toolInputSchemas.write_clipboard
      },
      {
        name: "get_window_state",
        description: "Query a window's state: minimized, maximized, foreground, topmost, enabled, layered/alpha, cloaked, etc. More detailed than list_windows.",
        inputSchema: schemas.toolInputSchemas.get_window_state
      },
      {
        name: "wait_for_window",
        description: "Block until a matching window appears (mode=appear) or disappears (mode=disappear). Returns found=false on timeout instead of throwing. More efficient than client-side polling.",
        inputSchema: schemas.toolInputSchemas.wait_for_window
      },
      {
        name: "ui_inspect_tree",
        description: "Read the UI Automation (UIA) control tree of a target window. Prefer this over screenshots for understanding UI structure. Returns a flat list of nodes (nodeId/parentNodeId) with controlType, automationId, name, className, frameworkId, patterns, and boundingRect. Bounded by maxDepth (default 10), maxNodes (default 1500), and timeoutMs. includeProcessPopups (default true) also searches same-PID top-level windows (Qt popups, dialogs, menus).",
        inputSchema: schemas.toolInputSchemas.ui_inspect_tree
      },
      {
        name: "ui_query",
        description: "Find UI elements matching a selector (automationId/name/controlType/className/frameworkId + match mode + ancestor/path). Returns up to maxResults (default 100) elements with value/toggleState/selected/expandCollapseState/rangeValue state. UIA-first: prefer this over coordinate-based click_window when a stable selector exists.",
        inputSchema: schemas.toolInputSchemas.ui_query
      },
      {
        name: "ui_get",
        description: "Read the current state of a single uniquely-identified control (lighter than ui_query). 0 matches -> found:false; 1 match -> full state; >1 matches -> ELEMENT_AMBIGUOUS error. Does not take screenshots.",
        inputSchema: schemas.toolInputSchemas.ui_get
      },
      {
        name: "ui_action",
        description: "Perform an action on a UI control via UIA patterns (invoke/toggle/select/expand/collapse/setValue/setRangeValue/scrollIntoView/focus/click). Pattern priority: e.g. Button -> InvokePattern; CheckBox -> TogglePattern->InvokePattern; ListItem -> SelectionItemPattern->InvokePattern; Edit -> ValuePattern. Coordinate fallback is OFF by default (allowCoordinateFallback=false) and only used as a last resort when all patterns fail - it never moves the physical mouse. forceCoordinateClick requires allowCoordinateFallback=true.",
        inputSchema: schemas.toolInputSchemas.ui_action
      },
      {
        name: "ui_wait",
        description: "Wait for a UI state change without polling screenshots. Conditions: exists/notExists/visible/hidden/enabled/disabled/valueEquals/valueContains/toggleStateEquals/selected/notSelected/expanded/collapsed/countEquals. Returns matched=false on timeout (not an error). Runs in a separate PowerShell process so it does not block the shared worker. Default poll 200ms, default timeout 10s.",
        inputSchema: schemas.toolInputSchemas.ui_wait
      },
      {
        name: "profile_list",
        description: "List available application profiles (logical-control mappings for known apps like VaporView).",
        inputSchema: schemas.toolInputSchemas.profile_list
      },
      {
        name: "profile_resolve",
        description: "Resolve a logical control name (e.g. 'mainWindow') from an app profile to a concrete UI element, trying candidate selectors in order. Returns the matched element and which selector succeeded.",
        inputSchema: schemas.toolInputSchemas.profile_resolve
      },
      {
        name: "profile_action",
        description: "Perform an action on a logical control from an app profile. Reuses ui_action internally (no pattern logic duplicated). Tries candidate selectors in order until one resolves a unique element.",
        inputSchema: schemas.toolInputSchemas.profile_action
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const { schemas, windows, profiles } = await loadRuntime();

    switch (name) {
      case "launch_app":
        return jsonResult(await windows.launchApp(parseArgs(schemas.launchAppSchema, args)));
      case "list_windows":
        return jsonResult(await windows.listWindows(parseArgs(schemas.listWindowsSchema, args)));
      case "capture_window":
        return jsonResult(await windows.captureWindow(parseArgs(schemas.captureWindowSchema, args)));
      case "capture_screen_region":
        return jsonResult(await windows.captureScreenRegion(parseArgs(schemas.captureScreenRegionSchema, args)));
      case "click_window":
        return jsonResult(await windows.clickWindow(parseArgs(schemas.clickWindowSchema, args)));
      case "click_menu_item":
        return jsonResult(await windows.clickMenuItem(parseArgs(schemas.clickMenuItemSchema, args)));
      case "move_mouse_window":
        return jsonResult(await windows.moveMouseWindow(parseArgs(schemas.moveMouseWindowSchema, args)));
      case "close_app":
        return jsonResult(await windows.closeApp(parseArgs(schemas.closeAppSchema, args).pid));
      case "type_text":
        return jsonResult(await windows.typeText(parseArgs(schemas.typeTextSchema, args)));
      case "send_key":
        return jsonResult(await windows.sendKey(parseArgs(schemas.sendKeySchema, args)));
      case "read_clipboard":
        return jsonResult(await windows.readClipboard(parseArgs(schemas.readClipboardSchema, args)));
      case "write_clipboard":
        return jsonResult(await windows.writeClipboard(parseArgs(schemas.writeClipboardSchema, args)));
      case "get_window_state":
        return jsonResult(await windows.getWindowState(parseArgs(schemas.getWindowStateSchema, args)));
      case "wait_for_window":
        return jsonResult(await windows.waitForWindow(parseArgs(schemas.waitForWindowSchema, args)));
      case "ui_inspect_tree":
        return jsonResult(await windows.inspectUiTree(parseArgs(schemas.uiInspectTreeSchema, args)));
      case "ui_query":
        return jsonResult(await windows.queryUi(parseArgs(schemas.uiQuerySchema, args)));
      case "ui_get":
        return jsonResult(await windows.getUiElement(parseArgs(schemas.uiGetSchema, args)));
      case "ui_action":
        return jsonResult(await windows.performUiAction(parseArgs(schemas.uiActionSchema, args)));
      case "ui_wait":
        return jsonResult(await windows.waitForUi(parseArgs(schemas.uiWaitSchema, args)));
      case "profile_list":
        return jsonResult(profiles.profileList());
      case "profile_resolve":
        return jsonResult(await profiles.resolveProfileControl(parseArgs(schemas.profileResolveSchema, args)));
      case "profile_action":
        return jsonResult(await profiles.performProfileAction(parseArgs(schemas.profileActionSchema, args)));
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    // Structured UIA / helper errors carry a machine-readable code. Surface
    // the code + message (not the full stack trace) so MCP clients can branch.
    if (error instanceof windows.HelperError) {
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

// Cache the computed runtime version for up to 1s. Every tools/list and every
// tool call would otherwise stat 3 files; on a busy MCP client that's a steady
// stream of syscalls for information that changes at human-edit speed.
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
    path.join(moduleRoot, "profiles", `vaporview${sourceExt}`),
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
    ]
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

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

console.error(`screenshottool-mcp ready. Default output directory: ${windows.getDefaultOutputDir()}. Hot reload: ${hotReloadEnabled ? "enabled" : "disabled"}.`);
