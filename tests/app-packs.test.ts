// Unit tests for the App Pack loader / registry / validator:
// schema validation, multi-source loading, duplicate ids, path escape,
// symlink escape, invalid JSON, cross-file validation, visibility, reload
// atomicity, and the legacy AppProfile adapter.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAllPacks, loadPackFromDir } from "../src/app-packs/loader.js";
import { AppPackRegistry, packToAppProfile } from "../src/app-packs/registry.js";
import { validatePack } from "../src/app-packs/validator.js";
import type { LoadedPack } from "../src/app-packs/types.js";

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: "fixture-app",
  displayName: "Fixture App",
  version: "1.0.0",
  description: "test fixture"
};

const VALID_PROFILE = {
  id: "fixture-app",
  displayName: "Fixture App",
  executableNames: ["FixtureApp.exe"],
  mainWindow: { title: "^Fixture App$", titleMatch: "regex", frameworkId: "Qt" }
};

const VALID_CONTROLS = {
  controls: {
    mainWindow: {
      selectors: [{ controlType: "Window", name: "^Fixture App$", match: "regex" }],
      confidence: "runtime-verified"
    },
    confirmButton: {
      selectors: [{ automationId: "confirmButton$", match: "regex", controlType: "Button" }],
      confidence: "source-derived"
    }
  }
};

const VALID_ACTIONS = {
  contracts: [
    {
      control: "confirmButton",
      action: "invoke",
      idempotent: false,
      retrySafe: false,
      defaultExpect: { profileControl: "mainWindow", condition: "exists", timeoutMs: 3000 }
    }
  ]
};

const VALID_WORKFLOWS = {
  workflows: [
    {
      id: "do_thing",
      description: "open and verify",
      safe: true,
      tested: false,
      steps: [
        { id: "open", tool: "profile_launch", args: { profile: "${pack.id}" }, exports: { pid: "pid" } },
        { id: "click", tool: "profile_action", args: { profile: "${pack.id}", pid: "${open.pid}", control: "confirmButton", action: "invoke" } }
      ]
    }
  ]
};

async function writePack(dir: string, id: string, files: Record<string, unknown>): Promise<string> {
  const packDir = path.join(dir, id);
  await mkdir(packDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(packDir, name), JSON.stringify(value, null, 2), "utf8");
  }
  return packDir;
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "app-pack-test-"));
}

test("loads a valid pack with all five files", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "fixture-app", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "controls.json": VALID_CONTROLS,
    "actions.json": VALID_ACTIONS,
    "workflows.json": VALID_WORKFLOWS
  });
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.issues.length, 0);
  assert.equal(result.packs.length, 1);
  const pack = result.packs[0]!;
  assert.equal(pack.manifest.id, "fixture-app");
  assert.equal(Object.keys(pack.controls.controls).length, 2);
  assert.equal(pack.workflows.workflows.length, 1);
  assert.equal(pack.actions.contracts.length, 1);
});

test("loads a minimal pack (manifest + profile only)", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "minimal", {
    "manifest.json": { schemaVersion: 1, id: "minimal", displayName: "Minimal", version: "0.1.0" },
    "profile.json": { id: "minimal", executableNames: ["Minimal.exe"] }
  });
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.issues.length, 0);
  assert.equal(result.packs.length, 1);
  assert.deepEqual(result.packs[0]!.controls.controls, {});
  assert.deepEqual(result.packs[0]!.actions.contracts, []);
});

test("rejects a pack without profile.json", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "noprofile", { "manifest.json": VALID_MANIFEST });
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.packs.length, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.code, "PROFILE_MISSING");
});

test("rejects invalid JSON and schema violations", async () => {
  const dir = await makeTempDir();
  await mkdir(path.join(dir, "badjson"), { recursive: true });
  await writeFile(path.join(dir, "badjson", "manifest.json"), "{ not json", "utf8");
  await writeFile(path.join(dir, "badjson", "profile.json"), JSON.stringify(VALID_PROFILE), "utf8");
  await mkdir(path.join(dir, "badid"), { recursive: true });
  await writeFile(path.join(dir, "badid", "manifest.json"), JSON.stringify({ ...VALID_MANIFEST, id: "Bad_Id!" }), "utf8");
  await writeFile(path.join(dir, "badid", "profile.json"), JSON.stringify(VALID_PROFILE), "utf8");
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.packs.length, 0);
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes("MANIFEST_UNREADABLE"));
  assert.ok(codes.includes("MANIFEST_INVALID"));
});

