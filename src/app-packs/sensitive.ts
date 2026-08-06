// Path-aware sensitive-value scanning for App Packs.
//
// The validator warns about LIKELY hard-coded credentials in executable
// argument positions (workflow steps/finally/captureBefore args, workflow
// inputSchema defaults/examples, action literal arguments) and in free
// profile values. It must NOT flag identifiers: control ids, automationId
// selectors, aliases, display names, environment-variable NAMES, or
// ${...} variable references.
//
// Design: WHITELIST scan roots (positions that can carry executable
// literals) + path-aware classification, instead of "serialize the whole
// pack and regex it". Pure functions - no host-environment access, no
// reading of environment variable contents.

export type SensitiveFinding = {
  path: string; // dot/bracket path, e.g. workflows.configure.steps[0].args.password
  reason: string;
  redactedPreview: string;
};

export type SensitiveScanResult = {
  findings: SensitiveFinding[];
};

// ── Redaction ──

// Never echo the full secret anywhere (message/details/logs/tests).
export function redactSensitiveValue(value: string): string {
  if (value.length <= 8) return "***";
  const keep = Math.min(2, Math.floor(value.length / 4));
  const head = value.slice(0, keep);
  const tail = value.slice(-keep);
  return `${head}…${tail}`;
}

// ── Path classification ──

export type SensitiveClassification =
  | { kind: "excluded_identifier" }
  | { kind: "environment_reference" }
  | { kind: "input_reference" }
  | { kind: "ordinary_text" }
  | { kind: "likely_sensitive_literal"; reason: string };

// Field-name suffixes/prefixes that mark a path as an IDENTIFIER position
// (never scanned as a credential value). Matched case-insensitively on the
// LAST path segment; selectors are matched on any "selector-ish" segment.
const IDENTIFIER_LEAF_RE = /(^|_|\.|-)(id|ids|key|keys|name|names|title|alias|aliases|description|notes|reason|role|page|parent|group|members|children|control|controlid|automationid|objectname|accessiblename|rootcontrol|navigationcontrol|scrollcontainer|ready|marker|mappingstatus|file|path|source|profileid|workflowid|packid|saveas)$/i;
const DISPLAY_NAME_RE = /^(displayname|display_name)$/i;

// Environment-variable NAME pattern (ALL_CAPS_UNDERSCORE) - a name, not a
// value. Only excluded when the field semantics say "env name".
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// ${...} / $env:... / env://... / secret://... / process.env.X references.
const REFERENCE_RE = /^\$\{[^}]+\}$/;
const PIPE_REFERENCE_RE = /^\$\{[^}]+\}$/;

// Sensitive FIELD NAMES (camelCase/snake_case/kebab-case tolerant). A field
// with one of these names whose value is a bare literal is a strong signal.
// camelCase is matched via a lowercase->uppercase boundary (apiToken,
// accessToken, clientSecret, ...).
const SENSITIVE_FIELD_RE =
  /(^|_|\.|-|[a-z])(password|passwd|passphrase|secret|token|apikey|api_key|accesstoken|refreshToken|authorization|auth|cookie|session|privateKey|clientSecret|credential|bearer|pw)$/i;

// Value-shape features that indicate a real credential even under a neutral
// field name. Deliberately conservative - short/ordinary text never matches.
const BEARER_RE = /^Bearer\s+\S{8,}$/i;
const BASIC_RE = /^Basic\s+[A-Za-z0-9+/=]{8,}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PEM_RE = /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const CLOUD_KEY_RE = /^(AKIA|ASIA|AIza|sk-|ghp_|xox[baprs]-)/;
const URL_CRED_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/; // user:password@ in a URL
const CONNECTION_STRING_RE = /(password|pwd|secret|token)\s*=\s*\S+/i;

// A string that is ONLY a variable/environment reference (or a template
// whose fixed text is non-sensitive glue like "Bearer "/"Basic ") is safe
// indirection, not a literal secret. Literal credentials glued next to a
// reference (e.g. "Bearer abcdef123456") still match the value-shape rules.
function isSafeReference(value: string): boolean {
  const trimmed = value.trim();
  if (REFERENCE_RE.test(trimmed) || PIPE_REFERENCE_RE.test(trimmed)) return true;
  // Template with a reference plus only glue text: strip the reference(s)
  // and check whether what remains is empty or non-sensitive glue.
  const withoutRefs = trimmed.replace(/\$\{[^}]+\}/g, "").trim();
  if (withoutRefs.length === 0) return true;
  const glue = withoutRefs.replace(/^(Bearer|Basic)\s*/i, "").trim();
  return glue.length === 0;
}

