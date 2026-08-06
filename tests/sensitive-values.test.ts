// Table-driven tests for the path-aware sensitive-value scan.
//
// Coverage:
//   - identifiers/aliases/displayNames/env NAMES/references never warn
//   - literal credentials in executable argument positions DO warn
//   - findings never leak the raw secret (message/details/serialized)
//   - warning paths are exact
//   - result order is stable

import assert from "node:assert/strict";
import test from "node:test";

import { scanSensitiveValues, classifyStringAtPath, redactSensitiveValue, type SensitiveScanInput } from "../src/app-packs/sensitive.js";

// ── helpers ──

function scan(input: Partial<SensitiveScanInput>): string[] {
  const full: SensitiveScanInput = {
    profile: input.profile ?? {},
    workflows: input.workflows ?? [],
    actions: input.actions ?? []
  };
  return scanSensitiveValues(full).findings.map((f) => f.path);
}

function workflowWithArgs(args: Record<string, unknown>, extra: Partial<SensitiveScanInput> = {}): SensitiveScanInput {
  return {
    profile: {},
    workflows: [{ id: "configure", steps: [{ tool: "type_text", args }] }],
    actions: [],
    ...extra
  };
}

// ── must NOT warn ──

const noWarnCases: Array<[string, SensitiveScanInput]> = [
  ["control ID rtkPasswordEdit", workflowWithArgs({ text: "hello" }, {
    profile: {},
    workflows: [],
    actions: []
  })],
  ["automationId passwordInput (identifier)", {
    profile: {},
    workflows: [{ id: "w", steps: [{ tool: "ui_get", args: { selector: { automationId: "passwordInput" } } }] }],
    actions: []
  }],
  ["displayName Token Manager", {
    profile: {},
    workflows: [],
    actions: []
  }],
  ["alias 密码输入框 (identifier leaf)", {
    profile: {},
    workflows: [{ id: "w", steps: [{ tool: "profile_action", args: { control: "x", aliases: ["密码输入框"] } }] }],
    actions: []
  }],
  ["executableEnv MY_APP_TOKEN", {
    profile: { executableEnv: "MY_APP_TOKEN" },
    workflows: [],
    actions: []
  }],
  ["executableEnv RTK_PASSWORD", {
    profile: { executableEnv: "RTK_PASSWORD" },
    workflows: [],
    actions: []
  }],
  ["args.password = ${env.RTK_PASSWORD}", workflowWithArgs({ password: "${env.RTK_PASSWORD}" })],
  ["args.authorization = Bearer ${env.API_TOKEN}", workflowWithArgs({ authorization: "Bearer ${env.API_TOKEN}" })],
  ["inputSchema description = Password used for authentication", {
    profile: {},
    workflows: [{ id: "w", steps: [], inputSchema: { properties: { password: { type: "string", description: "Password used for authentication" } } } }],
    actions: []
  }],
  ["page title Secret Settings (identifier leaf)", {
    profile: {},
    workflows: [{ id: "w", steps: [], inputSchema: { properties: { pageTitle: { type: "string", default: "Secret Settings" } } } }],
    actions: []
  }]
];

for (const [name, input] of noWarnCases) {
  test(`no-warn: ${name}`, () => {
    const paths = scan(input);
    assert.deepEqual(paths, [], `expected no findings for '${name}', got ${JSON.stringify(paths)}`);
  });
}

// ── must warn ──

