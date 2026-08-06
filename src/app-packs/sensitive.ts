// Path-aware sensitive-value scanning for App Packs.
//
// The validator warns about LIKELY hard-coded credentials in executable
// argument positions:
//   - workflow TOP-LEVEL captureBefore[].read.args, steps/finally
//     args + captureBefore[].read.args, expect, retry
//   - workflow inputSchema defaults/examples/const/enum (NESTED schemas)
//   - action literal arguments (defaultExpect.expectedValue)
//   - profile.executableEnv (the ONLY profile field that carries an
//     environment-variable NAME; all other profile fields are identity/
//     display metadata validated by schema, not scanned as credential
//     positions)
//
// It must NOT flag identifiers: control ids, automationId selectors, aliases,
// display names, or EXPLICIT environment-variable-name fields whose VALUE is
// a valid environment-variable name (executableEnv / envName / envVar / ...).
// An env-name FIELD does not exempt a non-env-name VALUE: "envName" carrying
// "Bearer abcdef123456" is a hard-coded credential, not a variable name.
//
// Reference syntax: the ONLY formally supported non-literal reference form
// is the App Pack pipeline's ${...} syntax (${env.X}, ${inputs.x},
// ${secrets.x}). $env:/env:///secret:///process.env. forms are NOT claimed
// to be safe - a bare literal that merely LOOKS like such a syntax is
// treated per its field context (sensitive field -> warning).
//
// Design: WHITELIST scan roots + explicit scan CONTEXT per candidate string
// (profile_value / workflow_args / ... / selector / metadata). Identifier
// exclusion applies ONLY in selector/metadata contexts - an executable
// argument named `key`/`path`/`source` is never excluded by its field name,
// and credential value shapes take priority over neutral field names.
// Pure functions - no host-environment access, no reading of environment
// variable contents.

export type SensitiveScanContext =
  | "profile_value"
  | "workflow_args"
  | "workflow_expect"
  | "workflow_retry"
  | "input_schema_literal"
  | "action_literal"
  | "selector"
  | "metadata";

export type SensitiveFinding = {
  file: "profile.json" | "workflows.json" | "actions.json";
  path: string; // dot/bracket path, e.g. workflows.configure.steps[0].args.password
  reason: string;
  redactedPreview: string;
  context: SensitiveScanContext;
};

export type SensitiveScanResult = {
  findings: SensitiveFinding[];
};

// ── Redaction ──

// Never echo the full secret anywhere (message/details/logs/tests). The
// finding stores NO raw value - only the redacted preview.
export function redactSensitiveValue(value: string): string {
  if (value.length <= 8) return "***";
  const keep = Math.min(2, Math.floor(value.length / 4));
  const head = value.slice(0, keep);
  const tail = value.slice(-keep);
  return `${head}…${tail}`;
}

// ── Path/context classification ──

export type SensitiveClassification =
  | { kind: "excluded_identifier" }
  | { kind: "environment_variable_name" }
  | { kind: "variable_reference" }
  | { kind: "ordinary_text" }
  | { kind: "likely_sensitive_literal"; reason: string };

// Field names that EXPLICITLY represent an environment-variable NAME
// (never a credential value). The FIELD semantic alone is not enough: the
// VALUE must also be a valid environment-variable name (ENV_NAME_VALUE_RE)
// before the exemption applies.
const ENV_NAME_FIELD_RE = /^(executableEnv|environmentVariable|environmentVariables|envName|envVar|envKey)$/i;

// Strict environment-variable name shape (stable, bounded: 1..128 chars,
// [A-Za-z_][A-Za-z0-9_]* - leading digit rejected). An env-name FIELD
// carrying "Bearer abcdef123456" is NOT a variable name and stays a
// credential candidate.
const ENV_NAME_VALUE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// The ONLY supported reference syntax: ${...} pipeline placeholders.
const REFERENCE_RE = /^\$\{[^}]+\}$/;
const REFERENCE_INSIDE_RE = /\$\{[^}]+\}/g;

// Field-name suffixes/prefixes that mark a path as an IDENTIFIER position.
// Used ONLY in selector/metadata contexts - never in executable contexts.
const IDENTIFIER_LEAF_RE = /(^|_|\.|-)(id|ids|key|keys|name|names|title|alias|aliases|description|notes|reason|role|page|parent|group|members|children|control|controlid|automationid|objectname|accessiblename|rootcontrol|navigationcontrol|scrollcontainer|ready|marker|mappingstatus|file|path|source|profileid|workflowid|packid|saveas)$/i;
const DISPLAY_NAME_RE = /^(displayname|display_name)$/i;

