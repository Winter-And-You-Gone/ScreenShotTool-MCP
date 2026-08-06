// App Pack registry.
//
// Holds the currently loaded packs, supports atomic reload (a failing reload
// keeps the previous config), adapts packs to the legacy AppProfile shape for
// the profile layer, and provides lookup helpers used by the profile tools
// and ui_catalog enrichment.

import type { AppProfile, ControlEntry, SelectorConfidence } from "../profiles/types.js";
import type { UiElementSelector } from "../uia/types.js";
import { loadAllPacks, type LoadIssue } from "./loader.js";
import { validatePack, type ValidationIssue } from "./validator.js";
import type { CatalogVisibility, LoadedPack, PackManifest, PackProfile } from "./types.js";

export type ReloadResult = {
  reloaded: boolean;
  loadedPacks: LoadedPack[];
  issues: LoadIssue[];
  validationIssues: Record<string, ValidationIssue[]>;
};

export class AppPackRegistry {
  private packs: LoadedPack[] = [];
  private validationCache = new Map<string, ValidationIssue[]>();
  // Source priority order retained for stable listing.
  private order: string[] = [];

  async load(cliDir?: string, envDirs?: string[], includeDefaults = true): Promise<ReloadResult> {
    const result = await loadAllPacks(cliDir, envDirs, includeDefaults);
    // ATOMIC RELOAD: schema validation (loader) AND semantic validation
    // (validatePack) must BOTH pass before the new config replaces the active
    // registry. A candidate pack with ANY semantic error is excluded from the
    // active registry (warnings are allowed). On any error the previous
    // registry AND its validation cache are kept verbatim - a reload can
    // never mix a new candidate into the old active set, and the validation
    // cache always matches the ACTIVE registry.
    const candidateValidation = new Map<string, ValidationIssue[]>();
    const candidateIssues: LoadIssue[] = [...result.issues];
    const candidatePacks: LoadedPack[] = [];
    const seenIds = new Set<string>();
    for (const pack of result.packs) {
      if (seenIds.has(pack.manifest.id)) continue; // duplicate ids already an issue
      seenIds.add(pack.manifest.id);
      const v = validatePack(pack);
      candidateValidation.set(pack.manifest.id, v.errors);
      if (v.errors.length > 0) {
        candidateIssues.push({
          source: pack.source,
          pack: pack.manifest.id,
          code: "PACK_INVALID",
          message: `Pack '${pack.manifest.id}' failed semantic validation (${v.errors.length} error(s)); it was not loaded.`
        });
        continue;
      }
      candidatePacks.push(pack);
    }

    if (candidateIssues.length > 0) {
      // Keep the OLD registry and the OLD validation cache - never a mix of
      // the new candidate's validation results with the old active set.
      return {
        reloaded: false,
        loadedPacks: this.packs,
        issues: candidateIssues,
        validationIssues: Object.fromEntries(this.validationCache)
      };
    }
    // Clean swap: registry AND validation cache are replaced together.
    this.packs = candidatePacks;
    this.order = candidatePacks.map((p) => p.manifest.id);
    this.validationCache = candidateValidation;
    return {
      reloaded: true,
      loadedPacks: candidatePacks,
      issues: [],
      validationIssues: Object.fromEntries(candidateValidation)
    };
  }

  getPack(id: string): LoadedPack | undefined {
    return this.packs.find((p) => p.manifest.id === id);
  }

  listPacks(visibility: "all" | "session" = "session"): LoadedPack[] {
    if (visibility === "all") return this.packs;
    return this.packs.filter((p) => p.manifest.catalogVisibility === "session" || p.manifest.catalogVisibility === undefined);
  }

