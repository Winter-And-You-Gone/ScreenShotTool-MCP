// Unified tool contracts.
//
// Every MCP tool exposed by this server has exactly one ToolContract entry:
// description, inputSchema (JSON Schema, served in tools/list), outputSchema
// (JSON Schema for the SUCCESS result value), pipe-safe fields (fields that
// may be referenced by later pipeline steps), and annotations (readOnly,
// destructive, idempotent, retrySafe, async).
//
// Output schemas are validated at runtime (see outputs.ts) every time a tool
// result is consumed by a pipeline step, so a malformed result can never flow
// into a later step (TOOL_OUTPUT_SCHEMA_MISMATCH).

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  const?: unknown;
  description?: string;
  additionalProperties?: boolean;
  // The validated subset (workflow inputSchemas + output contracts).
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type ToolAnnotations = {
  // Read-only: never changes the target process state.
  readOnly?: boolean;
  // Destructive: may close/terminate/irreversibly modify the target.
  destructive?: boolean;
  // Idempotent: repeating the call with the same args is safe.
  idempotent?: boolean;
  // RetrySafe: transient failures may be retried automatically.
  retrySafe?: boolean;
  // Async-ish: the tool fires an action whose completion must be verified by
  // a postcondition (expect) before the step can be considered done.
  needsExpect?: boolean;
};

export type ToolContract = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  schemaVersion: number;
  // Top-level fields of the success result that are safe (non-sensitive) to
  // reference from later pipeline steps via ${id.field}.
  pipeSafeFields: string[];
  annotations?: ToolAnnotations;
};

// ── MCP tools/list exposure ──
//
// The MCP SDK (>= 1.10) supports outputSchema + annotations natively in
// tools/list. The protocol requires an OBJECT-root outputSchema (it describes
// the structuredContent object), so array tools expose their array under
// "items" - matching the structuredContent wrapper and the raw value used by
// ${N.path} references (see outputs.ts array-compat).
//
// Internal-only annotations (retrySafe, needsExpect) are NOT exposed through
// tools/list; they are available via tool_contract_describe.

export type McpToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

// Map internal annotations to the MCP standard hints.
export function toMcpToolAnnotations(annotations: ToolAnnotations | undefined): McpToolAnnotations {
  if (!annotations) return {};
  const out: McpToolAnnotations = {};
  if (annotations.readOnly !== undefined) out.readOnlyHint = annotations.readOnly;
  if (annotations.destructive !== undefined) out.destructiveHint = annotations.destructive;
  if (annotations.idempotent !== undefined) out.idempotentHint = annotations.idempotent;
  // Every tool in this server operates on the live desktop, which changes
  // independently of the server - open-world is the honest default.
  out.openWorldHint = true;
  return out;
}

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: McpToolAnnotations;
  _meta?: Record<string, unknown>;
};

// Build the tools/list entry for a contract. pipeSafeFields ride along in
// _meta (a protocol-sanctioned extension field), so clients that know the
// convention can read them without tools/list being rejected by clients that
// ignore unknown top-level fields.
export function toMcpToolDefinition(contract: ToolContract): McpToolDefinition {
  return {
    name: contract.name,
    description: contract.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    annotations: toMcpToolAnnotations(contract.annotations),
    _meta: {
      pipeSafeFields: contract.pipeSafeFields
    }
  };
}

// Derive example result paths for tool_contract_describe from the output
// schema + pipeSafeFields. Success-schema lookups unwrap the withToolError
// wrapper (the error envelope has no pipe-safe fields).
export function contractExamples(contract: ToolContract): Array<{ resultPath: string; type: string }> {
  const examples: Array<{ resultPath: string; type: string }> = [];
  const successSchema = unwrapToolError(contract.outputSchema);
  for (const field of contract.pipeSafeFields) {
    const prop = successSchema?.properties?.[field];
    if (!prop) continue;
    const type = prop.type ?? (prop.anyOf ? "any" : "any");
    examples.push({ resultPath: field, type });
  }
  return examples;
}

// Helper to build a JSON Schema object with required fields, keeping the
// table below terse.
const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  description?: string
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  ...(description ? { description } : {})
});

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const num = (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) });
const int = (description?: string): JsonSchema => ({ type: "integer", ...(description ? { description } : {}) });
const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) });
const any = (description?: string): JsonSchema => ({ ...(description ? { description } : {}) });
const arr = (items: JsonSchema, description?: string): JsonSchema => ({
  type: "array",
  items,
  ...(description ? { description } : {})
});
const en = (values: unknown[], description?: string): JsonSchema => ({
  enum: values,
  ...(description ? { description } : {})
});

// ── Unified business-error output shape ──
//
// Business errors (McpUiError and its subclasses) are returned as MCP
// isError results whose structuredContent carries { success:false, error:
// { code, message, details?, suggestion?, retryable? } }. Every tool's
// outputSchema must ACCEPT this shape (via withToolError) so the client never
// sees "Structured content does not match the tool's output schema" for a
// real business failure.
//
// Tools whose SUCCESS result already IS a { success:false, error } shape
// (run_steps / profile_run_steps / run_workflow / continue_run) do NOT wrap:
// their existing outputSchema already covers both outcomes.

export const toolErrorEnvelope: JsonSchema = obj(
  {
    success: { const: false },
    error: obj(
      {
        code: str(),
        message: str(),
        details: any(),
        suggestion: str(),
        retryable: bool()
      },
      ["code", "message"],
      "Structured business error: code + message always; details, suggestion, and retryable when known."
    )
  },
  ["success", "error"],
  "Business error envelope: { success:false, error: { code, message, details?, suggestion?, retryable? } }."
);

// Wrap a success schema so the tool's public outputSchema accepts EITHER the
// success result OR the unified business-error envelope. The root keeps
// type:"object" (MCP requires an object-root outputSchema); every branch is
// an object, so both outcomes validate and the client contract stays honest.
export function withToolError(successSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    anyOf: [
      successSchema,
      toolErrorEnvelope
    ],
    description: `Success result OR business error envelope: { success:false, error: { code, message, details?, suggestion?, retryable? } }.`
  };
}

// Unwrap a withToolError-wrapped schema to the SUCCESS branch (the first
// anyOf branch). Used by tools that derive example paths from the success
// shape (contractExamples) - the error envelope has no pipe-safe fields.
export function unwrapToolError(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (schema?.anyOf && schema.anyOf.length > 0) {
    return schema.anyOf[0];
  }
  return schema;
}

// Shared fragments ---------------------------------------------------------