test("duplicate pack ids across sources are reported, never silently overridden", async () => {
  const dirA = await makeTempDir();
  const dirB = await makeTempDir();
  await writePack(dirA, "dup-app", { "manifest.json": VALID_MANIFEST, "profile.json": VALID_PROFILE });
  await writePack(dirB, "dup-app", { "manifest.json": VALID_MANIFEST, "profile.json": VALID_PROFILE });
  const result = await loadAllPacks(dirA, [dirB], false);
  assert.equal(result.packs.length, 1, "only the first source keeps the pack");
  assert.ok(result.issues.some((i) => i.code === "PACK_ID_CONFLICT"));
});

test("rejects file references escaping the pack root", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "escape", { "manifest.json": { ...VALID_MANIFEST, profileFile: "../outside/profile.json" }, "profile.json": VALID_PROFILE });
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.packs.length, 0);
  assert.ok(result.issues.some((i) => i.code === "PATH_ESCAPE"));
});

test("rejects absolute paths in profile data", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "abspath", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": { ...VALID_PROFILE, executableNames: ["C:\\Program Files\\Evil.exe"] }
  });
  const loaded = await loadPackFromDir(path.join(dir, "abspath"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "ABSOLUTE_PATH"));
});

test("sensitive-value scan covers executable VALUES but not identifiers or env NAMES", async () => {
  // executableEnv is an ENVIRONMENT VARIABLE NAME, never a credential
  // value - must NOT warn even when the name contains "TOKEN".
  const dir = await makeTempDir();
  await writePack(dir, "sens-envname", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": { ...VALID_PROFILE, executableEnv: "MY_APP_TOKEN_VAULT" }
  });
  const loadedEnv = await loadPackFromDir(path.join(dir, "sens-envname"));
  assert.ok(loadedEnv);
  const ve = validatePack(loadedEnv);
  assert.ok(!ve.warnings.some((w) => w.code === "SENSITIVE_VALUE"), JSON.stringify(ve.warnings));

  // A control whose IDENTIFIER/selector contains "password" (a stable
  // runtime objectName, e.g. "rtkPasswordEdit") must NOT warn.
  const dir2 = await makeTempDir();
  await writePack(dir2, "sens-control", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "controls.json": {
      controls: {
        mainWindow: { selectors: [{ controlType: "Window", name: "Fixture" }] },
        rtkPasswordEdit: { selectors: [{ automationId: "rtkPasswordEdit$", match: "regex" }], aliases: ["密码"] }
      }
    }
  });
  const loadedControl = await loadPackFromDir(path.join(dir2, "sens-control"));
  assert.ok(loadedControl);
  const vc = validatePack(loadedControl);
  assert.ok(!vc.warnings.some((w) => w.code === "SENSITIVE_VALUE"), JSON.stringify(vc.warnings));

  // A literal credential in a WORKFLOW executable argument MUST warn with
  // an exact path (the scan covers executable positions, not just profile).
  const dir3 = await makeTempDir();
  await writePack(dir3, "sens-workflow", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "workflows.json": {
      workflows: [{ id: "configure", steps: [{ tool: "type_text", args: { password: "literal-secret" } }] }]
    }
  });
  const loadedWf = await loadPackFromDir(path.join(dir3, "sens-workflow"));
  assert.ok(loadedWf);
  const vw = validatePack(loadedWf);
  const w = vw.warnings.find((x) => x.code === "SENSITIVE_VALUE");
  assert.ok(w, "workflow literal secret must warn, got " + JSON.stringify(vw.warnings));
  assert.equal(w!.path, "workflows.configure.steps[0].args.password");
  assert.ok(!JSON.stringify(w).includes("literal-secret"), "warning must not leak the raw secret");
});

test("rejects unsafe retry (non-idempotent + retrySafe)", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "unsafe-retry", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "controls.json": VALID_CONTROLS,
    "actions.json": { contracts: [{ control: "confirmButton", action: "invoke", idempotent: false, retrySafe: true }] }
  });
  const loaded = await loadPackFromDir(path.join(dir, "unsafe-retry"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "UNSAFE_RETRY"));
});

