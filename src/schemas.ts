import { z } from "zod";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const optionalTimeout = z.number().int().min(100).max(120000).optional();
const namedSendKeys = [
  "esc",
  "escape",
  "tab",
  "enter",
  "return",
  "space",
  "left",
  "up",
  "right",
  "down",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "backspace",
  "bs",
  "delete",
  "del",
  "home",
  "end",
  "pageup",
  "pagedown"
] as const;
const supportedSendKeyNames = new Set<string>(namedSendKeys);
const printableAsciiChar = /^[\x20-\x7E]$/u;
const sendKeyValue = z.string().min(1).refine(
  (key) => supportedSendKeyNames.has(key.toLowerCase()) || printableAsciiChar.test(key),
  "key must be a supported named key or a single printable ASCII character."
);

export const regionSchema = z.object({
  x: nonNegativeInt,
  y: nonNegativeInt,
  width: positiveInt,
  height: positiveInt
});

export const launchAppSchema = z.object({
  exePath: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().min(1).optional(),
  waitForWindow: z.boolean().optional().default(true),
  timeoutMs: optionalTimeout.default(10000),
  startMinimized: z.boolean().optional().default(false),
  noActivate: z.boolean().optional().default(false)
});

export const listWindowsSchema = z.object({
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional()
});

export const captureWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  region: regionSchema.optional(),
  focus: z.boolean().optional().default(true),
  captureMethod: z.enum(["screen", "print"]).optional().default("screen"),
  noActivate: z.boolean().optional().default(false),
  outputPath: z.string().min(1).optional()
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const captureScreenRegionSchema = z.object({
  region: regionSchema,
  outputPath: z.string().min(1).optional()
});

export const clickWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  x: nonNegativeInt,
  y: nonNegativeInt,
  button: z.enum(["left", "right", "middle"]).optional().default("left"),
  doubleClick: z.boolean().optional().default(false),
  delayMs: z.number().int().min(0).max(10000).optional().default(200)
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const moveMouseWindowSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  x: nonNegativeInt,
  y: nonNegativeInt,
  delayMs: z.number().int().min(0).max(10000).optional().default(200)
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const clickMenuItemSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  path: z.array(z.string().min(1)).min(1),
  delayMs: z.number().int().min(0).max(10000).optional().default(500)
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export const closeAppSchema = z.object({
  pid: z.number().int().positive()
})

export const typeTextSchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  text: z.string().min(1),
  delayMs: z.number().int().min(0).max(10000).optional().default(50),
  pressMs: z.number().int().min(0).max(5000).optional().default(30),
  noActivate: z.boolean().optional().default(false)
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
)

export const sendKeySchema = z.object({
  hwnd: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  pid: z.number().int().positive().optional(),
  processName: z.string().min(1).optional(),
  titleContains: z.string().min(1).optional(),
  key: sendKeyValue,
  modifiers: z.array(z.enum(["alt", "ctrl", "shift", "win"])).optional().default([]),
  delayMs: z.number().int().min(0).max(10000).optional().default(50),
  pressMs: z.number().int().min(0).max(5000).optional().default(30),
  noActivate: z.boolean().optional().default(false)
}).refine(
  (value) => value.hwnd !== undefined || value.pid !== undefined || value.processName !== undefined || value.titleContains !== undefined,
  "Provide at least one of hwnd, pid, processName, or titleContains."
);

export type LaunchAppInput = z.infer<typeof launchAppSchema>;
export type ListWindowsInput = z.infer<typeof listWindowsSchema>;
export type CaptureWindowInput = z.infer<typeof captureWindowSchema>;
export type CaptureScreenRegionInput = z.infer<typeof captureScreenRegionSchema>;
export type ClickWindowInput = z.infer<typeof clickWindowSchema>;
export type MoveMouseWindowInput = z.infer<typeof moveMouseWindowSchema>;
export type ClickMenuItemInput = z.infer<typeof clickMenuItemSchema>;
export type CloseAppInput = z.infer<typeof closeAppSchema>
export type TypeTextInput = z.infer<typeof typeTextSchema>
export type SendKeyInput = z.infer<typeof sendKeySchema>;