const windowInfo = obj(
  {
    hwnd: str(),
    title: str(),
    pid: int(),
    processName: str(),
    className: str(),
    rect: any(),
    visible: bool(),
    iconic: bool()
  },
  ["hwnd", "title", "pid", "processName", "className", "rect"]
);

// Business errors may or may not carry a machine code; message is always
// present.
const errorShape = obj(
  {
    code: str(),
    message: str(),
    details: any()
  },
  ["message"]
);

const stepResult = obj(
  {
    tool: str(),
    success: bool(),
    result: any(),
    error: errorShape,
    expectResult: any(),
    stateSettled: bool()
  },
  ["tool", "success"]
);

// Stable public output fields (spec): schemaVersion, success, pid, hwnd,
// title, found, count, element, elements, value, matched, timedOut, code,
// message, details.

// ── Window / process tools ──

const launchAppOutput = withToolError(obj(
  {
    pid: int(),
    window: {
      anyOf: [
        windowInfo,
        { type: "null" }
      ],
      description: "First visible window, or null when waitForWindow=false."
    }
  },
  ["pid"],
  "launch_app success result."
));

const listWindowsOutput = withToolError(obj(
  {
    items: arr(windowInfo, "Window list.")
  },
  ["items"],
  "list_windows success result: { items: WindowInfo[] }. The raw array is also returned as the step result (${N.path} indexes it directly)."
));

const captureOutput = withToolError(obj(
  {
    path: str(),
    width: int(),
    height: int(),
    target: str(),
    rect: any(),
    timestamp: str()
  },
  ["path", "width", "height", "target", "rect", "timestamp"]
));

// Unified interaction-impact metadata reported by high-level tools and the
// aggregate pipeline result. Only hwnd values + booleans - never titles,
// process info, or sensitive data.
const interactionShape = obj(
  {
    requestedMode: en(["auto", "background", "foregroundDemo"]),
    effectiveMode: en(["background", "foregroundDemo"]),
    backgroundPolicy: en(["safe", "bestEffort", "foregroundRequired"]),
    method: str(),
    foregroundBefore: str(),
    foregroundAfter: str(),
    foregroundChanged: bool(),
    foregroundChangedDuringRun: bool(),
    foregroundRestored: bool(),
    targetActivated: bool(),
    physicalCursorMoved: bool()
  },
  ["requestedMode", "effectiveMode", "foregroundChanged", "targetActivated", "physicalCursorMoved"],
  "Interaction-impact report: mode resolution, foreground changes (final state and during-run changes), activation and physical-cursor movement for this call."
);

// capture_window carries the interaction report (capture_screen_region does
// not: it has no target window and never touches the foreground).
const captureWindowOutput = withToolError(obj(
  {
    path: str(),
    width: int(),
    height: int(),
    target: str(),
    rect: any(),
    timestamp: str(),
    interaction: interactionShape
  },
  ["path", "width", "height", "target", "rect", "timestamp", "interaction"]
));

const clickOutput = withToolError(obj(
  {
    clicked: bool(),
    target: str(),
    hwnd: str(),
    title: str(),
    pid: int(),
    button: str(),
    doubleClick: bool(),
    method: str(),
    messageTarget: any(),
    nativeMenu: any(),
    windowPoint: any(),
    screenPoint: any(),
    timestamp: str()
  },
  ["clicked", "target", "hwnd", "title", "pid", "button", "doubleClick", "method", "timestamp"]
));

const moveMouseOutput = withToolError(obj(
  {
    moved: bool(),
    target: str(),
    hwnd: str(),
    title: str(),
    pid: int(),
    method: str(),
    windowPoint: any(),
    screenPoint: any(),
    timestamp: str()
  },
  ["moved", "target", "hwnd", "title", "pid", "method", "timestamp"]
));

const clickMenuItemOutput = withToolError(obj(
  {
    clicked: bool(),
    target: str(),
    hwnd: str(),
    title: str(),
    pid: int(),
    method: str(),
    menuPath: arr(any()),
    commandId: int(),
    timestamp: str()
  },
  ["clicked", "target", "hwnd", "title", "pid", "method", "menuPath", "commandId", "timestamp"]
));

const closeAppOutput = withToolError(obj(
  {
    pid: int(),
    closed: bool()
  },
  ["pid", "closed"]
));

const typeTextOutput = withToolError(obj(
  {
    typed: bool(),
    target: str(),
    hwnd: str(),
    title: str(),
    pid: int(),
    textLength: int(),
    skipped: arr(str()),
    timestamp: str()
  },
  ["typed", "target", "hwnd", "title", "pid", "textLength", "skipped", "timestamp"]
));

const sendKeyOutput = withToolError(obj(
  {
    sent: bool(),
    key: str(),
    modifiers: arr(str()),
    target: str(),
    hwnd: str(),
    title: str(),
    pid: int(),
    timestamp: str()
  },
  ["sent", "key", "modifiers", "target", "hwnd", "title", "pid", "timestamp"]
));

const readClipboardOutput = withToolError(obj(
  {
    available: bool(),
    text: str(),
    length: int(),
    timestamp: str()
  },
  ["available", "text", "length", "timestamp"]
));

const writeClipboardOutput = withToolError(obj(
  {
    written: bool(),
    length: int(),
    timestamp: str()
  },
  ["written", "length", "timestamp"]
));

const windowStateOutput = withToolError(obj(
  {
    hwnd: str(),
    title: str(),
    pid: int(),
    processName: str(),
    className: str(),
    visible: bool(),
    minimized: bool(),
    maximized: bool(),
    foreground: bool(),
    enabled: bool(),
    topmost: bool(),
    cloaked: bool(),
    timestamp: str()
  },
  ["hwnd", "title", "pid", "processName", "className", "visible", "timestamp"]
));

const waitForWindowOutput = withToolError(obj(
  {
    found: bool(),
    mode: str(),
    window: { anyOf: [windowInfo, { type: "null" }] },
    elapsedMs: int(),
    timeoutMs: int(),
    timestamp: str()
  },
  ["found", "mode", "window", "elapsedMs", "timestamp"]
));

// ── UIA tools ──

const inspectTreeOutput = withToolError(obj(
  {
    roots: arr(any()),
    nodes: arr(any()),
    visitedNodes: int(),
    returnedNodes: int(),
    truncated: bool(),
    maxDepth: int(),
    maxNodes: int(),
    elapsedMs: int()
  },
  ["roots", "nodes", "visitedNodes", "returnedNodes", "truncated", "elapsedMs"]
));

const queryOutput = withToolError(obj(
  {
    found: bool(),
    count: int(),
    elements: arr(any()),
    truncated: bool(),
    visitedNodes: int(),
    elapsedMs: int()
  },
  ["found", "count", "elements", "truncated", "visitedNodes", "elapsedMs"]
));