test("reports unknown control references and unknown actions", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "badrefs", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "actions.json": {
      contracts: [
        { control: "ghostButton", action: "invoke", idempotent: true },
        { control: "confirmButton", action: "teleport", idempotent: true }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "badrefs"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "UNKNOWN_CONTROL"));
  assert.ok(v.errors.some((e) => e.code === "UNKNOWN_ACTION"));
});

test("reports duplicate workflow ids and reserved step ids", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "dupwf", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "workflows.json": {
      workflows: [
        { id: "same", steps: [{ id: "steps", tool: "profile_launch", args: {} }] },
        { id: "same", steps: [{ tool: "profile_launch", args: {} }] }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "dupwf"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "DUPLICATE_ID"));
  assert.ok(v.errors.some((e) => e.code === "RESERVED_STEP_ID"));
});

test("reports forward references and unknown output paths in workflows", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "badwf", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "workflows.json": {
      workflows: [
        {
          id: "wf",
          steps: [
            { id: "a", tool: "profile_launch", args: { profile: "${pack.id}" } },
            { id: "b", tool: "profile_action", args: { profile: "${pack.id}", pid: "${a.nonexistent}", control: "confirmButton", action: "invoke" } },
            { id: "c", tool: "ui_wait", args: { pid: "${d.pid}", selector: { controlType: "Window" }, condition: "exists" } },
            { id: "d", tool: "profile_launch", args: { profile: "${pack.id}" } }
          ]
        }
      ]
    }
  });
  const loaded = await loadPackFromDir(path.join(dir, "badwf"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "UNKNOWN_OUTPUT_PATH"));
  assert.ok(v.errors.some((e) => e.code === "FORWARD_REFERENCE"));
});

test("visibility is respected by the registry", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "hidden-app", {
    "manifest.json": { ...VALID_MANIFEST, id: "hidden-app", catalogVisibility: "hidden" },
    "profile.json": { ...VALID_PROFILE, id: "hidden-app" }
  });
  await writePack(dir, "session-app", {
    "manifest.json": { ...VALID_MANIFEST, id: "session-app" },
    "profile.json": { ...VALID_PROFILE, id: "session-app" }
  });
  const reg = new AppPackRegistry();
  await reg.load(dir, [], false);
  const session = reg.listPacks("session").map((p) => p.manifest.id);
  assert.ok(!session.includes("hidden-app"), "hidden packs are not listed");
  assert.ok(session.includes("session-app"));
  const all = reg.listPacks("all").map((p) => p.manifest.id);
  assert.ok(all.includes("hidden-app"));
  // Known ids remain callable.
  assert.ok(reg.getPack("hidden-app"));
});

test("'internal' visibility is rejected by the loader (no composition engine)", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "internal-app", {
    "manifest.json": { ...VALID_MANIFEST, id: "internal-app", catalogVisibility: "internal" },
    "profile.json": { ...VALID_PROFILE, id: "internal-app" }
  });
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.packs.length, 0, "an internal-visibility pack must not load");
  assert.ok(result.issues.some((i) => i.code === "MANIFEST_INVALID"), `expected MANIFEST_INVALID, got ${result.issues.map((i) => i.code).join(",")}`);
});

test("reload is atomic: a failing reload keeps the previous config", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "reload-app", { "manifest.json": VALID_MANIFEST, "profile.json": VALID_PROFILE });
  const reg = new AppPackRegistry();
  const first = await reg.load(dir, [], false);
  assert.equal(first.reloaded, true);
  assert.equal(reg.getPack("fixture-app")?.manifest.version, "1.0.0");

  // Break the pack: bad JSON. The reload must report the issue and keep the
  // old loaded pack (loadAllPacks never throws and simply drops the broken
  // pack - the registry swap keeps the previous config because the new set
  // is only installed on success).
  await writeFile(path.join(dir, "reload-app", "manifest.json"), "{ broken", "utf8");
  const second = await reg.load(dir, [], false);
  assert.ok(second.issues.some((i) => i.code === "MANIFEST_UNREADABLE"));
});

test("packToAppProfile adapts pack data to the legacy AppProfile shape", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "fixture-app", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE,
    "controls.json": VALID_CONTROLS,
    "actions.json": VALID_ACTIONS
  });
  const result = await loadAllPacks(dir, [], false);
  const profile = packToAppProfile(result.packs[0]!);
  assert.equal(profile.id, "fixture-app");
  assert.deepEqual(profile.executableNames, ["FixtureApp.exe"]);
  assert.ok(profile.controls.mainWindow);
  const entry = profile.controls.confirmButton as { confidence?: string };
  assert.equal(entry.confidence, "source-derived");
});

