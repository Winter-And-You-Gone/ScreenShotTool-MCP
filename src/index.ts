#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  captureScreenRegionSchema,
  captureWindowSchema,
  clickMenuItemSchema,
  clickWindowSchema,
  closeAppSchema,
  launchAppSchema,
  listWindowsSchema,
  moveMouseWindowSchema,
  toolInputSchemas,
  typeTextSchema,
  sendKeySchema
} from "./schemas.js";
import {
  captureScreenRegion,
  captureWindow,
  clickMenuItem,
  clickWindow,
  closeApp,
  getDefaultOutputDir,
  launchApp,
  listWindows,
  moveMouseWindow,
  shutdownHelper,
  typeText,
  sendKey
} from "./windows.js";

const server = new Server(
  {
    name: "screenshottool-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "launch_app",
      description: "Launch a Windows .exe and optionally wait for its first visible window.",
      inputSchema: toolInputSchemas.launch_app
    },
    {
      name: "list_windows",
      description: "List visible top-level Windows desktop windows, optionally filtered by pid, process name, or title substring.",
      inputSchema: toolInputSchemas.list_windows
    },
    {
      name: "capture_window",
      description: "Capture a visible window by hwnd, pid, process name, or title substring. Optional region is relative to the window top-left corner.",
      inputSchema: toolInputSchemas.capture_window
    },
    {
      name: "capture_screen_region",
      description: "Capture a screen-space rectangle in physical pixels.",
      inputSchema: toolInputSchemas.capture_screen_region
    },
    {
      name: "click_window",
      description: "Post mouse click messages to a window-relative coordinate without moving the physical cursor.",
      inputSchema: toolInputSchemas.click_window
    },
    {
      name: "click_menu_item",
      description: "Invoke a native Windows menu item by menu path without moving the physical cursor or using keyboard shortcuts.",
      inputSchema: toolInputSchemas.click_menu_item
    },
    {
      name: "move_mouse_window",
      description: "Post a WM_MOUSEMOVE message to a window-relative coordinate without moving the physical cursor, useful for hover states before taking a screenshot.",
      inputSchema: toolInputSchemas.move_mouse_window
    },
    {
      name: "close_app",
      description: "Terminate a process and its descendants via taskkill /T /F.",
      inputSchema: toolInputSchemas.close_app
    },
    {
      name: "type_text",
      description: "Type text into a window via SendInput Unicode. The target window is focused first; supports any Unicode character (including CJK).",
      inputSchema: toolInputSchemas.type_text
    },
    {
      name: "send_key",
      description: "Send a keystroke with optional modifiers (alt/ctrl/shift/win) to a window via keybd_event. Use for keyboard shortcuts like Alt+F to open menus.",
      inputSchema: toolInputSchemas.send_key
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "launch_app":
        return jsonResult(await launchApp(parseArgs(launchAppSchema, args)));
      case "list_windows":
        return jsonResult(await listWindows(parseArgs(listWindowsSchema, args)));
      case "capture_window":
        return jsonResult(await captureWindow(parseArgs(captureWindowSchema, args)));
      case "capture_screen_region":
        return jsonResult(await captureScreenRegion(parseArgs(captureScreenRegionSchema, args)));
      case "click_window":
        return jsonResult(await clickWindow(parseArgs(clickWindowSchema, args)));
      case "click_menu_item":
        return jsonResult(await clickMenuItem(parseArgs(clickMenuItemSchema, args)));
      case "move_mouse_window":
        return jsonResult(await moveMouseWindow(parseArgs(moveMouseWindowSchema, args)));
      case "close_app":
        return jsonResult(await closeApp(parseArgs(closeAppSchema, args).pid))
      case "type_text":
        return jsonResult(await typeText(parseArgs(typeTextSchema, args)))
      case "send_key":
        return jsonResult(await sendKey(parseArgs(sendKeySchema, args)))
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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    shutdownHelper();
    process.exit(0);
  });
}
process.once("exit", () => {
  shutdownHelper();
});

console.error(`screenshottool-mcp ready. Default output directory: ${getDefaultOutputDir()}`);