// Nullable element fields: UIA providers report null for unsupported
// patterns (e.g. value/toggleState/selected on a plain Pane), so the schema
// must allow null on every optional state field.
const nullableStr = (): JsonSchema => ({ anyOf: [{ type: "string" }, { type: "null" }] });
const nullableInt = (): JsonSchema => ({ anyOf: [{ type: "integer" }, { type: "null" }] });
const nullableBool = (): JsonSchema => ({ anyOf: [{ type: "boolean" }, { type: "null" }] });

const getOutput = withToolError(obj(
  {
    found: bool(),
    element: {
      anyOf: [
        {
          type: "object",
          properties: {
            value: nullableStr(),
            selected: nullableBool(),
            // Real pre-action selection state when the provider exposes it
            // (never derived from action arguments).
            selectedName: nullableStr(),
            selectedIndex: nullableInt(),
            toggleState: { anyOf: [en(["On", "Off", "Indeterminate"]), { type: "null" }] },
            isPassword: bool(),
            valueProtected: bool()
          }
        },
        { type: "null" }
      ],
      description: "Matched element state, or null when not found. selectedName/selectedIndex are best-effort original selection info, present only when the provider exposes them."
    },
    elapsedMs: int()
  },
  ["found", "element", "elapsedMs"]
));

const actionOutput = withToolError(obj(
  {
    success: bool(),
    method: str(),
    coordinateFallbackUsed: bool(),
    physicalCursorMoved: bool(),
    fallbackReason: str(),
    rootHwnd: str(),
    before: any(),
    after: any(),
    elapsedMs: int()
  },
  ["success", "method", "coordinateFallbackUsed", "physicalCursorMoved", "elapsedMs"]
));

const waitOutput = withToolError(obj(
  {
    matched: bool(),
    condition: str(),
    lastObservation: any(),
    elapsedMs: int(),
    timeoutMs: int(),
    pollIntervalMs: int(),
    timedOut: bool()
  },
  ["matched", "condition", "elapsedMs", "timeoutMs", "pollIntervalMs", "timedOut"]
));

const catalogControl = obj(
  {
    controlType: str(),
    automationId: str(),
    name: str(),
    className: str(),
    frameworkId: str(),
    enabled: bool(),
    visible: bool(),
    rootHwnd: str(),
    recommendedSelector: any(),
    selectorConfidence: str(),
    selectorVerified: bool(),
    selectorMatchCount: int(),
    supportedActions: arr(str()),
    patterns: arr(str()),
    profileControl: str()
  },
  ["controlType", "automationId", "name", "selectorConfidence"]
);

const catalogOutput = withToolError(obj(
  {
    totalNodes: int(),
    actionableNodes: int(),
    stableAutomationIdNodes: int(),
    nameOnlyNodes: int(),
    unsupportedNodes: int(),
    controlTypes: any(),
    patterns: any(),
    unmappedActionableControls: arr(any()),
    controls: arr(catalogControl),
    truncated: bool(),
    elapsedMs: int()
  },
  ["totalNodes", "actionableNodes", "unsupportedNodes", "controls", "truncated", "elapsedMs"]
));

// ── Profile tools ──

const profileListOutput = withToolError(obj(
  {
    profiles: arr(
      obj(
        {
          id: str(),
          displayName: str(),
          processNames: arr(str()),
          controlCount: int(),
          source: str()
        },
        ["id", "displayName", "processNames", "controlCount"]
      )
    )
  },
  ["profiles"]
));

const profileResolveOutput = withToolError(obj(
  {
    profile: str(),
    control: str(),
    found: bool(),
    selectorUsed: any(),
    candidateIndex: int(),
    confidence: str(),
    notes: str(),
    candidatesTried: arr(any()),
    element: any()
  },
  ["profile", "control", "found", "candidatesTried"]
));

const profileActionOutput = withToolError(obj(
  {
    profile: str(),
    control: str(),
    selectorUsed: any(),
    confidence: str(),
    notes: str(),
    result: any(),
    interaction: interactionShape
  },
  ["profile", "control", "result", "interaction"]
));

const profileLaunchOutput = withToolError(obj(
  {
    profile: str(),
    targetRef: str(),
    pid: int(),
    hwnd: str(),
    title: str(),
    startedByMcp: bool(),
    reused: bool(),
    uiaRootAvailable: bool(),
    manifestLevel: str(),
    interaction: interactionShape
  },
  ["profile", "targetRef", "pid", "startedByMcp", "uiaRootAvailable", "interaction"],
  "profile_launch success result (stable fields: profile, targetRef, pid, hwnd, title, startedByMcp, reused, uiaRootAvailable). targetRef is REQUIRED: the preferred target binding for later profile actions (hwnd may be absent when the launch did not wait for a window)."
));

// ── App Pack tools ──

const appPackSummary = obj(
  {
    id: str(),
    displayName: str(),
    version: str(),
    source: str(),
    catalogVisibility: str(),
    controls: int(),
    workflows: int(),
    valid: bool(),
    hidden: bool(),
    error: str()
  },
  ["id", "displayName", "version", "source", "catalogVisibility", "controls", "workflows", "valid"]
);

const appPackListOutput = withToolError(obj(
  {
    packs: arr(appPackSummary)
  },
  ["packs"]
));

const semanticPageSummary = obj(
  {
    id: str(),
    displayName: str(),
    aliases: arr(str()),
    navigationControl: str(),
    rootControl: str(),
    scrollContainers: arr(str()),
    components: arr(str()),
    readyMarkers: arr(any())
  },
  ["id"]
);

const semanticSelectionGroup = obj(
  {
    id: str(),
    role: str(),
    parent: str(),
    members: arr(str()),
    selectionMode: str()
  },
  ["id", "members"]
);

const semanticComponentSummary = obj(
  {
    id: str(),
    displayName: str(),
    aliases: arr(str()),
    page: str(),
    role: str(),
    rootControl: str(),
    children: arr(str()),
    mappingStatus: str(),
    reason: str()
  },
  ["id"]
);

const semanticRelationship = obj(
  {
    control: str(),
    page: str(),
    parent: str(),
    group: str(),
    role: str(),
    scrollContainer: str(),
    postconditions: arr(any())
  },
  ["control"]
);