const warnCases: Array<[string, SensitiveScanInput, string]> = [
  ["args.password = literal-secret", workflowWithArgs({ password: "literal-secret" }), "workflows.configure.steps[0].args.password"],
  ["args.token = abcdef1234567890", workflowWithArgs({ token: "abcdef1234567890" }), "workflows.configure.steps[0].args.token"],
  ["args.authorization = Bearer abcdef123456", workflowWithArgs({ authorization: "Bearer abcdef123456" }), "workflows.configure.steps[0].args.authorization"],
  ["finally args.cookie = sessionid=abcdef", {
    profile: {},
    workflows: [{ id: "configure", steps: [], finally: [{ tool: "send_key", args: { cookie: "sessionid=abcdef" } }] }],
    actions: []
  }, "workflows.configure.finally[0].args.cookie"],
  ["inputSchema password.default = hardcoded-password", {
    profile: {},
    workflows: [{ id: "w", steps: [], inputSchema: { properties: { password: { type: "string", default: "hardcoded-password" } } } }],
    actions: []
  }, "workflows.w.inputSchema.properties.password.default"],
  ["inputSchema apiToken.example = literal-token-value", {
    profile: {},
    workflows: [{ id: "w", steps: [], inputSchema: { properties: { apiToken: { type: "string", example: "literal-token-value" } } } }],
    actions: []
  }, "workflows.w.inputSchema.properties.apiToken.example"],
  ["connection string password=literal", workflowWithArgs({ connection: "Server=x;password=literal" }), "workflows.configure.steps[0].args.connection"],
  ["URL user:password@", workflowWithArgs({ url: "https://user:supersecret@example.com" }), "workflows.configure.steps[0].args.url"]
];

for (const [name, input, expectedPath] of warnCases) {
  test(`warn: ${name}`, () => {
    const paths = scan(input);
    assert.ok(paths.includes(expectedPath), `expected finding at '${expectedPath}', got ${JSON.stringify(paths)}`);
  });
}

// ── redaction / no-leak ──

test("redaction: findings never contain the raw secret", () => {
  const secret = "literal-secret-value-123456";
  const input = workflowWithArgs({ password: secret });
  const result = scanSensitiveValues(input);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0]!;
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret), "serialized findings must not contain the raw secret");
  assert.ok(!finding.redactedPreview.includes(secret));
  assert.ok(finding.redactedPreview.length < secret.length);
  assert.equal(redactSensitiveValue("short"), "***");
  assert.equal(redactSensitiveValue("0123456789abcdef"), "01…ef");
});

test("redaction: short secrets are fully masked", () => {
  assert.equal(redactSensitiveValue("pw"), "***");
  assert.equal(redactSensitiveValue("secret"), "***");
});

// ── path exactness and stability ──

test("paths: exact dot/bracket path for nested workflow args", () => {
  const input: SensitiveScanInput = {
    profile: {},
    workflows: [{ id: "deploy", steps: [{ tool: "type_text", args: { nested: { auth: { token: "abcdefghijklmnop" } } } }] }],
    actions: []
  };
  const paths = scan(input);
  assert.ok(paths.includes("workflows.deploy.steps[0].args.nested.auth.token"), JSON.stringify(paths));
});

test("stability: identical input yields identical ordered findings", () => {
  const input = workflowWithArgs({ password: "literal-secret", token: "abcdef1234567890" });
  const a = scanSensitiveValues(input).findings.map((f) => f.path);
  const b = scanSensitiveValues(input).findings.map((f) => f.path);
  assert.deepEqual(a, b);
});

// ── classification unit checks (path + context aware) ──

function segs(path: string): Array<string | number> {
  return path.split(/[.[\]]/).filter((s) => s !== "");
}

test("classify: ALL_CAPS literal under sensitive field in workflow_args WARNS (no env-name guess)", () => {
  const cls = classifyStringAtPath(segs("workflows.w.steps[0].args.password"), "SUPERSECRET123", "workflow_args");
  assert.equal(cls.kind, "likely_sensitive_literal");
});

