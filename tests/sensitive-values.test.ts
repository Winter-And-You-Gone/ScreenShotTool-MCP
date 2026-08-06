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

// ── classification unit checks ──

test("classify: sensitive field with ALL_CAPS value is treated as ordinary text (ambiguous env name)", () => {
  const cls = classifyStringAtPath("workflows.w.steps[0].args.password", "MY_REAL_PASSWORD");
  assert.equal(cls.kind, "ordinary_text");
});

test("classify: literal under sensitive field warns", () => {
  const cls = classifyStringAtPath("workflows.w.steps[0].args.password", "literal-secret");
  assert.equal(cls.kind, "likely_sensitive_literal");
});

test("classify: executableEnv never warns regardless of value shape", () => {
  const cls = classifyStringAtPath("profile.executableEnv", "MY_APP_TOKEN");
  assert.equal(cls.kind, "environment_reference");
});

test("classify: selector subtree values are identifiers", () => {
  const cls = classifyStringAtPath("workflows.w.steps[0].args.selector.automationId", "passwordInput");
  assert.equal(cls.kind, "excluded_identifier");
});

test("classify: identifier leaf names never warn", () => {
  for (const leaf of ["id", "aliases", "displayName", "notes", "reason", "role", "mappingStatus", "saveAs"]) {
    const cls = classifyStringAtPath(`workflows.w.steps[0].args.${leaf}`, "passwordInput");
    assert.equal(cls.kind, "excluded_identifier", `leaf '${leaf}' must be excluded`);
  }
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