const appPackDescribeOutput = withToolError(obj(
  {
    pack: str(),
    displayName: str(),
    version: str(),
    source: str(),
    profile: any(),
    controls: arr(any()),
    actions: arr(any()),
    workflows: arr(any()),
    limitations: arr(str()),
    pipeSafe: any(),
    defaultInteractionMode: str(),
    usageGuidance: any(),
    // Semantic map (present when the pack declares pages.json/components.json
    // and the caller requests them via include, or by default in compact mode).
    pages: arr(semanticPageSummary),
    selectionGroups: arr(semanticSelectionGroup),
    components: arr(semanticComponentSummary),
    relationships: arr(semanticRelationship)
  },
  ["pack", "displayName", "version", "source", "controls", "workflows"]
));

const semanticMatch = obj(
  {
    control: str(),
    group: str(),
    score: num(),
    reason: str()
  },
  ["control", "score", "reason"]
);

const semanticScope = obj(
  {
    within: str(),
    resolved: bool()
  },
  ["resolved"]
);

const relationshipEvidence = obj(
  {
    from: str(),
    to: str(),
    relation: str()
  },
  ["from", "to", "relation"]
);

const resolveSemanticControlOutput = withToolError(obj(
  {
    profile: str(),
    query: str(),
    matches: arr(semanticMatch),
    suggestedPath: arr(str()),
    pathAmbiguous: bool(),
    scope: semanticScope,
    relationshipEvidence: arr(relationshipEvidence)
  },
  ["profile", "query", "matches", "pathAmbiguous"]
));

const validationIssue = obj(
  {
    file: str(),
    path: str(),
    code: str(),
    message: str(),
    suggestion: str()
  },
  ["path", "code", "message"]
);

const appPackValidateOutput = withToolError(obj(
  {
    pack: str(),
    valid: bool(),
    errors: arr(validationIssue),
    warnings: arr(validationIssue),
    checked: arr(str())
  },
  ["pack", "valid", "errors", "warnings"]
));

const appPackReloadOutput = withToolError(obj(
  {
    reloaded: bool(),
    loadedPacks: arr(appPackSummary),
    errors: arr(
      obj(
        {
          source: str(),
          pack: str(),
          code: str(),
          message: str()
        },
        ["code", "message"]
      )
    )
  },
  ["reloaded", "loadedPacks"]
));

const appPackProbeOutput = withToolError(obj(
  {
    pid: int(),
    hwnd: str(),
    title: str(),
    windowCandidates: arr(any()),
    controls: arr(any()),
    patterns: any(),
    menuCandidates: arr(any()),
    inputCandidates: arr(any()),
    dialogCandidates: arr(any()),
    unreachableControls: arr(any()),
    draft: any(),
    tempDir: str(),
    warnings: arr(str())
  },
  ["pid", "controls"]
));

// ── Pipeline / workflow tools ──

const runStepsOutput = obj(
  {
    schemaVersion: int(),
    success: bool(),
    total: int(),
    completed: int(),
    stoppedAtIndex: { anyOf: [{ type: "integer" }, { type: "null" }] },
    runId: str(),
    status: str(),
    stoppedAt: str(),
    completedSteps: arr(str()),
    exports: any(),
    steps: arr(stepResult),
    error: errorShape,
    finallyResults: arr(any()),
    restoreResults: arr(any()),
    interaction: interactionShape
  },
  ["schemaVersion", "success", "total", "completed", "stoppedAtIndex", "steps"]
);

const validateStepsOutput = withToolError(obj(
  {
    valid: bool(),
    errors: arr(
      obj(
        {
          stepId: str(),
          path: str(),
          code: str(),
          message: str(),
          suggestion: str()
        },
        ["path", "code", "message"]
      )
    ),
    warnings: arr(any()),
    estimatedMaxDurationMs: int(),
    toolCount: int(),
    maxSteps: int()
  },
  ["valid", "errors", "warnings", "estimatedMaxDurationMs"]
));

const workflowCatalogOutput = withToolError(obj(
  {
    defaultInteractionMode: str(),
    workflows: arr(
      obj(
        {
          id: str(),
          description: str(),
          safe: bool(),
          tested: bool(),
          restoresState: bool(),
          requiredInputs: arr(str()),
          visibility: str(),
          backgroundPolicy: str(),
          foregroundRequiredSteps: arr(
            obj(
              {
                stepId: str(),
                backgroundPolicy: str(),
                suggestedMode: str()
              },
              ["backgroundPolicy", "suggestedMode"]
            )
          )
        },
        ["id", "description", "safe", "tested", "restoresState", "requiredInputs"]
      )
    )
  },
  ["workflows"]
));

const runWorkflowOutput = obj(
  {
    schemaVersion: int(),
    success: bool(),
    runId: str(),
    pack: str(),
    workflow: str(),
    status: str(),
    stoppedAt: str(),
    completedSteps: arr(str()),
    exports: any(),
    steps: arr(stepResult),
    error: errorShape,
    finallyResults: arr(any()),
    interaction: interactionShape
  },
  ["schemaVersion", "success", "runId", "pack", "workflow", "steps"]
);

const continueRunOutput = obj(
  {
    schemaVersion: int(),
    success: bool(),
    runId: str(),
    status: str(),
    continuedFrom: str(),
    stoppedAt: str(),
    completedSteps: arr(str()),
    exports: any(),
    steps: arr(stepResult),
    error: errorShape,
    interaction: interactionShape
  },
  ["schemaVersion", "success", "runId", "status"]
);

// ── Contract table ──

import { toolInputSchemas } from "./schemas.js";