// Decide whether a string at a path is a likely credential literal.
export function classifyStringAtPath(path: string, value: string): SensitiveClassification {
  const segments = path.split(/[.[\]]/).filter((s) => s !== "");
  const leaf = segments[segments.length - 1] ?? "";

  // 1) Identifier/description positions are never credential values.
  if (IDENTIFIER_LEAF_RE.test(leaf) || DISPLAY_NAME_RE.test(leaf)) {
    return { kind: "excluded_identifier" };
  }
  // Selector sub-trees (automationId/name/className...) are identifiers.
  if (path.includes(".selectors") || path.includes(".selector") || path.includes("automationId") || path.includes("objectName")) {
    return { kind: "excluded_identifier" };
  }

  // 2) executableEnv is an ENVIRONMENT VARIABLE NAME, never a secret value.
  if (leaf === "executableEnv" || leaf === "environmentVariable" || leaf === "envName") {
    return { kind: "environment_reference" };
  }

  // 3) Whole-string variable references are safe indirection.
  if (isSafeReference(value)) {
    return { kind: "input_reference" };
  }

  // 4) Sensitive field name + bare literal -> likely credential. The field
  //    name may be a PARENT segment (e.g. inputSchema property "password"
  //    under ".default"): any segment counts.
  const anySensitiveSegment = segments.some((s) => SENSITIVE_FIELD_RE.test(s));
  if (anySensitiveSegment && value.length >= 3) {
    // An ALL_CAPS value under a sensitive field is ambiguous (could be an
    // env name); only flag it when it is not purely a NAME-shaped token.
    if (ENV_NAME_RE.test(value)) {
      return { kind: "ordinary_text" };
    }
    return { kind: "likely_sensitive_literal", reason: "sensitive_field_with_literal_value" };
  }

  // 5) Value-shape features under any non-identifier field.
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

  return { kind: "ordinary_text" };
}

// ── Whitelist scan roots ──

export type SensitiveScanInput = {
  profile: unknown;
  workflows: Array<{
    id?: string;
    inputSchema?: { properties?: Record<string, unknown> };
    steps: Array<{ args: Record<string, unknown>; captureBefore?: { read?: { args?: Record<string, unknown> } }; expect?: unknown; retry?: unknown }>;
    finally?: Array<{ args: Record<string, unknown>; captureBefore?: { read?: { args?: Record<string, unknown> } }; expect?: unknown; retry?: unknown }>;
  }>;
  actions: Array<{ control: string; action: string; defaultExpect?: unknown }>;
};

// Walk only the positions that can carry executable literals:
//   - workflow steps/finally args, captureBefore.read.args, expect, retry
//   - workflow inputSchema property defaults/examples/const/enum values
//   - action defaultExpect (only the value-carrying leaf fields)
//   - profile free values (whole profile; identifier leaves are excluded by
//     classification, executableEnv excluded by the env-name rule)
function walkValue(
  value: unknown,
  path: string,
  findings: SensitiveFinding[],
  depth = 0
): void {
  if (depth > 32) return; // cycle/depth safety (JSON data, but be safe)
  if (typeof value === "string") {
    const cls = classifyStringAtPath(path, value);
    if (cls.kind === "likely_sensitive_literal") {
      findings.push({ path, reason: cls.reason, redactedPreview: redactSensitiveValue(value) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkValue(value[i], `${path}[${i}]`, findings, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkValue(child, path ? `${path}.${key}` : key, findings, depth + 1);
    }
  }
}

// Keys inside an inputSchema property whose values may be literal secrets.
const SCHEMA_LITERAL_KEYS = new Set(["default", "example", "examples", "const", "enum"]);

export function scanSensitiveValues(input: SensitiveScanInput): SensitiveScanResult {
  const findings: SensitiveFinding[] = [];

  // Profile free values (executableEnv is excluded by classification).
  walkValue(input.profile, "profile", findings);

  // Workflow executable positions.
  for (let wi = 0; wi < input.workflows.length; wi++) {
    const wf = input.workflows[wi]!;
    const wfPath = `workflows.${wf.id ?? wi}`;
    for (let si = 0; si < wf.steps.length; si++) {
      const step = wf.steps[si]!;
      walkValue(step.args, `${wfPath}.steps[${si}].args`, findings);
      if (step.captureBefore?.read?.args) {
        walkValue(step.captureBefore.read.args, `${wfPath}.steps[${si}].captureBefore.read.args`, findings);
      }
      if (step.expect) walkValue(step.expect, `${wfPath}.steps[${si}].expect`, findings);
      if (step.retry) walkValue(step.retry, `${wfPath}.steps[${si}].retry`, findings);
    }
    for (let fi = 0; fi < (wf.finally ?? []).length; fi++) {
      const step = wf.finally![fi]!;
      walkValue(step.args, `${wfPath}.finally[${fi}].args`, findings);
      if (step.captureBefore?.read?.args) {
        walkValue(step.captureBefore.read.args, `${wfPath}.finally[${fi}].captureBefore.read.args`, findings);
      }
      if (step.expect) walkValue(step.expect, `${wfPath}.finally[${fi}].expect`, findings);
      if (step.retry) walkValue(step.retry, `${wfPath}.finally[${fi}].retry`, findings);
    }
    // inputSchema property defaults/examples/const/enum.
    for (const [propName, propSchema] of Object.entries(wf.inputSchema?.properties ?? {})) {
      const propPath = `${wfPath}.inputSchema.properties.${propName}`;
      if (propSchema !== null && typeof propSchema === "object") {
        for (const key of SCHEMA_LITERAL_KEYS) {
          const literal = (propSchema as Record<string, unknown>)[key];
          if (literal !== undefined) {
            walkValue(literal, `${propPath}.${key}`, findings);
          }
        }
      }
    }
  }

  // Action contracts: defaultExpect value-carrying leaves (expectedValue,
  // toggleState, selector values are identifiers/state, not credentials).
  for (let ai = 0; ai < input.actions.length; ai++) {
    const contract = input.actions[ai]!;
    const base = `actions.contracts[${ai}]`;
    const expect = contract.defaultExpect;
    if (expect !== null && typeof expect === "object") {
      walkValue((expect as Record<string, unknown>).expectedValue, `${base}.defaultExpect.expectedValue`, findings);
    }
  }

  return { findings };
}