test("classify: env-name fields exempt ONLY valid env-name values", () => {
  const valid = classifyStringAtPath(segs("profile.executableEnv"), "MY_APP_TOKEN", "profile_value");
  assert.equal(valid.kind, "environment_variable_name");
  const valid2 = classifyStringAtPath(segs("profile.environmentVariable"), "RTK_PASSWORD", "profile_value");
  assert.equal(valid2.kind, "environment_variable_name");
  // The same FIELD carrying a non-env-name literal is a credential candidate.
  const bearer = classifyStringAtPath(segs("workflows.w.steps[0].args.envName"), "Bearer abcdef123456", "workflow_args");
  assert.equal(bearer.kind, "likely_sensitive_literal");
  const url = classifyStringAtPath(segs("workflows.w.steps[0].args.envVar"), "https://user:pass@example.com", "workflow_args");
  assert.equal(url.kind, "likely_sensitive_literal");
  const upper = classifyStringAtPath(segs("workflows.w.steps[0].args.envKey"), "PASSWORD=literal-secret", "workflow_args");
  assert.equal(upper.kind, "likely_sensitive_literal");
  // Invalid env-name shape without a secret shape is ordinary text, never a
  // false "environment_variable_name" exemption.
  const spaced = classifyStringAtPath(segs("workflows.w.steps[0].args.envName"), "not a valid env name", "workflow_args");
  assert.equal(spaced.kind, "ordinary_text");
});

test("classify: ${...} reference is safe in any context", () => {
  const cls = classifyStringAtPath(segs("workflows.w.steps[0].args.password"), "${env.MY_APP_TOKEN}", "workflow_args");
  assert.equal(cls.kind, "variable_reference");
  const cls2 = classifyStringAtPath(segs("workflows.w.steps[0].args.authorization"), "Bearer ${env.API_TOKEN}", "workflow_args");
  assert.equal(cls2.kind, "variable_reference");
});

test("classify: $env: syntax is NOT a supported reference - sensitive field warns", () => {
  const cls = classifyStringAtPath(segs("workflows.w.steps[0].args.password"), "$env:RTK_PASSWORD", "workflow_args");
  assert.equal(cls.kind, "likely_sensitive_literal");
});

test("classify: selector subtree values are identifiers (selector context only)", () => {
  const cls = classifyStringAtPath(segs("workflows.w.steps[0].args.selector.automationId"), "passwordInput", "selector");
  assert.equal(cls.kind, "excluded_identifier");
  // Same path in an EXECUTABLE context is not excluded by field name alone.
  const exec = classifyStringAtPath(segs("workflows.w.steps[0].args.key"), "passwordInput", "workflow_args");
  assert.equal(exec.kind, "ordinary_text");
});

test("classify: identifier leaf names excluded ONLY in selector/metadata contexts", () => {
  for (const leaf of ["id", "aliases", "displayName", "notes", "reason", "role", "mappingStatus", "saveAs"]) {
    const cls = classifyStringAtPath(segs(`controls.x.${leaf}`), "passwordInput", "metadata");
    assert.equal(cls.kind, "excluded_identifier", `leaf '${leaf}' must be excluded in metadata`);
  }
  // In workflow_args the same leaf names are NOT excluded.
  const exec = classifyStringAtPath(segs("workflows.w.steps[0].args.key"), "AKIA1234567890ABCDEF", "workflow_args");
  assert.equal(exec.kind, "likely_sensitive_literal", "cloud key shape must win over neutral field name");
});

// ── integration through the pack validator ──

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPackFromDir } from "../src/app-packs/loader.js";
import { validatePack } from "../src/app-packs/validator.js";

const MANIFEST = { schemaVersion: 1, id: "sens-fixture", displayName: "Sens Fixture", version: "1.0.0" };
const PROFILE = { id: "sens-fixture", displayName: "Sens Fixture", executableNames: ["Fixture.exe"], executableEnv: "MY_APP_TOKEN" };

async function validateFixture(files: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "sens-"));
  const packDir = path.join(dir, "sens-fixture");
  await mkdir(packDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), JSON.stringify(value, null, 2), "utf8");
  }
  const pack = await loadPackFromDir(packDir);
  assert.ok(pack, "fixture must load");
  return validatePack(pack!);
}

test("validator integration: workflow literal secret warns with exact path", async () => {
  const v = await validateFixture({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "workflows.json": {
      workflows: [{
        id: "configure",
        steps: [{ id: "type", tool: "type_text", args: { password: "literal-secret" } }]
      }]
    }
  });
  const w = v.warnings.find((x) => x.code === "SENSITIVE_VALUE");
  assert.ok(w, "must warn, got " + JSON.stringify(v.warnings));
  assert.equal(w!.path, "workflows.configure.steps[0].args.password");
  assert.ok(!JSON.stringify(w).includes("literal-secret"), "warning must not leak the raw secret");
});