export const contracts: Record<string, ToolContract> = {
  launch_app: {
    name: "launch_app",
    description: "Low-level generic launch tool. Do NOT use when a matching App Pack/Profile is available - prefer profile_launch (it waits for the profile's stable main window and returns a targetRef). May return an initial or splash-window process identity rather than the final profile main window. Launch a Windows .exe and optionally wait for its first visible window. Use noActivate for best-effort background launch. Returns: pid:number, window:{hwnd,title,pid,processName,className}|null. Pipe-safe: pid, window.hwnd, window.title.",
    inputSchema: toolInputSchemas.launch_app as unknown as JsonSchema,
    outputSchema: launchAppOutput,
    schemaVersion: 1,
    pipeSafeFields: ["pid", "window"],
    annotations: { idempotent: false, retrySafe: false, needsExpect: false }
  },
  list_windows: {
    name: "list_windows",
    description: "List visible top-level Windows desktop windows, optionally filtered by pid/processName/titleContains. Returns { items: WindowInfo[] } where each item has hwnd,title,pid,processName,className,rect. structuredContent is {items:[...]}; the step result is the raw array (${0.0.hwnd} indexes it). Pipe-safe: items, items[i].hwnd, items[i].pid, items[i].title.",
    inputSchema: toolInputSchemas.list_windows as unknown as JsonSchema,
    outputSchema: listWindowsOutput,
    schemaVersion: 1,
    pipeSafeFields: ["items"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  capture_window: {
    name: "capture_window",
    description: "Captures the visual contents of a target window as an image file. Use when the task requires visual content, layout inspection, rendering verification, or an image artifact - including when the user explicitly asks for a screenshot. 'print' mode uses PrintWindow (works occluded/minimized, misses separate popup/tooltip windows); 'screen' mode copies the visible screen. Capture latency depends on the target application, rendering backend, window state, and capture method; PrintWindow may require the target window to process a synchronous WM_PRINT/WM_PRINTCLIENT request. interactionMode=background forces the non-activating PrintWindow path and reports interaction metadata; capture never auto-upgrades to foreground (BACKGROUND_CAPTURE_UNAVAILABLE instead). Returns: path,width,height,target,rect,timestamp,interaction. Pipe-safe: path, interaction.",
    inputSchema: toolInputSchemas.capture_window as unknown as JsonSchema,
    outputSchema: captureWindowOutput,
    schemaVersion: 1,
    pipeSafeFields: ["path", "width", "height", "interaction"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  capture_screen_region: {
    name: "capture_screen_region",
    description: "Captures a screen-space rectangle as an image file in physical pixels. Use when the task requires visual content, layout inspection, rendering verification, or an image artifact - including when the user explicitly asks for a screenshot. Copies whatever is currently visible - occluders are captured instead of the target. Returns: path,width,height,target,rect,timestamp. Pipe-safe: path.",
    inputSchema: toolInputSchemas.capture_screen_region as unknown as JsonSchema,
    outputSchema: captureOutput,
    schemaVersion: 1,
    pipeSafeFields: ["path", "width", "height"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  click_window: {
    name: "click_window",
    description: "Posts mouse click down/up messages to a window-relative coordinate. Does NOT move the physical cursor; does NOT support drag/gestures. Returns: clicked,target,hwnd,title,pid,button,method,timestamp. Pipe-safe: clicked, hwnd, pid.",
    inputSchema: toolInputSchemas.click_window as unknown as JsonSchema,
    outputSchema: clickOutput,
    schemaVersion: 1,
    pipeSafeFields: ["clicked", "hwnd", "pid", "title"],
    annotations: { idempotent: false, retrySafe: false }
  },
  click_menu_item: {
    name: "click_menu_item",
    description: "Invoke a native Win32 menu item by path without moving the cursor. Returns: clicked,target,hwnd,title,pid,method,menuPath,commandId,timestamp. Pipe-safe: clicked, commandId.",
    inputSchema: toolInputSchemas.click_menu_item as unknown as JsonSchema,
    outputSchema: clickMenuItemOutput,
    schemaVersion: 1,
    pipeSafeFields: ["clicked", "commandId"],
    annotations: { idempotent: false, retrySafe: false }
  },
  move_mouse_window: {
    name: "move_mouse_window",
    description: "LIMITATION: posts a fake WM_MOUSEMOVE - does NOT move the real cursor, does NOT trigger Qt/Electron tooltips. Returns: moved,target,hwnd,title,pid,method,timestamp.",
    inputSchema: toolInputSchemas.move_mouse_window as unknown as JsonSchema,
    outputSchema: moveMouseOutput,
    schemaVersion: 1,
    pipeSafeFields: ["moved"],
    annotations: { idempotent: true, retrySafe: true }
  },
  close_app: {
    name: "close_app",
    description: "DESTRUCTIVE: terminate a process tree via taskkill /T /F. Returns: pid,closed. Not retryable.",
    inputSchema: toolInputSchemas.close_app as unknown as JsonSchema,
    outputSchema: closeAppOutput,
    schemaVersion: 1,
    pipeSafeFields: ["pid", "closed"],
    annotations: { destructive: true, idempotent: true, retrySafe: true }
  },
  type_text: {
    name: "type_text",
    description: "Type text via SendInput Unicode (or PostMessage WM_CHAR with noActivate). Returns: typed,target,hwnd,title,pid,textLength,skipped,timestamp. Pipe-safe: typed, pid, hwnd.",
    inputSchema: toolInputSchemas.type_text as unknown as JsonSchema,
    outputSchema: typeTextOutput,
    schemaVersion: 1,
    pipeSafeFields: ["typed", "hwnd", "pid", "textLength"],
    annotations: { idempotent: false, retrySafe: false }
  },
  send_key: {
    name: "send_key",
    description: "Send a keystroke with optional modifiers (noActivate posts WM_KEYDOWN/UP). Returns: sent,key,modifiers,target,hwnd,title,pid,timestamp. Pipe-safe: sent.",
    inputSchema: toolInputSchemas.send_key as unknown as JsonSchema,
    outputSchema: sendKeyOutput,
    schemaVersion: 1,
    pipeSafeFields: ["sent", "key"],
    annotations: { idempotent: false, retrySafe: false }
  },
  read_clipboard: {
    name: "read_clipboard",
    description: "Read current clipboard text. Returns: available:boolean, text:string, length:number. Pipe-safe: text (may be empty when unavailable).",
    inputSchema: toolInputSchemas.read_clipboard as unknown as JsonSchema,
    outputSchema: readClipboardOutput,
    schemaVersion: 1,
    pipeSafeFields: ["available", "text", "length"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  write_clipboard: {
    name: "write_clipboard",
    description: "Write text to the Windows clipboard (Unicode, CJK OK; empty string clears). Returns: written,length,timestamp. Pipe-safe: written.",
    inputSchema: toolInputSchemas.write_clipboard as unknown as JsonSchema,
    outputSchema: writeClipboardOutput,
    schemaVersion: 1,
    pipeSafeFields: ["written", "length"],
    annotations: { idempotent: true, retrySafe: true }
  },
  get_window_state: {
    name: "get_window_state",
    description: "Query window state: minimized/maximized/foreground/topmost/enabled/layered/cloaked etc. Returns: hwnd,title,pid,visible,minimized,maximized,foreground,enabled,topmost,cloaked,timestamp. Pipe-safe: hwnd, pid, visible, foreground.",
    inputSchema: toolInputSchemas.get_window_state as unknown as JsonSchema,
    outputSchema: windowStateOutput,
    schemaVersion: 1,
    pipeSafeFields: ["hwnd", "pid", "visible", "foreground", "minimized", "maximized"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  wait_for_window: {
    name: "wait_for_window",
    description: "Block until a matching window appears/disappears. Returns found=false on timeout (not an error). Returns: found, mode, window, elapsedMs. Pipe-safe: found, window.hwnd, window.pid.",
    inputSchema: toolInputSchemas.wait_for_window as unknown as JsonSchema,
    outputSchema: waitForWindowOutput,
    schemaVersion: 1,
    pipeSafeFields: ["found", "window", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  ui_inspect_tree: {
    name: "ui_inspect_tree",
    description: "DIAGNOSTIC LAST-RESORT tree inspection. Prefer profile controls (profile_action/profile_resolve) or scoped ui_query. Do NOT enumerate an entire application tree to locate a known semantic control. Read the UIA control tree of a target window (flat node list: nodeId/parentNodeId, controlType, automationId, name, patterns, boundingRect). Returns: roots[], nodes[], visitedNodes, truncated, elapsedMs. Pipe-safe: roots, nodes, elapsedMs.",
    inputSchema: toolInputSchemas.ui_inspect_tree as unknown as JsonSchema,
    outputSchema: inspectTreeOutput,
    schemaVersion: 1,
    pipeSafeFields: ["roots", "nodes", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  ui_query: {
    name: "ui_query",
    description: "SCOPED UI SEARCH - the recommended way to find elements when a Profile/App Pack control is not available. Scope with rootSelector/ancestorSelector, nameContains, fields, and maxResults instead of enumerating the whole tree. depthStrategy=auto escalates the search depth (8/16/24) until the element is found. Find UI elements matching a selector; returns up to maxResults elements with state (value/toggleState/selected/rangeValue). Returns: found, count, elements[], truncated, elapsedMs. Pipe-safe: found, count, elements.",
    inputSchema: toolInputSchemas.ui_query as unknown as JsonSchema,
    outputSchema: queryOutput,
    schemaVersion: 1,
    pipeSafeFields: ["found", "count", "elements", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  ui_get: {
    name: "ui_get",
    description: "Read state of a single uniquely-identified control (0 matches -> found:false; >1 -> ELEMENT_AMBIGUOUS). Returns: found, element, elapsedMs. Pipe-safe: found, element.value, element.automationId.",
    inputSchema: toolInputSchemas.ui_get as unknown as JsonSchema,
    outputSchema: getOutput,
    schemaVersion: 1,
    pipeSafeFields: ["found", "element", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  ui_action: {
    name: "ui_action",
    description: "Perform a UIA action (invoke/toggle/select/expand/collapse/setValue/setRangeValue/setChecked/focus/...). Pattern priority per control type; coordinate fallback OFF by default and never moves the physical cursor. windowMessageClick resolves the element by selector and posts a targeted window message (WM_LBUTTONDOWN/UP) at the element center - it does NOT move or click the physical mouse, and does NOT activate the window; the result method is exactly 'WindowMessageElementClick' with physicalCursorMoved=false. ASYNC-ISH: an invoke only means the action fired - verify the result with ui_wait or an expect. Returns: success, method, physicalCursorMoved, before, after, elapsedMs.",
    inputSchema: toolInputSchemas.ui_action as unknown as JsonSchema,
    outputSchema: actionOutput,
    schemaVersion: 1,
    pipeSafeFields: ["success", "method", "physicalCursorMoved", "elapsedMs"],
    annotations: { idempotent: false, retrySafe: false, needsExpect: true }
  },
  ui_wait: {
    name: "ui_wait",
    description: "Wait for a UI state condition (exists/notExists/visible/hidden/enabled/disabled/valueEquals/valueContains/toggleStateEquals/selected/notSelected/expanded/collapsed/countEquals). Returns matched=false on timeout (not an error). Returns: matched, condition, timedOut, elapsedMs. Pipe-safe: matched, timedOut.",
    inputSchema: toolInputSchemas.ui_wait as unknown as JsonSchema,
    outputSchema: waitOutput,
    schemaVersion: 1,
    pipeSafeFields: ["matched", "timedOut", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  ui_catalog: {
    name: "ui_catalog",
    description: "DIAGNOSTIC FALLBACK TOOL. Do not use as the first method when a Profile/App Pack control is available - prefer profile_action or scoped ui_query to avoid large output. Enumerate actionable controls of a target window with recommendedSelector (pass verbatim to ui_action), supportedActions, patterns, and selector confidence. Auto-labels profileControl when the target matches a loaded App Pack. Returns: controls[], totalNodes, actionableNodes, truncated, elapsedMs. Pipe-safe: controls.",
    inputSchema: toolInputSchemas.ui_catalog as unknown as JsonSchema,
    outputSchema: catalogOutput,
    schemaVersion: 1,
    pipeSafeFields: ["controls", "totalNodes", "elapsedMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  profile_list: {
    name: "profile_list",
    description: "List loaded app profiles (from external App Packs). Returns: profiles[{id,displayName,processNames,controlCount,source}]. Pipe-safe: profiles.",
    inputSchema: toolInputSchemas.profile_list as unknown as JsonSchema,
    outputSchema: profileListOutput,
    schemaVersion: 1,
    pipeSafeFields: ["profiles"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  profile_resolve: {
    name: "profile_resolve",
    description: "Resolve a logical control name from an App Pack to a concrete element, trying candidate selectors in order. Returns: profile, control, found, selectorUsed, confidence, candidatesTried, element. Pipe-safe: found, element.",
    inputSchema: toolInputSchemas.profile_resolve as unknown as JsonSchema,
    outputSchema: profileResolveOutput,
    schemaVersion: 1,
    pipeSafeFields: ["profile", "control", "found", "selectorUsed", "confidence", "element"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  profile_action: {
    name: "profile_action",
    description: "Perform an action on a logical control from an App Pack. REQUIRES A BOUND TARGET. Preferred input: targetRef returned by profile_launch (targetRef survives window recreation and refreshes the binding automatically). Alternatives: hwnd, pid, processName, or titleContains. Do NOT reuse an old hwnd after a window was recreated - pass the targetRef instead. Minimal example: {\"profile\":\"example-app\",\"targetRef\":\"target_abc123\",\"control\":\"settingsButton\",\"action\":\"invoke\"}. Tries candidate selectors in order; supports composite actions selectByName/selectByIndex/getSelection/openMenu/openSubmenu/ensureSelected that handle same-PID popups and verify before/after state; never moves the physical mouse. Pack defaultExpect applies unless you pass expect:false. ASYNC-ISH: verify the outcome with ui_wait or an expect. In background mode actions declared foregroundRequired are refused up front (FOREGROUND_REQUIRED). Returns: profile, control, selectorUsed, confidence, result, interaction.",
    inputSchema: toolInputSchemas.profile_action as unknown as JsonSchema,
    outputSchema: profileActionOutput,
    schemaVersion: 1,
    pipeSafeFields: ["profile", "control", "selectorUsed", "confidence", "result", "interaction"],
    annotations: { idempotent: false, retrySafe: false, needsExpect: true }
  },
  profile_launch: {
    name: "profile_launch",
    description: "PREFERRED launch tool for any application that has an App Pack. Use this instead of launch_app when the profile is known or app_pack_list reports a matching pack. Waits for the stable profile main window (not a splash/initial window) and returns targetRef, pid, and hwnd for later profile actions - pass targetRef to profile_action/profile_resolve/ui_query etc. An explicit executable path may be supplied via exePath. interactionMode=background keeps the window behind the current foreground window (no steal, no topmost, no minimize) and reports interaction metadata; foregroundDemo restores+activates the window. Returns: profile, targetRef, pid, hwnd, title, startedByMcp, reused, uiaRootAvailable, interaction. Pipe-safe: targetRef, pid, hwnd, title, interaction. Recommended as step 0 of a pipeline.",
    inputSchema: toolInputSchemas.profile_launch as unknown as JsonSchema,
    outputSchema: profileLaunchOutput,
    schemaVersion: 1,
    pipeSafeFields: ["profile", "targetRef", "pid", "hwnd", "title", "startedByMcp", "reused", "uiaRootAvailable", "interaction"],
    annotations: { idempotent: false, retrySafe: true }
  },
  app_pack_list: {
    name: "app_pack_list",
    description: "List currently loaded App Packs. Returns: packs[{id,displayName,version,source,catalogVisibility,controls,workflows,valid}]. Pipe-safe: packs. Call this first when you need to know what apps are available.",
    inputSchema: toolInputSchemas.app_pack_list as unknown as JsonSchema,
    outputSchema: appPackListOutput,
    schemaVersion: 1,
    pipeSafeFields: ["packs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  app_pack_describe: {
    name: "app_pack_describe",
    description: "Describe a loaded App Pack: launch contract, logical controls, supported actions (incl. backgroundPolicy), visible workflows (incl. backgroundPolicy/foregroundRequiredSteps), defaultInteractionMode, model usage guidance (usageGuidance: preferred launch tool, target binding, recommended tool order, anti-patterns), known limitations, and pipe-safe examples. Also returns the pack's semantic map (pages/components/selectionGroups/relationships) when the pack declares pages.json/components.json - pass include:[...], page, and compact to shape the response. Call this once per pack before building a pipeline - everything a first-time model needs is here. Returns: pack, displayName, version, source, profile, controls[], actions[], workflows[], limitations[], pipeSafe, defaultInteractionMode, usageGuidance, pages[], selectionGroups[], components[], relationships[].",
    inputSchema: toolInputSchemas.app_pack_describe as unknown as JsonSchema,
    outputSchema: appPackDescribeOutput,
    schemaVersion: 1,
    pipeSafeFields: ["pack", "controls", "workflows", "profile", "pages", "components", "relationships"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  resolve_semantic_control: {
    name: "resolve_semantic_control",
    description: "Resolve a natural-language control description against a loaded App Pack's semantic map (pages.json/components.json + control aliases). Inputs: profile (pack id), query (e.g. '通道1 传感器配置'), optional page and within scopes. Returns ranked matches with the semantic group of each control plus a suggestedPath of logical control names (e.g. [sidebarTemperature, rd105Channel1Tab, rd105SensorConfigurationTab]) the caller can pass to profile_action. PURE RESOLUTION - performs no actions, moves nothing, and never triggers side effects; it only maps language to logical controls.",
    inputSchema: toolInputSchemas.resolve_semantic_control as unknown as JsonSchema,
    outputSchema: resolveSemanticControlOutput,
    schemaVersion: 1,
    pipeSafeFields: ["profile", "matches", "suggestedPath"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  app_pack_validate: {
    name: "app_pack_validate",
    description: "Validate a loaded App Pack (or a local pack directory via packPath): manifest/profile/controls/actions/workflows schemas, control references, workflow tool names, output paths, cycles, sensitive fields, path escape, duplicate ids, unsafe retry. Returns: valid, errors[], warnings[], checked[].",
    inputSchema: toolInputSchemas.app_pack_validate as unknown as JsonSchema,
    outputSchema: appPackValidateOutput,
    schemaVersion: 1,
    pipeSafeFields: ["valid", "errors", "warnings"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  app_pack_reload: {
    name: "app_pack_reload",
    description: "Reload external App Pack configuration. Atomic: a config that fails validation keeps the old version. Running pipelines keep their launch-time snapshot; new runs use the new version. Returns: reloaded, loadedPacks[], errors[].",
    inputSchema: toolInputSchemas.app_pack_reload as unknown as JsonSchema,
    outputSchema: appPackReloadOutput,
    schemaVersion: 1,
    pipeSafeFields: ["reloaded", "loadedPacks"],
    annotations: { idempotent: true, retrySafe: true }
  },
  app_pack_probe: {
    name: "app_pack_probe",
    description: "Probe an unknown running app (by pid) to generate an App Pack draft: window candidates, operable controls, stable automationIds, recommended selectors, patterns, menu/input/dialog candidates, controls.json draft. Writes nothing permanent; returns structuredContent. Pipe-safe: pid, controls, draft.",
    inputSchema: toolInputSchemas.app_pack_probe as unknown as JsonSchema,
    outputSchema: appPackProbeOutput,
    schemaVersion: 1,
    pipeSafeFields: ["pid", "controls", "draft", "warnings"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  validate_steps: {
    name: "validate_steps",
    description: "Statically validate a pipeline BEFORE running it: tool exists, step ids unique, references point to earlier steps, referenced fields exist in output schemas with compatible types, export paths exist, args satisfy input schemas, no cycles/forward refs, no sensitive fields, no path escape, async actions without expect, unsafe retry on non-idempotent steps, estimated max duration. NOTE: static preflight cannot guarantee a runtime control exists. Returns: valid, errors[], warnings[], estimatedMaxDurationMs.",
    inputSchema: toolInputSchemas.validate_steps as unknown as JsonSchema,
    outputSchema: validateStepsOutput,
    schemaVersion: 1,
    pipeSafeFields: ["valid", "errors", "warnings", "estimatedMaxDurationMs"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  run_steps: {
    name: "run_steps",
    description: "Execute a sequence of tools server-side in one call. Steps may have an id (recommended), tool, args with ${id.path} or ${N.path} placeholders, exports{name:path}, expect{postcondition}, retry, captureBefore. Stops on first error; finally runs regardless; returns runId for continue_run. interactionMode=background preflights every step (PIPELINE_NOT_BACKGROUND_SAFE before any step runs when a step is foregroundRequired); foregroundDemo restores the previous foreground window at the end. Returns: success, total, completed, stoppedAtIndex, steps[], exports, runId, interaction. Pipe-safe: steps, exports, interaction.",
    inputSchema: toolInputSchemas.run_steps as unknown as JsonSchema,
    outputSchema: runStepsOutput,
    schemaVersion: 1,
    pipeSafeFields: ["success", "total", "completed", "stoppedAtIndex", "runId", "steps", "exports", "interaction"],
    annotations: { idempotent: false, retrySafe: false }
  },
  profile_run_steps: {
    name: "profile_run_steps",
    description: "Run a pipeline against a loaded App Pack profile: the server launches the app (launch config optional), injects profile/pid/hwnd into every step, resolves controls by logical name, applies defaultExpect from the pack's actions.json, handles same-PID popups. Model does NOT repeat profile/pid/includeProcessPopups. interactionMode resolves explicit > pack default > auto; background preflights steps (PIPELINE_NOT_BACKGROUND_SAFE) before launch. Returns: success, runId, profile, pid, steps[], exports, interaction.",
    inputSchema: toolInputSchemas.profile_run_steps as unknown as JsonSchema,
    outputSchema: runStepsOutput,
    schemaVersion: 1,
    pipeSafeFields: ["success", "runId", "profile", "pid", "hwnd", "steps", "exports", "interaction"],
    annotations: { idempotent: false, retrySafe: false }
  },
  workflow_catalog: {
    name: "workflow_catalog",
    description: "List workflows defined by a loaded App Pack (respects catalogVisibility). Each entry reports backgroundPolicy (safe/bestEffort/foregroundRequired) and foregroundRequiredSteps so a model knows which workflows can run fully in background; defaultInteractionMode is the pack's interaction default. Returns: defaultInteractionMode, workflows[{id,description,safe,tested,restoresState,requiredInputs,visibility,backgroundPolicy,foregroundRequiredSteps}]. Pipe-safe: workflows.",
    inputSchema: toolInputSchemas.workflow_catalog as unknown as JsonSchema,
    outputSchema: workflowCatalogOutput,
    schemaVersion: 1,
    pipeSafeFields: ["workflows"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  run_workflow: {
    name: "run_workflow",
    description: "Run a named workflow from a loaded App Pack. Inputs validated against the workflow inputSchema; ${pack.id} is injected server-side; pack defaultExpect applies; finally runs; returns runId for continue_run. interactionMode resolves explicit > workflow > pack default > auto; background preflights the workflow's steps; foregroundDemo restores the previous foreground window at the end. Returns: success, runId, pack, workflow, status, completedSteps, exports, steps[], error, interaction.",
    inputSchema: toolInputSchemas.run_workflow as unknown as JsonSchema,
    outputSchema: runWorkflowOutput,
    schemaVersion: 1,
    pipeSafeFields: ["success", "runId", "pack", "workflow", "exports", "steps", "interaction"],
    annotations: { idempotent: false, retrySafe: false }
  },
  continue_run: {
    name: "continue_run",
    description: "Continue a failed pipeline from a saved run snapshot (runId + continueFrom). Checks: run not expired, pack version unchanged, process alive, hwnd valid, snapshot continuable. Reuses the ORIGINAL run's resolved interaction mode and foregroundDemo options (never re-derived from current pack defaults). Returns: success, runId, status, continuedFrom, stoppedAt, completedSteps, exports, steps[], error, interaction.",
    inputSchema: toolInputSchemas.continue_run as unknown as JsonSchema,
    outputSchema: continueRunOutput,
    schemaVersion: 1,
    pipeSafeFields: ["success", "runId", "status", "exports", "interaction"],
    annotations: { idempotent: false, retrySafe: false }
  },
  tool_contract_list: {
    name: "tool_contract_list",
    description: "List every tool's public contract: inputSchema, outputSchema, pipeSafeFields, and annotations (readOnly/destructive/idempotent/retrySafe/needsExpect). Model-friendly discovery layer on top of tools/list. Returns: tools[{name, schemaVersion, outputSchema, pipeSafeFields, annotations}]. Pipe-safe: tools.",
    inputSchema: toolInputSchemas.tool_contract_list as unknown as JsonSchema,
    outputSchema: withToolError(obj(
      {
        tools: arr(
          obj(
            {
              name: str(),
              schemaVersion: int(),
              outputSchema: any(),
              pipeSafeFields: arr(str()),
              annotations: any()
            },
            ["name", "schemaVersion", "outputSchema", "pipeSafeFields"]
          )
        )
      },
      ["tools"]
    )),
    schemaVersion: 1,
    pipeSafeFields: ["tools"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  },
  tool_contract_describe: {
    name: "tool_contract_describe",
    description: "Describe one tool's full public contract: inputSchema, outputSchema, pipeSafeFields, annotations, and example result paths derived from the schema. Returns: name, schemaVersion, inputSchema, outputSchema, pipeSafeFields, annotations, examples[{resultPath,type}]. Pipe-safe: outputSchema, pipeSafeFields.",
    inputSchema: toolInputSchemas.tool_contract_describe as unknown as JsonSchema,
    outputSchema: withToolError(obj(
      {
        name: str(),
        schemaVersion: int(),
        inputSchema: any(),
        outputSchema: any(),
        pipeSafeFields: arr(str()),
        annotations: any(),
        examples: arr(
          obj(
            {
              resultPath: str(),
              type: str()
            },
            ["resultPath", "type"]
          )
        )
      },
      ["name", "schemaVersion", "inputSchema", "outputSchema", "pipeSafeFields", "examples"]
    )),
    schemaVersion: 1,
    pipeSafeFields: ["outputSchema", "pipeSafeFields"],
    annotations: { readOnly: true, idempotent: true, retrySafe: true }
  }
};

// Every contract's input schema lives in toolInputSchemas; this assert is a
// build-time guard against forgetting to add a schema for a new tool.
const declaredTools = Object.keys(contracts);

export function getContract(name: string): ToolContract | undefined {
  return contracts[name];
}

export function getContractNames(): string[] {
  return declaredTools;
}

// Tools that may appear as a step inside a pipeline (run_steps /
// profile_run_steps / run_workflow). Pipeline-orchestration tools are
// excluded to prevent unbounded nesting.
export const chainableContracts = declaredTools.filter(
  (name) => !["run_steps", "profile_run_steps", "run_workflow", "continue_run", "validate_steps"].includes(name)
);
