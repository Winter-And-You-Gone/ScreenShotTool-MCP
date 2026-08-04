// App Pack loader.
//
// Loads packs from a prioritized list of sources, each a directory whose
// DIRECT children are pack directories (no recursive scanning):
//
//   1. CLI --app-pack-dir <dir>           (highest priority)
//   2. SCREENSHOT_MCP_APP_PACK_DIRS       (path-separated list)
//   3. %APPDATA%\ScreenShotTool-MCP\app-packs
//   4. <project>/local-app-packs          (private packs, gitignored)
//   5. <project>/app-packs/examples       (public example packs)
//
// Security invariants:
//   - Only the DIRECT children of a source are scanned; each must contain a
//     manifest.json.
//   - Every file referenced by the manifest is resolved and realpath-checked:
//     it must stay INSIDE the pack root (no ../ escape, no symlink escape).
//   - No executable content: files are parsed as JSON only.
//   - Duplicate pack ids across sources are recorded as errors, never
//     silently overridden.

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { packActionsSchema, packControlsSchema, packManifestSchema, packProfileSchema, packWorkflowsSchema } from "./schemas.js";
import type { LoadedPack, PackSourceKind } from "./types.js";

export type LoadIssue = {
  source?: string;
  pack?: string;
  code: string;
  message: string;
};

export type LoadResult = {
  packs: LoadedPack[];
  issues: LoadIssue[];
};

export const MAX_PACKS = 64;
export const MAX_PACK_JSON_BYTES = 2 * 1024 * 1024;

const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleRoot, "..", "..");

// Resolve the project root whether we run from src/ or dist/.
function resolveProjectRoot(): string {
  const dir = path.resolve(moduleRoot, "..");
  if (path.basename(dir) === "dist") return path.resolve(dir, "..");
  if (path.basename(moduleRoot) === "app-packs") return path.resolve(moduleRoot, "..", "..");
  return path.resolve(moduleRoot, "..");
}

export function projectRootDir(): string {
  return resolveProjectRoot();
}

export function defaultPackDirs(): string[] {
  const root = projectRootDir();
  return [
    path.join(root, "local-app-packs"),
    path.join(root, "app-packs", "examples")
  ];
}

// Collect all pack source directories in priority order (highest first).
// A directory that does not exist is skipped silently.
export function collectPackSources(cliDir?: string, envDirs?: string[], includeDefaults = true): Array<{ dir: string; kind: PackSourceKind; label: string }> {
  const sources: Array<{ dir: string; kind: PackSourceKind; label: string }> = [];
  const appData = process.env.APPDATA ? path.join(process.env.APPDATA, "ScreenShotTool-MCP", "app-packs") : "";

  if (cliDir) sources.push({ dir: cliDir, kind: "cli", label: "cli" });
  if (envDirs && envDirs.length > 0) {
    for (const d of envDirs) {
      if (d.trim()) sources.push({ dir: d.trim(), kind: "env", label: "env" });
    }
  }
  if (appData) sources.push({ dir: appData, kind: "appdata", label: "appdata" });
  if (includeDefaults) {
    for (const d of defaultPackDirs()) {
      sources.push({
        dir: d,
        kind: d.endsWith("local-app-packs") ? "local" : "examples",
        label: d.endsWith("local-app-packs") ? "local" : "examples"
      });
    }
  }
  return sources;
}