test("validator integration: rtkPasswordEdit identifier and env name do not warn", async () => {
  const v = await validateFixture({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "controls.json": {
      controls: {
        rtkPasswordEdit: {
          selectors: [{ automationId: "rtkPasswordEdit$", match: "regex" }],
          aliases: ["密码", "Token Manager"]
        }
      }
    },
    "workflows.json": { workflows: [{ id: "w", steps: [{ tool: "ui_get", args: { selector: { automationId: "passwordInput" } } }] }] }
  });
  assert.ok(!v.warnings.some((x) => x.code === "SENSITIVE_VALUE"), JSON.stringify(v.warnings));
});

test("validator integration: env-reference args do not warn", async () => {
  const v = await validateFixture({
    "manifest.json": MANIFEST,
    "profile.json": PROFILE,
    "workflows.json": {
      workflows: [{
        id: "w",
        steps: [{ tool: "type_text", args: { password: "${env.RTK_PASSWORD}", authorization: "Bearer ${env.API_TOKEN}" } }]
      }]
    }
  });
  assert.ok(!v.warnings.some((x) => x.code === "SENSITIVE_VALUE"), JSON.stringify(v.warnings));
});

// ── new coverage: uppercase literals, neutral executable args, nesting, files ──

test("warn: uppercase literals under sensitive fields", () => {
  const cases: Array<[string, string]> = [
    ["password", "SUPERSECRET123"],
    ["token", "ABCDEF1234567890"],
    ["clientSecret", "PRODUCTIONSECRET"],
    ["apiKey", "AKIA1234567890ABCDEF"]
  ];
  for (const [field, value] of cases) {
    const input = workflowWithArgs({ [field]: value });
    const paths = scan(input);
    assert.ok(paths.length > 0, `'${field}' must warn, got ${JSON.stringify(paths)}`);
  }
});

test("warn: executable args key/path/source/file are not excluded by field name", () => {
  const cases: Array<[string, string]> = [
    ["key", "AKIA1234567890ABCDEF"],
    ["path", "https://user:supersecret@example.com"],
    ["source", "Bearer abcdef1234567890"],
    ["file", "connection password=literal-secret"]
  ];
  for (const [field, value] of cases) {
    const input = workflowWithArgs({ [field]: value });
    const paths = scan(input);
    assert.ok(paths.includes(`workflows.configure.steps[0].args.${field}`), `'${field}' must warn, got ${JSON.stringify(paths)}`);
  }
});

test("no-warn: env-name fields and ${...} references stay safe", () => {
  const envInput: SensitiveScanInput = {
    profile: { executableEnv: "MY_APP_TOKEN", environmentVariable: "RTK_PASSWORD" },
    workflows: [],
    actions: []
  };
  assert.deepEqual(scan(envInput), []);
  const refInput = workflowWithArgs({ password: "${env.RTK_PASSWORD}", token: "${inputs.password}", authorization: "Bearer ${env.API_TOKEN}", auth: "Basic ${inputs.credentials}" });
  assert.deepEqual(scan(refInput), []);
});

test("warn: nested inputSchema literals are found at any depth", () => {
  const nested: SensitiveScanInput = {
    profile: {},
    workflows: [{
      id: "configure",
      steps: [],
      inputSchema: {
        properties: {
          credentials: {
            type: "object",
            properties: {
              password: { type: "string", default: "hardcoded-secret" }
            }
          }
        }
      }
    }],
    actions: []
  };
  const paths = scan(nested);
  assert.ok(paths.includes("workflows.configure.inputSchema.properties.credentials.properties.password.default"), JSON.stringify(paths));
});