  // Find the pack whose process name or window title matches the target.
  findPackForTarget(target: { processName?: string; titleContains?: string }): LoadedPack | undefined {
    for (const pack of this.packs) {
      const profile = pack.profile;
      const names = [...(profile.processNames ?? []), ...(profile.executableNames ?? [])];
      if (target.processName) {
        const tn = target.processName.toLowerCase().replace(/\.exe$/, "");
        if (names.some((n) => n.toLowerCase().replace(/\.exe$/, "") === tn)) return pack;
      }
      if (target.titleContains) {
        const tc = target.titleContains.toLowerCase();
        if ((profile.titleContains ?? []).some((t) => tc.includes(t.toLowerCase()))) return pack;
        if (profile.mainWindow?.title) {
          const t = profile.mainWindow.title.toLowerCase();
          if (profile.mainWindow.titleMatch === "regex") {
            try {
              // Case-insensitive via the flag ONLY - never by lowercasing the
              // pattern source (a lowercased character class like [A-Z] or a
              // case-sensitive escape would silently change semantics).
              if (new RegExp(t, "i").test(target.titleContains)) return pack;
            } catch { /* ignore */ }
          } else if (t.includes(tc) || tc.includes(t)) {
            return pack;
          }
        }
      }
    }
    return undefined;
  }

  validationErrorsFor(packId: string): ValidationIssue[] {
    return this.validationCache.get(packId) ?? [];
  }

  snapshot(packId: string): { manifestVersion: number; packVersion: string; packId: string } | undefined {
    const pack = this.getPack(packId);
    if (!pack) return undefined;
    return { manifestVersion: pack.manifest.schemaVersion, packVersion: pack.manifest.version, packId };
  }
}

export const registry = new AppPackRegistry();

// ── Legacy AppProfile adapter ──
//
// The profile layer (src/profiles/registry.ts) keeps working against App
// Profiles; packs are adapted to that shape here so there is exactly ONE
// source of profile data (the App Pack registry).

const CONFIDENCE_MAP: Record<string, SelectorConfidence> = {
  "runtime-verified": "runtime-verified",
  "source-derived": "source-derived",
  "action-limited": "action-limited",
  unsupported: "unsupported",
  ambiguous: "ambiguous",
  stable: "runtime-verified",
  "conditionally-stable": "runtime-verified",
  fragile: "source-derived"
};

export function packToAppProfile(pack: LoadedPack): AppProfile {
  const profile: PackProfile = pack.profile;
  const controls: Record<string, ControlEntry | UiElementSelector | UiElementSelector[]> = {};
  for (const [name, raw] of Object.entries(pack.controls.controls)) {
    if (Array.isArray(raw)) {
      controls[name] = raw;
    } else if ("selectors" in raw && Array.isArray((raw as { selectors?: unknown[] }).selectors)) {
      const entry = raw as { selectors: UiElementSelector[]; confidence?: string; notes?: string; description?: string; menu?: unknown; selectionGroup?: string };
      controls[name] = {
        selectors: entry.selectors,
        confidence: CONFIDENCE_MAP[entry.confidence ?? "source-derived"] ?? "source-derived",
        notes: entry.notes ?? entry.description,
        menu: entry.menu as ControlEntry["menu"],
        selectionGroup: entry.selectionGroup
      };
    } else {
      controls[name] = raw as UiElementSelector;
    }
  }

  const mainTitle = profile.mainWindow?.title;
  return {
    id: pack.manifest.id,
    displayName: profile.displayName ?? pack.manifest.displayName,
    processNames: profile.processNames ?? profile.executableNames ?? [],
    titleContains: profile.titleContains ?? (mainTitle && profile.mainWindow?.titleMatch !== "regex" ? [mainTitle] : undefined),
    executableNames: profile.executableNames,
    executableEnv: profile.executableEnv,
    requiresAsInvoker: profile.security?.requiresAsInvoker ?? false,
    launch: profile.launch,
    interaction: profile.interaction,
    submenuAidPatterns: profile.submenuAidPatterns,
    controls
  };
}

export function getAppProfile(packId: string): AppProfile | undefined {
  const pack = registry.getPack(packId);
  return pack ? packToAppProfile(pack) : undefined;
}

export function listAppProfiles(): AppProfile[] {
  return registry.listPacks("all").map(packToAppProfile);
}

export function getPackManifest(packId: string): PackManifest | undefined {
  return registry.getPack(packId)?.manifest;
}

export function isVisibleToSession(pack: LoadedPack): boolean {
  return (pack.manifest.catalogVisibility ?? "session") === "session";
}

export function effectiveVisibility(pack: LoadedPack): CatalogVisibility {
  return pack.manifest.catalogVisibility ?? "session";
}
