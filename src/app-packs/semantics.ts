// Semantic control resolution.
//
// Maps natural-language descriptions to logical controls using the pack's
// semantic map (pages.json / components.json / control aliases). PURE
// RESOLUTION: this module performs no UIA actions, moves nothing, and never
// triggers side effects. It answers "which logical controls does the model
// mean" so the caller can then drive profile_action. It is generic - it only
// reads whatever semantic map a pack declares; it knows no specific app.

import type { LoadedPack } from "./types.js";
import { registry as packRegistry } from "./registry.js";

export type SemanticMatch = {
  control: string;
  group?: string;
  score: number;
  reason: string;
};

export type ResolveSemanticInput = {
  profile: string;
  query: string;
  page?: string;
  within?: string;
  limit?: number;
};

export type ResolveSemanticResult = {
  profile: string;
  query: string;
  matches: SemanticMatch[];
  suggestedPath: string[];
};

// Score a single query token against a control's semantic labels.
function scoreControl(
  controlId: string,
  control: { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string },
  tokens: string[]
): { score: number; reason: string } {
  const labels: string[] = [];
  const aliasReasons: string[] = [];
  if (control.displayName) { labels.push(control.displayName); aliasReasons.push("displayName"); }
  for (const alias of control.aliases ?? []) { labels.push(alias); aliasReasons.push("alias"); }
  // The control id itself is a weak label (ids are camelCase technical names).
  labels.push(controlId);
  aliasReasons.push("id");

  let total = 0;
  const reasons = new Set<string>();
  for (const token of tokens) {
    let best = 0;
    let bestReason = "";
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      const score = labelScore(label, token);
      if (score > best) { best = score; bestReason = aliasReasons[i]!; }
    }
    if (best > 0) {
      total += best;
      if (bestReason !== "id") reasons.add(bestReason);
    }
  }
  return { score: total, reason: [...reasons].join(" and ") || "id match" };
}

// Exact/normalized/contains matching with Chinese + English normalization
// (case-fold, strip spaces).
function labelScore(label: string, token: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "").replace(/[（(]/g, "(").replace(/[）)]/g, ")");
  const l = norm(label);
  const t = norm(token);
  if (l === t) return 1.0; // exact
  if (l.includes(t)) return 0.8; // label contains token
  if (t.includes(l)) return 0.6; // token contains label
  return 0;
}

// Group membership: which selection group (pages.json selectionGroups)
// contains this control?
function groupOf(pack: LoadedPack, controlId: string): string | undefined {
  for (const group of pack.pages?.selectionGroups ?? []) {
    if (group.members.includes(controlId)) return group.id;
  }
  return undefined;
}

// All controls of a pack with their semantic metadata (generic shape).
function controlIndex(pack: LoadedPack): Map<string, { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string }> {
  const index = new Map<string, { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string }>();
  for (const [id, raw] of Object.entries(pack.controls.controls)) {
    if (Array.isArray(raw) || !(typeof raw === "object") || !("selectors" in raw)) {
      index.set(id, {});
      continue;
    }
    const entry = raw as { aliases?: string[]; page?: string; group?: string; role?: string };
    index.set(id, {
      aliases: entry.aliases,
      page: entry.page,
      group: entry.group,
      role: entry.role
    });
  }
  return index;
}

// Display name of a control (alias[0] or the control id) for path building.
function controlLabel(pack: LoadedPack, controlId: string): string {
  const idx = controlIndex(pack);
  const meta = idx.get(controlId);
  return meta?.aliases?.[0] ?? controlId;
}