test("warn: inputSchema items/oneOf/allOf/additionalProperties literals", () => {
  const schema: SensitiveScanInput = {
    profile: {},
    workflows: [{
      id: "configure",
      steps: [],
      inputSchema: {
        properties: {
          list: { type: "array", items: { type: "object", properties: { token: { type: "string", example: "literal-token-value" } } } },
          choice: { oneOf: [{ type: "string" }, { type: "object", properties: { clientSecret: { type: "string", const: "hardcoded-const" } } }] },
          combo: { allOf: [{ properties: { authorization: { type: "string", examples: ["Bearer abcdef123456"] } } }] },
          map: { type: "object", additionalProperties: { properties: { apiKey: { type: "string", enum: ["AKIA1234567890ABCDEF"] } } } }
        }
      }
    }],
    actions: []
  };
  const paths = scan(schema);
  for (const expected of [
    "workflows.configure.inputSchema.properties.list.items.properties.token.example",
    "workflows.configure.inputSchema.properties.choice.oneOf[1].properties.clientSecret.const",
    "workflows.configure.inputSchema.properties.combo.allOf[0].properties.authorization.examples[0]",
    "workflows.configure.inputSchema.properties.map.additionalProperties.properties.apiKey.enum[0]"
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}; got ${JSON.stringify(paths)}`);
  }
});

test("no-warn: inputSchema description/title are never scanned", () => {
  const schema: SensitiveScanInput = {
    profile: {},
    workflows: [{
      id: "w",
      steps: [],
      inputSchema: {
        properties: {
          password: { type: "string", description: "Password used for authentication", title: "Secret Settings" }
        }
      }
    }],
    actions: []
  };
  assert.deepEqual(scan(schema), []);
});

test("file: findings carry the correct source file", async () => {
  // Profile scanning is restricted to executableEnv (an env NAME); a literal
  // that is NOT a valid env name still warns with file profile.json.
  const profileOnly: SensitiveScanInput = {
    profile: { executableEnv: "Bearer PROFILELITERALTOKEN" },
    workflows: [],
    actions: []
  };
  const pf = scanSensitiveValues(profileOnly).findings;
  assert.equal(pf.length, 1);
  assert.equal(pf[0]!.file, "profile.json");
  assert.equal(pf[0]!.path, "profile.executableEnv");

  const wfOnly: SensitiveScanInput = {
    profile: {},
    workflows: [{ id: "w", steps: [{ tool: "type_text", args: { password: "WORKFLOWLITERAL" } }] }],
    actions: []
  };
  const wf = scanSensitiveValues(wfOnly).findings;
  assert.equal(wf.length, 1);
  assert.equal(wf[0]!.file, "workflows.json");
  assert.equal(wf[0]!.path, "workflows.w.steps[0].args.password");

  const actionOnly: SensitiveScanInput = {
    profile: {},
    workflows: [],
    actions: [{ control: "x", action: "invoke", defaultExpect: { profileControl: "y", condition: "valueEquals", expectedValue: "Bearer ACTIONLITERALTOKEN" } }]
  };
  const af = scanSensitiveValues(actionOnly).findings;
  assert.equal(af.length, 1);
  assert.equal(af[0]!.file, "actions.json");
  assert.equal(af[0]!.path, "actions.contracts[0].defaultExpect.expectedValue");
});

test("redaction: no raw value in serialized findings for all new cases", () => {
  const secrets = ["SUPERSECRET123", "AKIA1234567890ABCDEF", "Bearer abcdef1234567890", "hardcoded-secret"];
  const input = workflowWithArgs({
    password: secrets[0]!,
    apiKey: secrets[1]!,
    source: secrets[2]!,
    token: "nested"
  });
  const result = scanSensitiveValues(input);
  const serialized = JSON.stringify(result);
  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret), `raw secret leaked: ${secret}`);
  }
  for (const f of result.findings) {
    assert.ok(!f.redactedPreview.includes("SUPERSECRET123"));
  }
});

// ── edge: workflow TOP-LEVEL captureBefore ──

test("warn: workflow top-level captureBefore.read.args literal secret", () => {
  const input: SensitiveScanInput = {
    profile: {},
    workflows: [{
      id: "configure",
      steps: [],
      captureBefore: [{
        saveAs: "state",
        read: { tool: "ui_get", args: { password: "literal-secret" } }
      }]
    }],
    actions: []
  };
  const result = scanSensitiveValues(input);
  assert.equal(result.findings.length, 1);
  const f = result.findings[0]!;
  assert.equal(f.file, "workflows.json");
  assert.equal(f.context, "workflow_args");
  assert.equal(f.path, "workflows.configure.captureBefore[0].read.args.password");
  assert.ok(!JSON.stringify(result).includes("literal-secret"), "finding must not leak the raw secret");
});

test("warn: top-level captureBefore warns alongside step-level captureBefore", () => {
  const input: SensitiveScanInput = {
    profile: {},
    workflows: [{
      id: "configure",
      captureBefore: [{
        saveAs: "before",
        read: { tool: "ui_get", args: { token: "TOPLEVELTOKEN123" } }
      }],
      steps: [{
        tool: "profile_action",
        args: { control: "x", action: "invoke" },
        captureBefore: { saveAs: "step", read: { tool: "ui_get", args: { token: "STEPLEVELTOKEN123" } } }
      }],
      finally: [{
        tool: "send_key",
        args: { key: "esc" },
        captureBefore: { saveAs: "fin", read: { tool: "ui_get", args: { token: "FINALLYTOKEN123" } } }
      }]
    }],
    actions: []
  };
  const result = scanSensitiveValues(input);
  const paths = result.findings.map((f) => f.path);
  assert.ok(paths.includes("workflows.configure.captureBefore[0].read.args.token"), JSON.stringify(paths));
  assert.ok(paths.includes("workflows.configure.steps[0].captureBefore.read.args.token"), JSON.stringify(paths));
  assert.ok(paths.includes("workflows.configure.finally[0].captureBefore.read.args.token"), JSON.stringify(paths));
});

// ── edge: profile metadata is NOT blind-scanned ──

test("no-warn: profile identity/window/process metadata is not a credential position", () => {
  const input: SensitiveScanInput = {
    profile: {
      id: "sk-tool",
      displayName: "Bearer Diagnostics",
      executableNames: ["sk-tool.exe"],
      processNames: ["token-agent"],
      mainWindow: { title: "Token Manager", className: "PasswordWindowClass" },
      titleContains: ["Token"],
      submenuAidPatterns: ["^token-"]
    },
    workflows: [],
    actions: []
  };
  const result = scanSensitiveValues(input);
  assert.deepEqual(result.findings, [], "profile metadata must not produce findings: " + JSON.stringify(result.findings));
});

// ── edge: env-name exemption validates VALUE format ──

test("no-warn: env-name fields with valid env-name VALUES stay exempt", () => {
  const input: SensitiveScanInput = {
    profile: { executableEnv: "MY_APP_TOKEN" },
    workflows: [{ id: "w", steps: [{ tool: "type_text", args: { envName: "API_TOKEN", envVar: "RTK_PASSWORD" } }] }],
    actions: []
  };
  assert.deepEqual(scan(input), []);
});

test("warn: env-name fields carrying credential literals are flagged", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ envName: "Bearer literal-token" }, "envName"],
    [{ envVar: "https://user:pass@example.com" }, "envVar"],
    [{ envKey: "password=literal-secret" }, "envKey"]
  ];
  for (const [args, field] of cases) {
    const input = workflowWithArgs(args);
    const result = scanSensitiveValues(input);
    const f = result.findings.find((x) => x.path === `workflows.configure.steps[0].args.${field}`);
    assert.ok(f, `envName field '${field}' with credential literal must warn, got ${JSON.stringify(result.findings.map((x) => x.path))}`);
    assert.equal(f!.context, "workflow_args");
    assert.equal(f!.file, "workflows.json");
    assert.ok(!JSON.stringify(result).includes(args[field]!), "raw value must not leak");
  }
});

test("no-warn: invalid env-name value without secret shape is ordinary text, not exempted", () => {
  const input = workflowWithArgs({ envName: "not a valid env name" });
  const result = scanSensitiveValues(input);
  assert.deepEqual(result.findings, []);
});