// Sensitive FIELD NAMES (camelCase/snake_case/kebab-case tolerant). A field
// with one of these names whose value is a bare literal is a strong signal.
const SENSITIVE_FIELD_RE =
  /(^|_|\.|-|[a-z])(password|passwd|passphrase|secret|token|apikey|api_key|accesstoken|refreshToken|authorization|auth|cookie|session|privateKey|clientSecret|credential|bearer|pw)$/i;

// Value-shape features that indicate a real credential even under a neutral
// field name in an EXECUTABLE context. Deliberately conservative.
const BEARER_RE = /^Bearer\s+\S{8,}$/i;
const BASIC_RE = /^Basic\s+[A-Za-z0-9+/=]{8,}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PEM_RE = /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const CLOUD_KEY_RE = /^(AKIA|ASIA|AIza|sk-|ghp_|xox[baprs]-)/;
const URL_CRED_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/; // user:password@ in a URL
const CONNECTION_STRING_RE = /(password|pwd|secret|token)\s*=\s*\S+/i;

// True when the value is exactly one ${...} reference.
export function isSupportedReference(value: string): boolean {
  return REFERENCE_RE.test(value.trim());
}

// True when the value is a template made ONLY of ${...} references plus
// whitespace and safe glue (Bearer/Basic prefixes, punctuation). Anything
// else left over means the template carries a literal - not a pure
// reference, and possibly a credential glued to one.
export function isReferenceOnlyTemplate(value: string): boolean {
  const withoutRefs = value.trim().replace(REFERENCE_INSIDE_RE, "").trim();
  if (withoutRefs.length === 0) return true;
  const glue = withoutRefs
    .replace(/^(Bearer|Basic)\s*/i, "")
    .replace(/^[:=,\s"'()\[\]{}]+$/, "")
    .trim();
  return glue.length === 0;
}

// Decide whether a string at a path (with an explicit scan context) is a
// likely credential literal.
export function classifyStringAtPath(
  pathSegments: Array<string | number>,
  value: string,
  context: SensitiveScanContext
): SensitiveClassification {
  const leaf = String(pathSegments[pathSegments.length - 1] ?? "");

  // 1) Explicit environment-variable-NAME field whose VALUE is a valid
  //    environment-variable name (MY_APP_TOKEN / RTK_PASSWORD / ...). The
  //    field name never exempts an arbitrary literal: "envName" carrying
  //    "Bearer abcdef123456" proceeds to the credential-shape checks.
  if (ENV_NAME_FIELD_RE.test(leaf) && ENV_NAME_VALUE_RE.test(value.trim())) {
    return { kind: "environment_variable_name" };
  }

  // 2) Supported ${...} reference (or a reference-only template such as
  //    "Bearer ${env.API_TOKEN}") is safe indirection in ANY context.
  if (isSupportedReference(value) || isReferenceOnlyTemplate(value)) {
    return { kind: "variable_reference" };
  }

  // 3) Identifier exclusion applies ONLY in selector/metadata contexts.
  //    An executable arg named key/path/source/file is NEVER excluded.
  if (context === "selector" || context === "metadata") {
    const pathStr = pathSegments.join(".");
    if (IDENTIFIER_LEAF_RE.test(leaf) || DISPLAY_NAME_RE.test(leaf)) {
      return { kind: "excluded_identifier" };
    }
    if (pathStr.includes("selectors") || pathStr.includes("selector") || pathStr.includes("automationId") || pathStr.includes("objectName")) {
      return { kind: "excluded_identifier" };
    }
  }

  // 4) Credential VALUE SHAPES take priority over neutral field names, in
  //    executable contexts (and conservatively in selector/metadata too:
  //    a full Bearer/JWT/private key is never a normal control id).
  const shapes: Array<[RegExp, string]> = [
    [BEARER_RE, "bearer_token_literal"],
    [BASIC_RE, "basic_auth_literal"],
    [JWT_RE, "jwt_literal"],
    [PEM_RE, "pem_private_key"],
    [CLOUD_KEY_RE, "cloud_key_prefix"],
    [URL_CRED_RE, "url_embedded_credentials"],
    [CONNECTION_STRING_RE, "connection_string_password"]
  ];
  for (const [re, reason] of shapes) {
    if (re.test(value)) {
      return { kind: "likely_sensitive_literal", reason };
    }
  }

  // 5) Sensitive FIELD NAME (any path segment) + bare literal. ALL-CAPS
  //    values are NOT auto-excluded here: an uppercase literal under
  //    args.password is a hard-coded credential, not an env-name (env-name
  //    exclusion is handled by rule 1 only).
  if (pathSegments.some((s) => SENSITIVE_FIELD_RE.test(String(s))) && value.length >= 3) {
    return { kind: "likely_sensitive_literal", reason: "sensitive_field_with_literal_value" };
  }

  return { kind: "ordinary_text" };
}

// ── Whitelist scan roots ──

export type SensitiveScanInput = {
  // Profile identity/display/window/process metadata is validated by schema
  // and NOT scanned as a credential position. The only profile field that
  // can carry an executable-level value is executableEnv - an env NAME.
  profile: unknown;
  workflows: Array<{
    id?: string;
    inputSchema?: { properties?: Record<string, unknown> };
    captureBefore?: Array<{ read?: { args?: Record<string, unknown> } }>;
    steps: Array<{ args: Record<string, unknown>; captureBefore?: { read?: { args?: Record<string, unknown> } }; expect?: unknown; retry?: unknown }>;
    finally?: Array<{ args: Record<string, unknown>; captureBefore?: { read?: { args?: Record<string, unknown> } }; expect?: unknown; retry?: unknown }>;
  }>;
  actions: Array<{ control: string; action: string; defaultExpect?: unknown }>;
};

function walkValue(
  value: unknown,
  pathSegments: Array<string | number>,
  context: SensitiveScanContext,
  file: SensitiveFinding["file"],
  findings: SensitiveFinding[],
  depth = 0
): void {
  if (depth > 32) return; // cycle/depth safety (JSON data, but be safe)
  if (typeof value === "string") {
    const cls = classifyStringAtPath(pathSegments, value, context);
    if (cls.kind === "likely_sensitive_literal") {
      findings.push({
        file,
        path: pathSegments.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join(""),
        reason: cls.reason,
        redactedPreview: redactSensitiveValue(value),
        context
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkValue(value[i], [...pathSegments, i], context, file, findings, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkValue(child, [...pathSegments, key], context, file, findings, depth + 1);
    }
  }
}

// Keys inside an inputSchema whose values may be literal secrets.
const SCHEMA_LITERAL_KEYS = new Set(["default", "example", "examples", "const", "enum"]);

// Keys whose value is a nested SCHEMA (or array of schemas) to recurse into.
const SCHEMA_NEST_KEYS: Record<string, "single" | "array" | "map"> = {
  properties: "map",
  patternProperties: "map",
  items: "single", // single schema or array of schemas (handled below)
  prefixItems: "array",
  allOf: "array",
  anyOf: "array",
  oneOf: "array",
  not: "single",
  if: "single",
  then: "single",
  else: "single",
  dependentSchemas: "map",
  contains: "single",
  unevaluatedItems: "single",
  unevaluatedProperties: "single",
  propertyNames: "single"
};

let schemaNodeBudget = 0;
const SCHEMA_NODE_LIMIT = 4000;

// Recursively scan a JSON Schema for literal secret keywords. Only
// default/example/examples/const/enum values are classified; description/
// title/$id/$ref/pattern/format are never scanned.
function scanSchemaLiterals(
  schema: unknown,
  pathSegments: Array<string | number>,
  findings: SensitiveFinding[],
  file: SensitiveFinding["file"],
  depth = 0
): void {
  if (depth > 40 || schemaNodeBudget >= SCHEMA_NODE_LIMIT) return;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    // A bare literal at a schema position is not an executable value.
    return;
  }
  schemaNodeBudget++;
  const obj = schema as Record<string, unknown>;

  // Literal keywords at this node.
  for (const key of SCHEMA_LITERAL_KEYS) {
    const literal = obj[key];
    if (literal !== undefined) {
      walkValue(literal, [...pathSegments, key], "input_schema_literal", file, findings);
    }
  }

  // Recurse into nested schema containers.
  for (const [key, kind] of Object.entries(SCHEMA_NEST_KEYS)) {
    const child = obj[key];
    if (child === undefined) continue;
    if (kind === "map" && typeof child === "object" && !Array.isArray(child)) {
      for (const [subKey, subSchema] of Object.entries(child as Record<string, unknown>)) {
        scanSchemaLiterals(subSchema, [...pathSegments, key, subKey], findings, file, depth + 1);
      }
    } else if (kind === "array" && Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        scanSchemaLiterals(child[i], [...pathSegments, key, i], findings, file, depth + 1);
      }
    } else if (kind === "single") {
      // items may be a single schema OR an array of schemas (tuple form).
      if (Array.isArray(child)) {
        for (let i = 0; i < child.length; i++) {
          scanSchemaLiterals(child[i], [...pathSegments, key, i], findings, file, depth + 1);
        }
      } else {
        scanSchemaLiterals(child, [...pathSegments, key], findings, file, depth + 1);
      }
    }
  }

  // additionalProperties: boolean or a schema.
  const additional = obj.additionalProperties;
  if (additional !== undefined && additional !== null && typeof additional === "object") {
    scanSchemaLiterals(additional, [...pathSegments, "additionalProperties"], findings, file, depth + 1);
  }
}

export function scanSensitiveValues(input: SensitiveScanInput): SensitiveScanResult {
  const findings: SensitiveFinding[] = [];
  schemaNodeBudget = 0;

  // Profile: NO blind walk of the whole profile object. Identity/display/
  // window/process metadata (id, displayName, executableNames, processNames,
  // mainWindow.title, titleContains, submenuAidPatterns, ...) is validated by
  // schema and is not a credential position. The only profile field carrying
  // an executable-level value is executableEnv, and it is an env NAME -
  // classified by rule 1 (env-name field + valid env-name value). Scanning
  // only that field keeps "sk-tool.exe" / "Token Manager" / "Bearer
  // Diagnostics" free of false positives.
  const executableEnv = (input.profile as { executableEnv?: unknown } | null | undefined)?.executableEnv;
  if (typeof executableEnv === "string") {
    const cls = classifyStringAtPath(["profile", "executableEnv"], executableEnv, "profile_value");
    if (cls.kind === "likely_sensitive_literal") {
      findings.push({
        file: "profile.json",
        path: "profile.executableEnv",
        reason: cls.reason,
        redactedPreview: redactSensitiveValue(executableEnv),
        context: "profile_value"
      });
    }
  }

  // Workflow executable positions.
  for (let wi = 0; wi < input.workflows.length; wi++) {
    const wf = input.workflows[wi]!;
    const wfPath = ["workflows", wf.id ?? wi];
    // Workflow-level captureBefore (schema: workflows[].captureBefore[]).
    for (let ci = 0; ci < (wf.captureBefore ?? []).length; ci++) {
      const capture = wf.captureBefore![ci]!;
      if (capture.read?.args) {
        walkValue(capture.read.args, [...wfPath, "captureBefore", ci, "read", "args"], "workflow_args", "workflows.json", findings);
      }
    }
    for (let si = 0; si < wf.steps.length; si++) {
      const step = wf.steps[si]!;
      walkValue(step.args, [...wfPath, "steps", si, "args"], "workflow_args", "workflows.json", findings);
      if (step.captureBefore?.read?.args) {
        walkValue(step.captureBefore.read.args, [...wfPath, "steps", si, "captureBefore", "read", "args"], "workflow_args", "workflows.json", findings);
      }
      if (step.expect) walkValue(step.expect, [...wfPath, "steps", si, "expect"], "workflow_expect", "workflows.json", findings);
      if (step.retry) walkValue(step.retry, [...wfPath, "steps", si, "retry"], "workflow_retry", "workflows.json", findings);
    }
    for (let fi = 0; fi < (wf.finally ?? []).length; fi++) {
      const step = wf.finally![fi]!;
      walkValue(step.args, [...wfPath, "finally", fi, "args"], "workflow_args", "workflows.json", findings);
      if (step.captureBefore?.read?.args) {
        walkValue(step.captureBefore.read.args, [...wfPath, "finally", fi, "captureBefore", "read", "args"], "workflow_args", "workflows.json", findings);
      }
      if (step.expect) walkValue(step.expect, [...wfPath, "finally", fi, "expect"], "workflow_expect", "workflows.json", findings);
      if (step.retry) walkValue(step.retry, [...wfPath, "finally", fi, "retry"], "workflow_retry", "workflows.json", findings);
    }
    // Nested inputSchema scanning (properties/items/allOf/anyOf/oneOf/...).
    scanSchemaLiterals(wf.inputSchema, [...wfPath, "inputSchema"], findings, "workflows.json");
  }

  // Action contracts: defaultExpect value-carrying leaves.
  for (let ai = 0; ai < input.actions.length; ai++) {
    const contract = input.actions[ai]!;
    const base = ["actions", "contracts", ai];
    const expect = contract.defaultExpect;
    if (expect !== null && typeof expect === "object") {
      walkValue((expect as Record<string, unknown>).expectedValue, [...base, "defaultExpect", "expectedValue"], "action_literal", "actions.json", findings);
    }
  }

  return { findings };
}