export function resolveSemanticControl(input: ResolveSemanticInput): ResolveSemanticResult {
  const pack = packRegistry.getPack(input.profile);
  if (!pack) {
    throw new Error(`PACK_NOT_FOUND: no App Pack with id '${input.profile}' is loaded.`);
  }
  const tokens = input.query
    .split(/[\s,，、/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const index = controlIndex(pack);
  const matches: SemanticMatch[] = [];

  for (const [controlId, meta] of index) {
    // Scope: page filter.
    if (input.page && meta.page && meta.page !== input.page) continue;
    // Scope: within filter (component root or parent control).
    if (input.within) {
      const comp = pack.components?.components.find((c) => c.id === input.within);
      const inComponent = comp ? (comp.children ?? []).includes(controlId) : false;
      const inControl = meta.page !== undefined && controlId !== input.within && (controlId as string).startsWith(input.within);
      if (!inComponent && !inControl) continue;
    }
    const { score, reason } = scoreControl(controlId, meta, tokens);
    if (score <= 0) continue;
    matches.push({
      control: controlId,
      ...(meta.group ? { group: meta.group } : {}),
      score,
      reason
    });
  }

  matches.sort((a, b) => b.score - a.score || a.control.localeCompare(b.control));
  const top = matches.slice(0, input.limit ?? 10);

  // Suggested path: navigate the semantic graph from the page navigation
  // control through the matched control's ancestors (page root -> component
  // root -> control). Generic - derived from pages.json relationships only.
  let suggestedPath: string[] = [];
  if (top.length > 0) {
    const best = top[0]!;
    const pageId = index.get(best.control)?.page;
    const page = pack.pages?.pages.find((p) => p.id === pageId);
    const path: string[] = [];
    if (page?.navigationControl) path.push(page.navigationControl);
    if (page?.rootControl) path.push(page.rootControl);
    // Walk the page's components; include ONLY the component whose subtree
    // contains the matched control (stop as soon as it is found).
    for (const compId of page?.components ?? []) {
      const comp = pack.components?.components.find((c) => c.id === compId);
      if (!comp) continue;
      const reachable = (comp.children ?? []).includes(best.control) ||
        (comp.children ?? []).some((child) => index.has(child) || child === best.control);
      if (!reachable) continue;
      if (comp.rootControl) path.push(comp.rootControl);
      break;
    }
    path.push(best.control);
    suggestedPath = [...new Set(path)];
  }

  return {
    profile: pack.manifest.id,
    query: input.query,
    matches: top,
    suggestedPath
  };
}

// Compact semantic-map projections used by app_pack_describe (generic).
export function describeSemanticMap(
  pack: LoadedPack,
  include: string[],
  pageId?: string,
  compact?: boolean
): {
  pages: unknown[];
  selectionGroups: unknown[];
  components: unknown[];
  relationships: unknown[];
} {
  const pages = (pack.pages?.pages ?? [])
    .filter((p) => !pageId || p.id === pageId)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      ...(p.aliases && p.aliases.length > 0 ? { aliases: p.aliases } : {}),
      navigationControl: p.navigationControl,
      rootControl: p.rootControl,
      scrollContainers: p.scrollContainers ?? [],
      components: p.components ?? [],
      ...(p.readyMarkers && p.readyMarkers.length > 0 ? { readyMarkers: p.readyMarkers.map((m) => ({ control: m.profileControl, condition: m.condition })) } : {})
    }));

  const groups = (pack.pages?.selectionGroups ?? []).map((g) => ({
    id: g.id,
    ...(g.role ? { role: g.role } : {}),
    ...(g.parent ? { parent: g.parent } : {}),
    members: g.members,
    selectionMode: g.selectionMode ?? "single"
  }));

  const components = (pack.components?.components ?? [])
    .filter((c) => !pageId || c.page === pageId)
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      ...(c.aliases && c.aliases.length > 0 ? { aliases: c.aliases } : {}),
      page: c.page,
      role: c.role,
      rootControl: c.rootControl,
      children: c.children ?? [],
      mappingStatus: c.mappingStatus ?? "full",
      ...(c.reason ? { reason: c.reason } : {})
    }));

  // Relationships: control -> page/parent/group/role/scrollContainer +
  // postcondition controls (compact form for model consumption).
  const relationships: unknown[] = [];
  if (include.includes("relationships") || include.includes("controls")) {
    for (const [controlId, raw] of Object.entries(pack.controls.controls)) {
      if (Array.isArray(raw) || !(typeof raw === "object") || !("selectors" in raw)) continue;
      const entry = raw as {
        aliases?: string[]; page?: string; parent?: string; group?: string; role?: string;
        visibility?: { scrollContainer?: string }; postconditions?: Array<{ profileControl: string; condition: string }>;
        search?: { rootControl?: string; maxDepth?: number; depthStrategy?: string };
        controlState?: { any?: unknown[]; all?: unknown[] };
        fallbackPolicy?: { enabled?: boolean; methods?: string[]; forbidden?: string[] };
        supportedActions?: string[];
      };
      if (compact) {
        relationships.push({
          control: controlId,
          ...(entry.aliases && entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
          ...(entry.page ? { page: entry.page } : {}),
          ...(entry.parent ? { parent: entry.parent } : {}),
          ...(entry.group ? { group: entry.group } : {}),
          ...(entry.role ? { role: entry.role } : {}),
          ...(entry.visibility?.scrollContainer ? { scrollContainer: entry.visibility.scrollContainer } : {}),
          ...(entry.postconditions && entry.postconditions.length > 0 ? { postconditions: entry.postconditions.map((p) => ({ control: p.profileControl, condition: p.condition })) } : {}),
          ...(entry.supportedActions && entry.supportedActions.length > 0 ? { supportedActions: entry.supportedActions } : {}),
          ...(entry.search ? { search: entry.search } : {}),
          ...(entry.fallbackPolicy ? { fallbackPolicy: entry.fallbackPolicy } : {})
        });
      } else {
        relationships.push({
          control: controlId,
          ...(entry.page ? { page: entry.page } : {}),
          ...(entry.parent ? { parent: entry.parent } : {}),
          ...(entry.group ? { group: entry.group } : {}),
          ...(entry.role ? { role: entry.role } : {}),
          ...(entry.visibility ? { visibility: entry.visibility } : {}),
          ...(entry.postconditions ? { postconditions: entry.postconditions } : {}),
          ...(entry.controlState ? { controlState: entry.controlState } : {}),
          ...(entry.supportedActions ? { supportedActions: entry.supportedActions } : {}),
          ...(entry.search ? { search: entry.search } : {}),
          ...(entry.fallbackPolicy ? { fallbackPolicy: entry.fallbackPolicy } : {})
        });
      }
    }
  }

  return { pages, selectionGroups: groups, components, relationships };
}

export { controlLabel, controlIndex };
