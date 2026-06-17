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

type RuntimeModules = {
  version: string;
  schemas: typeof SchemasModule;
  windows: typeof WindowsModule;
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
        description: "Capture a window by hwnd, pid, process name, or title substring. 'screen' mode copies visible screen pixels (subject to occlusion — captures whatever is on top). 'print' mode uses PrintWindow (works on occluded/minimized windows, but cannot capture separate top-level windows like Qt tooltips, popups, or Electron child windows). noActivate avoids stealing focus.",
        inputSchema: schemas.toolInputSchemas.capture_window
      },
      {
        name: "capture_screen_region",
        description: "Capture a screen-space rectangle in physical pixels. Copies whatever is currently visible at that screen region — if other windows occlude the target, the occluder is captured instead. Subject to multi-monitor coordinate and DPI considerations.",
        inputSchema: schemas.toolInputSchemas.capture_screen_region
      },
      {
        name: "click_window",
        description: "Post mouse click messages to a window-relative coordinate without moving the physical cursor.",
        inputSchema: schemas.toolInputSchemas.click_window
      },
      {
        name: "click_menu_item",
        description: "Invoke a native Windows menu item by menu path without moving the physical cursor or using keyboard shortcuts.",
        inputSchema: schemas.toolInputSchemas.click_menu_item
      },
      {
        name: "move_mouse_window",
        description: "Post a WM_MOUSEMOVE message to a window-relative coordinate without moving the physical cursor. NOTE: does not trigger tooltips in Qt/Electron apps — those read the real system cursor position (QCursor::pos()), not window messages. For reliable hover-driven UI in such apps, use a programmatic test hook or real cursor instead.",
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
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const { schemas, windows } = await loadRuntime();

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
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
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

  runtimeCache = { version, schemas, windows };
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