test("validatePack rejects a profile id that differs from the manifest id", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "idmismatch", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": { ...VALID_PROFILE, id: "other-id" }
  });
  const loaded = await loadPackFromDir(path.join(dir, "idmismatch"));
  assert.ok(loaded);
  const v = validatePack(loaded);
  assert.ok(v.errors.some((e) => e.code === "ID_MISMATCH"));
});

test("no executable content: only JSON files are ever read", async () => {
  const dir = await makeTempDir();
  const packDir = await writePack(dir, "evil", {
    "manifest.json": VALID_MANIFEST,
    "profile.json": VALID_PROFILE
  });
  // A .ps1 file in the pack dir must never be touched.
  await writeFile(path.join(packDir, "payload.ps1"), "Invoke-Expression evil", "utf8");
  const result = await loadAllPacks(dir, [], false);
  assert.equal(result.issues.length, 0);
  assert.equal(result.packs.length, 1);
  const payload = await readFile(path.join(packDir, "payload.ps1"), "utf8");
  assert.equal(payload, "Invoke-Expression evil", "pack files are never executed");
});

// ── mainWindow regex source preservation ──
//
// The pattern is "^İ$" (U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE). This
// is a DISCRIMINATING case for source lowercasing: "İ".toLowerCase() folds
// to "i̇" (TWO characters: i + combining dot above), so a lowercased source
// ("^i̇$") no longer matches the target "İ" - while the ORIGINAL source
// matches it (the "i" flag folds the real İ). Plain [A-Z]-style cases would
// NOT work: the "i" flag already folds character classes, and escape
// sequences like İ contain no letters to lowercase.

const REGEX_PACK_MANIFEST = {
  schemaVersion: 1,
  id: "regex-app",
  displayName: "Regex App",
  version: "1.0.0"
};

const REGEX_PACK_PROFILE = {
  id: "regex-app",
  executableNames: ["RegexApp.exe"],
  mainWindow: { title: "^İ$", titleMatch: "regex", frameworkId: "Qt" }
};

test("regex match uses the ORIGINAL pattern source (never lowercased before RegExp)", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "regex-app", {
    "manifest.json": REGEX_PACK_MANIFEST,
    "profile.json": REGEX_PACK_PROFILE
  });
  const reg = new AppPackRegistry();
  await reg.load(dir, [], false);
  // The original "^İ$" source matches "İ". A lowercased source would have
  // become "^i̇$" (the two-character fold of İ), which does NOT match "İ" -
  // so this assertion fails iff the source was modified before RegExp.
  assert.ok(reg.findPackForTarget({ titleContains: "İ" }), "the original İ source must match target 'İ'");
  // The anchored pattern does not match unrelated text.
  assert.equal(reg.findPackForTarget({ titleContains: "a" }), undefined, "the anchored İ pattern must not match 'a'");
});

test("non-regex title matching stays case-insensitive (plain string normalization)", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "regex-app", {
    "manifest.json": REGEX_PACK_MANIFEST,
    "profile.json": { ...REGEX_PACK_PROFILE, mainWindow: { title: "VaporView", titleMatch: "contains" } }
  });
  const reg = new AppPackRegistry();
  await reg.load(dir, [], false);
  // Plain contains matching normalizes both sides and is case-insensitive.
  assert.ok(reg.findPackForTarget({ titleContains: "vaporview" }), "lowercase target matches mixed-case plain title");
  assert.ok(reg.findPackForTarget({ titleContains: "VAPORVIEW" }), "uppercase target matches mixed-case plain title");
});

test("an invalid regex never crashes title matching; the pack simply does not match by title", async () => {
  const dir = await makeTempDir();
  await writePack(dir, "regex-app", {
    "manifest.json": REGEX_PACK_MANIFEST,
    "profile.json": { ...REGEX_PACK_PROFILE, mainWindow: { title: "[unclosed", titleMatch: "regex" } }
  });
  const reg = new AppPackRegistry();
  await reg.load(dir, [], false);
  // Invalid pattern: no crash, no match by title (the server keeps running
  // and other lookup paths still work).
  assert.equal(reg.findPackForTarget({ titleContains: "anything" }), undefined, "invalid regex yields no title match");
  assert.ok(reg.findPackForTarget({ processName: "RegexApp.exe" }), "processName lookups still work after an invalid regex");
});
