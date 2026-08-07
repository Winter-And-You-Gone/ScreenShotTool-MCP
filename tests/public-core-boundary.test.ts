// Public-core boundary: the tracked public source and automatic tests must
// NOT depend on the private VaporView application or its private App Pack.
//
// VaporView lives in the gitignored local-app-packs/vaporview/ directory; its
// smoke tests live there too (local-app-packs/vaporview/tests/). This test
// enforces that the public repository stays generic: no VaporView executable
// path, profile id, control id, or private-pack assumption may appear in
// src/ or the tracked public tests.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(".");

// VaporView-specific tokens that must never appear in the public core.
const FORBIDDEN_PATTERNS = [
  "VaporView",
  "X:\\Project\\GPS\\VaporView",
  "X:/Project/GPS/VaporView",
  "sidebarTemperature",
  "local-app-packs/vaporview",
  "local-app-packs\\vaporview"
];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function scan(dir: string): Array<{ file: string; match: string }> {
  const hits: Array<{ file: string; match: string }> = [];
  for (const file of walkFiles(dir)) {
    const rel = path.relative(ROOT, file);
    // Only source/test files are scanned (never node_modules, outputs, dist).
    if (!/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(file)) continue;
    if (file.includes("node_modules") || file.includes(`${path.sep}dist${path.sep}`) || file.includes(`${path.sep}outputs${path.sep}`)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (content.includes(pattern)) {
        hits.push({ file: rel, match: pattern });
      }
    }
  }
  return hits;
}

test("public src/ contains no VaporView-specific references", () => {
  const hits = scan(path.join(ROOT, "src"));
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.match}`),
    [],
    "public source must not reference the private VaporView app or its pack"
  );
});

test("public tracked tests contain no VaporView-specific references", () => {
  // Scan scope: AUTOMATIC tests (tests/*.test.ts - collected by npm test).
  // Deliberate exceptions (documented, not execution dependencies):
  //  - interaction.test.ts verifies the PRIVATE pack's interaction config;
  //    it SKIPS when local-app-packs/vaporview is absent, so the public test
  //    suite never fails without the private pack.
  //  - semantic-map.test.ts / semantic-runtime.test.ts / process-lifetime-
  //    integration.test.ts mention VaporView in NEGATIVE assertions or
  //    comments ("never VaporView", "no VaporView strings") - they prove
  //    independence, they do not depend on it.
  // Not scanned: smoke-*.ts manual scripts (not collected by npm test; some
  // pre-date this boundary and verify the private app - they run explicitly,
  // never in CI).
  const hits = scan(path.join(ROOT, "tests"))
    .filter((h) => h.file.endsWith(".test.ts")) // automatic tests only
    .filter((h) => !h.file.endsWith("public-core-boundary.test.ts")) // self-reference excluded
    .filter((h) => !h.file.endsWith("interaction.test.ts")) // conditional private-pack verification (skips when absent)
    .filter((h) => !h.file.endsWith("semantic-map.test.ts")) // negative assertion only
    .filter((h) => !h.file.endsWith("semantic-runtime.test.ts")) // negative assertion / comment only
    .filter((h) => !h.file.endsWith("process-lifetime-integration.test.ts")); // "never VaporView" comment only
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.match}`),
    [],
    "public automatic tests must not reference VaporView, its pack, or its controls"
  );
});

test("the VaporView-specific lifetime smoke is NOT tracked by git", () => {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  const lines = tracked.split(/\r?\n/);
  const smokeFiles = lines.filter((l) => l.includes("smoke-lifetime"));
  assert.deepEqual(smokeFiles, [], `no VaporView-specific smoke may be tracked; found: ${smokeFiles.join(", ")}`);
});

test("private pack directory remains gitignored", () => {
  const ignored = execFileSync("git", ["check-ignore", "local-app-packs/vaporview/manifest.json"], { encoding: "utf8" }).trim();
  assert.equal(ignored.length > 0, true, "local-app-packs/vaporview must be gitignored");
});