export const toolInputSchemas = {
  launch_app: {
    type: "object",
    properties: {
      exePath: { type: "string", description: "Absolute path to the .exe to launch." },
      args: { type: "array", items: { type: "string" }, description: "Process arguments as an array." },
      cwd: { type: "string", description: "Optional working directory for the process." },
      waitForWindow: { type: "boolean", default: true, description: "Wait for the first visible window for the process." },
      timeoutMs: { type: "integer", minimum: 100, maximum: 120000, default: 10000 },
      startMinimized: { type: "boolean", default: false, description: "Start the process minimized. The window will not appear on top." },
      noActivate: { type: "boolean", default: false, description: "When true, the window is placed at the bottom of the z-order without receiving focus. Combines well with startMinimized for fully non-intrusive launches." }
    },
    required: ["exePath"],
    additionalProperties: false
  },
  list_windows: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string", description: "Process name with or without .exe." },
      titleContains: { type: "string", description: "Case-insensitive title substring." }
    },
    additionalProperties: false
  },
  capture_window: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app. Numbers are accepted at runtime, but strings are safest for Codex." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      region: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1 },
          height: { type: "integer", minimum: 1 }
        },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
        description: "Optional rectangle relative to the target window top-left corner."
      },
      focus: { type: "boolean", default: true, description: "Bring the window to the foreground before capturing. Set false to preserve open menus, popups, or transient UI." },
      captureMethod: { type: "string", enum: ["screen", "print"], default: "screen", description: "Capture method: 'screen' uses CopyFromScreen (needs visible area), 'print' uses PrintWindow API (captures window content even behind other windows)." },
      noActivate: { type: "boolean", default: false, description: "When true with captureMethod 'screen', the window is raised above overlapping windows without stealing keyboard focus, then restored after capture." },
      outputPath: { type: "string", description: "Optional absolute PNG output path." }
    },
    additionalProperties: false
  },
  capture_screen_region: {
    type: "object",
    properties: {
      region: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1 },
          height: { type: "integer", minimum: 1 }
        },
        required: ["x", "y", "width", "height"],
        additionalProperties: false,
        description: "Screen-space rectangle in physical pixels."
      },
      outputPath: { type: "string", description: "Optional absolute PNG output path." }
    },
    required: ["region"],
    additionalProperties: false
  },
  click_window: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app. Numbers are accepted at runtime, but strings are safest for Codex." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      x: { type: "integer", minimum: 0, description: "X coordinate relative to the target window top-left corner." },
      y: { type: "integer", minimum: 0, description: "Y coordinate relative to the target window top-left corner." },
      button: { type: "string", default: "left", description: "Mouse button: left, right, or middle." },
      doubleClick: { type: "boolean", default: false },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 200, description: "Delay after posting mouse messages, useful before taking the next screenshot." },
    },
    required: ["x", "y"],
    additionalProperties: false
  },
  move_mouse_window: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app. Numbers are accepted at runtime, but strings are safest for Codex." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      x: { type: "integer", minimum: 0, description: "X coordinate relative to the target window top-left corner." },
      y: { type: "integer", minimum: 0, description: "Y coordinate relative to the target window top-left corner." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 200, description: "Delay after posting WM_MOUSEMOVE, useful before taking the next screenshot." }
    },
    required: ["x", "y"],
    additionalProperties: false
  },
  click_menu_item: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app. Numbers are accepted at runtime, but strings are safest for Codex." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      path: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "Native menu path, for example [\"帮助\", \"关于\"]. Matching ignores accelerator markers and is case-insensitive."
      },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 500, description: "Delay after invoking the menu command." }
    },
    required: ["path"],
    additionalProperties: false
  },
  close_app: {
    type: "object",
    properties: {
      pid: { type: "integer", minimum: 1, description: "Process ID. taskkill /T /F is used, which terminates the entire process tree (the target plus any child processes it spawned)." }
    },
    required: ["pid"],
    additionalProperties: false
  },
  type_text: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      text: { type: "string", minLength: 1, description: "Text to type into the target window. Sent via SendInput Unicode, so any Unicode character including CJK is supported." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 50, description: "Delay between keystrokes in milliseconds." },
      pressMs: { type: "integer", minimum: 0, maximum: 5000, default: 30, description: "Duration of each key press in milliseconds." },
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_CHAR messages via PostMessage instead of SendInput, so the target window never needs focus. Some applications may not respond to posted messages." }
    },
    required: ["text"],
    additionalProperties: false
  },
  send_key: {
    type: "object",
    properties: {
      hwnd: { type: "string", description: "Window handle from list_windows or launch_app." },
      pid: { type: "integer", minimum: 1 },
      processName: { type: "string" },
      titleContains: { type: "string" },
      key: {
        anyOf: [
          { type: "string", enum: namedSendKeys },
          { type: "string", pattern: "^[ -~]$" }
        ],
        description: "Key name to send. Supports single printable ASCII characters and named keys: esc, tab, enter, space, arrows, f1-f12, backspace, delete, home, end, pageup, pagedown."
      },
      modifiers: { type: "array", items: { type: "string", enum: ["alt", "ctrl", "shift", "win"] }, description: "Modifier keys to hold during the keypress." },
      delayMs: { type: "integer", minimum: 0, maximum: 10000, default: 50 },
      pressMs: { type: "integer", minimum: 0, maximum: 5000, default: 30 },
      noActivate: { type: "boolean", default: false, description: "When true, sends WM_KEYDOWN/WM_KEYUP via PostMessage instead of keybd_event, so the target window never needs focus. Some applications may not respond to posted messages." }
    },
    required: ["key"],
    additionalProperties: false
  }
} as const;
