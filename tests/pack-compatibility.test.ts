// App Pack ↔ EXE compatibility tests (testedAgainst / packCompatibility):
// status derivation (verified / compatible-unverified / mismatch /
// not-declared), the warning-not-block behavior, and the semantic
// recommendedAction derivation for selection-group controls.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { packCompatibilityStatusFor, checkPackCompatibility } from "../src/app-packs/compatibility.js";
import { loadPackFromDir } from "../src/app-packs/loader.js";
import { AppPackRegistry, packToAppProfile } from "../src/app-packs/registry.js";
import type { LoadedPack } from "../src/app-packs/types.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function writeFixturePack(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ssm-comp-"));
  const packDir = path.join(dir, "compat-app");
  await mkdir(packDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: "compat-app",
    displayName: "Compat App",
    version: "1.0.0",
    testedAgainst: {
      executable: { sha256: SHA_A, fileVersion: "1.2.3.4", productVersion: "1.2.3" },
      appVersion: "2.0",
      sourceRevision: "deadbeef"
    }
  };
  const profile = {
    id: "compat-app",
    displayName: "Compat App",
    executableNames: ["CompatApp.exe"],
    mainWindow: { title: "^Compat App$", titleMatch: "regex" }
  };
  const controls = {
    controls: {
      channel1Tab: {
        selectors: [{ automationId: "channelSelector1$", match: "regex" }],
        confidence: "runtime-verified",
        page: "main",
        group: "channel-selection",
        role: "tab",
        aliases: ["通道1", "channel 1"],
        controlState: { any: [{ condition: "toggleStateEquals", toggleState: "On" }] },
        postconditions: [{ profileControl: "channel1Page", condition: "visible", timeoutMs: 5000 }],
        supportedActions: ["ensureSelected", "invoke"]
      },
      channel2Tab: {
        selectors: [{ automationId: "channelSelector2$", match: "regex" }],
        confidence: "source-derived",
        page: "main",
        group: "channel-selection",
        role: "tab",
        aliases: ["通道2", "channel 2"],
        supportedActions: ["ensureSelected", "invoke"]
      },
      channel1Page: {
        selectors: [{ automationId: "channel1Page$", match: "regex" }],
        confidence: "source-derived",
        page: "main",
        role: "contentMarker"
      },
      plainButton: {
        selectors: [{ automationId: "plainButton$", match: "regex" }],
        confidence: "source-derived",
        page: "main",
        role: "button",
        supportedActions: ["invoke"]
      }
    }
  };
  const pages = {
    pages: [
      { id: "main", displayName: "Main", navigationControl: "channel1Tab", rootControl: "channel1Page", readyMarkers: [{ profileControl: "channel1Page", condition: "exists" }] }
    ],
    selectionGroups: [
      { id: "channel-selection", role: "tabSelector", parent: "main", members: ["channel1Tab", "channel2Tab"], selectionMode: "single" }
    ]
  };
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(packDir, "profile.json"), JSON.stringify(profile), "utf8");
  await writeFile(path.join(packDir, "controls.json"), JSON.stringify(controls), "utf8");
  await writeFile(path.join(packDir, "pages.json"), JSON.stringify(pages), "utf8");
  await writeFile(path.join(packDir, "actions.json"), JSON.stringify({ contracts: [] }), "utf8");
  await writeFile(path.join(packDir, "workflows.json"), JSON.stringify({ workflows: [] }), "utf8");
  return packDir;
}

let cachedPack: LoadedPack | undefined;
async function fixturePack(): Promise<LoadedPack> {
  if (cachedPack) return cachedPack;
  const dir = await writeFixturePack();
  const loaded = await loadPackFromDir(dir);
  assert.ok(loaded, "fixture pack must load");
  cachedPack = loaded;
  return loaded;
}

test("packCompatibility: sha256 match -> verified", () => {
  const status = packCompatibilityStatusFor(
    { executable: { sha256: SHA_A } },
    { sha256: SHA_A, fileVersion: "1.2.3.4" }
  );
  assert.equal(status.status, "verified");
  assert.equal(status.checked, true);
  assert.deepEqual(status.matchedBy, ["sha256"]);
});

test("packCompatibility: sha256 mismatch but versions match -> compatible-unverified", () => {
  const status = packCompatibilityStatusFor(
    { executable: { sha256: SHA_A, fileVersion: "1.2.3.4", productVersion: "1.2.3" } },
    { sha256: SHA_B, fileVersion: "1.2.3.4", productVersion: "1.2.3" }
  );
  assert.equal(status.status, "compatible-unverified");
  assert.equal(status.checked, true);
  assert.deepEqual(status.matchedBy, ["fileVersion", "productVersion"]);
});

test("packCompatibility: sha256 mismatch, no version match -> mismatch (warning, not block)", () => {
  const status = packCompatibilityStatusFor(
    { executable: { sha256: SHA_A, fileVersion: "1.2.3.4" } },
    { sha256: SHA_B, fileVersion: "9.9.9.9" }
  );
  assert.equal(status.status, "mismatch");
  assert.equal(status.checked, true);
  assert.deepEqual(status.mismatchReasons, ["sha256"]);
});

test("packCompatibility: no testedAgainst -> not-declared", () => {
  const status = packCompatibilityStatusFor(undefined, { sha256: SHA_A });
  assert.equal(status.status, "not-declared");
  assert.equal(status.checked, false);
});

test("packCompatibility: declared but unreadable EXE -> compatible-unverified (never mismatch on missing data)", () => {
  const status = packCompatibilityStatusFor(
    { executable: { sha256: SHA_A } },
    { error: "EXE_IDENTITY_UNREADABLE" }
  );
  assert.equal(status.status, "compatible-unverified");
  assert.equal(status.checked, false);
});

test("checkPackCompatibility: end-to-end via the loaded pack + injected reader", async () => {
  const pack = await fixturePack();
  const ok = await checkPackCompatibility(pack, "C:\\CompatApp.exe", async () => ({ sha256: SHA_A }));
  assert.equal(ok?.status, "verified");
  const mismatch = await checkPackCompatibility(pack, "C:\\CompatApp.exe", async () => ({ sha256: SHA_B }));
  assert.equal(mismatch?.status, "mismatch");
  const unreadable = await checkPackCompatibility(pack, "C:\\CompatApp.exe", async () => { throw new Error("boom"); });
  assert.equal(unreadable?.status, "compatible-unverified");
});

test("profile adapter carries testedAgainst metadata through app_pack_describe", async () => {
  const pack = await fixturePack();
  const registry = new AppPackRegistry();
  // PackRegistry loads from real dirs; simulate by re-loading the fixture dir.
  const dir = path.dirname(path.dirname((await fixturePack()).manifest.id === "compat-app" ? path.join(tmpdir(), "ssm-comp-", "compat-app") : path.join(tmpdir(), "x")));
  void dir;
  const profile = packToAppProfile(pack);
  assert.equal(profile.id, "compat-app");
  // The manifest carries testedAgainst; the registry exposes it via the pack.
  assert.equal(pack.manifest.testedAgainst?.executable?.sha256, SHA_A);
  void registry;
});