// Load every pack from every source. Never throws for a bad pack: issues are
// collected and returned. A malformed JSON file, missing manifest, schema
// failure, or security violation marks that pack as errored (not loaded).
export async function loadAllPacks(cliDir?: string, envDirs?: string[], includeDefaults = true): Promise<LoadResult> {
  const sources = collectPackSources(cliDir, envDirs, includeDefaults);
  const result: LoadResult = { packs: [], issues: [] };
  const seenIds = new Map<string, string>(); // id -> source label

  for (const source of sources) {
    const children = await safeReaddir(source.dir);
    for (const child of children) {
      const packDir = path.join(source.dir, child);
      let st;
      try {
        st = await stat(packDir);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (!st.isDirectory()) continue;

      const loaded = await loadPack(packDir, source.label, source.kind);
      if (!loaded) continue;
      if (loaded.issues.length > 0) {
        result.issues.push(...loaded.issues.map((i) => ({ ...i, source: source.label, pack: child })));
        continue;
      }
      const existing = seenIds.get(loaded.pack.manifest.id);
      if (existing !== undefined) {
        result.issues.push({
          source: source.label,
          pack: child,
          code: "PACK_ID_CONFLICT",
          message: `Pack id '${loaded.pack.manifest.id}' is already loaded from source '${existing}'. Duplicate ids are not allowed; remove or rename one pack.`
        });
        continue;
      }
      seenIds.set(loaded.pack.manifest.id, source.label);
      result.packs.push(loaded.pack);
    }
  }

  if (result.packs.length > MAX_PACKS) {
    result.issues.push({
      source: "loader",
      pack: "*",
      code: "TOO_MANY_PACKS",
      message: `Loaded ${result.packs.length} packs; the limit is ${MAX_PACKS}.`
    });
  }
  return result;
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Only direct children; skip anything that is not a plain directory
    // (reparse points like junctions/symlinks are resolved by realpath below
    // and must stay inside the pack root - a symlinked pack directory itself
    // is allowed as long as its own root resolves consistently).
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadPack(
  packDir: string,
  sourceLabel: string,
  sourceKind: PackSourceKind
): Promise<{ pack: LoadedPack; issues: LoadIssue[] } | null> {
  const issues: LoadIssue[] = [];

  // Resolve the pack root through symlinks ONCE; every file reference must
  // resolve back inside this root.
  let root: string;
  try {
    root = await realpath(packDir);
  } catch {
    return null;
  }

  const manifestPath = path.join(root, "manifest.json");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    issues.push({ code: "MANIFEST_UNREADABLE", message: `manifest.json missing or not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return { pack: null as unknown as LoadedPack, issues };
  }
  const manifestParsed = packManifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    issues.push({ code: "MANIFEST_INVALID", message: `manifest.json failed schema validation: ${manifestParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
    return { pack: null as unknown as LoadedPack, issues };
  }
  const manifest = manifestParsed.data;

  // Read profile.json (required). Other files are optional.
  const profile = await readPackJson(packManifestJsonFileName(manifest.profileFile, "profile.json"), root, issues, packProfileSchema);
  const controls = await readPackJson(packManifestJsonFileName(manifest.controlsFile, "controls.json"), root, issues, packControlsSchema);
  const actions = await readPackJson(packManifestJsonFileName(manifest.actionsFile, "actions.json"), root, issues, packActionsSchema);
  const workflows = await readPackJson(packManifestJsonFileName(manifest.workflowsFile, "workflows.json"), root, issues, packWorkflowsSchema);

  if (issues.length > 0) {
    return { pack: null as unknown as LoadedPack, issues };
  }
  if (!profile) {
    issues.push({ code: "PROFILE_MISSING", message: "profile.json is required (missing, unreadable, or invalid)." });
    return { pack: null as unknown as LoadedPack, issues };
  }

  return {
    pack: {
      manifest,
      profile,
      controls: controls ?? { controls: {} },
      actions: actions ?? { contracts: [] },
      workflows: workflows ?? { workflows: [] },
      dir: root,
      source: sourceLabel,
      sourceKind,
      loadedAtMs: Date.now(),
      errors: []
    },
    issues: []
  };
}

function packManifestJsonFileName(declared: string | undefined, fallback: string): string {
  return declared ?? fallback;
}

// Load a single pack DIRECTORY (not a parent directory of packs). Used by
// app_pack_validate {packPath} for local validation without installing the
// pack. Returns undefined when the directory is not a loadable pack.
export async function loadPackFromDir(packDir: string): Promise<LoadedPack | undefined> {
  const loaded = await loadPack(packDir, "explicit", "explicit");
  if (!loaded || loaded.issues.length > 0) return undefined;
  return loaded.pack;
}

// Read + schema-validate a pack JSON file. The file name is resolved against
// the pack root; the resolved path must stay INSIDE the root (rejects ../ and
// symlink escapes). Returns undefined when the file is absent (optional file).
async function readPackJson<O>(
  fileName: string,
  root: string,
  issues: LoadIssue[],
  schema: z.ZodType<O>
): Promise<O | undefined> {
  const rawPath = path.resolve(root, fileName);
  if (!isInsideRoot(root, rawPath)) {
    issues.push({ code: "PATH_ESCAPE", message: `File '${fileName}' resolves outside the pack root; path escape rejected.` });
    return undefined;
  }
  let resolved: string;
  try {
    resolved = await realpath(rawPath);
  } catch {
    return undefined; // optional file absent
  }
  if (!isInsideRoot(root, resolved)) {
    issues.push({ code: "PATH_ESCAPE", message: `File '${fileName}' is a symlink pointing outside the pack root; rejected.` });
    return undefined;
  }
  let st;
  try {
    st = await stat(resolved);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  if (st.size > MAX_PACK_JSON_BYTES) {
    issues.push({ code: "FILE_TOO_LARGE", message: `File '${fileName}' exceeds ${MAX_PACK_JSON_BYTES} bytes.` });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolved, "utf8")) as unknown;
  } catch (error) {
    issues.push({ code: "JSON_INVALID", message: `File '${fileName}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    issues.push({
      code: "SCHEMA_INVALID",
      message: `File '${fileName}' failed schema validation: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    });
    return undefined;
  }
  return parsed.data;
}

// True when `candidate` is equal to `root` or inside it. Both are expected to
// be realpath'd, absolute, and case-normalized to the OS default.
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
