// Semantic control resolution.
//
// Maps natural-language descriptions to logical controls using the pack's
// semantic map (pages.json / components.json / control aliases). PURE
// RESOLUTION: this module performs no UIA actions, moves nothing, and never
// triggers side effects. It answers "which logical controls does the model
// mean" so the caller can then drive profile_action. It is generic - it only
// reads whatever semantic map a pack declares; it knows no specific app.

import type { LoadedPack, PackControlEntry } from "./types.js";
import { registry as packRegistry } from "./registry.js";
import { McpUiError } from "../uia/results.js";

export type SemanticMatch = {
  control: string;
  group?: string;
  score: number;
  reason: string;
  // Derived action preference (方案 B, no pack declaration needed):
  // when the control belongs to a selection group AND declares a
  // selected/toggle controlState, the natural-language path should use
  // ensureSelected (idempotent, verifies before/after) instead of a raw
  // invoke. Raw invoke stays available for diagnostics.
  recommendedAction?: "ensureSelected";
};

export type ResolveSemanticInput = {
  profile: string;
  query: string;
  page?: string;
  within?: string;
  limit?: number;
};

export type SemanticScope = {
  within?: string;
  resolved: boolean;
};

export type RelationshipEvidence = {
  from: string;
  to: string;
  relation: string;
};

export type ResolveSemanticResult = {
  profile: string;
  query: string;
  matches: SemanticMatch[];
  suggestedPath: string[];
  pathAmbiguous: boolean;
  scope: SemanticScope;
  relationshipEvidence: RelationshipEvidence[];
};

// ── Semantic relation graph ──
//
// Single source of truth for the pack's declared relationships. Built from
// the SAME declarations the validator checks (pages.json / components.json /
// control metadata). Edges are directed parent -> child:
//
//   page.components          page -> component
//   page.rootControl         page -> control
//   page.navigationControl   page -> control
//   page.selectionGroups     page -> selection group (group.parent == page)
//   component.rootControl    component -> control
//   component.children       component -> control | component
//   control.parent           control -> control | component | selection group
//   control.group            control -> selection group
//   selectionGroup.members   selection group -> control
//   selectionGroup.parent    selection group -> component | control | page
//
// `control.page` / `component.page` are BELONGING-TO metadata (used for page
// filtering and describe), NOT containment edges - they never create path
// hops. Relationship identity NEVER comes from id prefixes or string
// startsWith - only from declared fields. Cycles are tolerated at query time
// (BFS with a visited set); the pack validator rejects same-kind cycles at
// load time.

export type SemanticGraph = {
  // node id -> set of child node ids (declared parent -> child edges).
  childrenByNode: Map<string, Set<string>>;
  // node id -> set of parent node ids (reverse edges).
  parentsByNode: Map<string, Set<string>>;
  nodeKinds: Map<string, "page" | "component" | "control" | "group">;
  relationshipEdges: RelationshipEvidence[];
};

export function buildSemanticGraph(pack: LoadedPack): SemanticGraph {
  const childrenByNode = new Map<string, Set<string>>();
  const parentsByNode = new Map<string, Set<string>>();
  const nodeKinds = new Map<string, "page" | "component" | "control" | "group">();
  const relationshipEdges: RelationshipEvidence[] = [];

  const addEdge = (from: string, to: string, relation: string): void => {
    if (!from || !to || from === to) return;
    let kids = childrenByNode.get(from);
    if (!kids) { kids = new Set(); childrenByNode.set(from, kids); }
    kids.add(to);
    let parents = parentsByNode.get(to);
    if (!parents) { parents = new Set(); parentsByNode.set(to, parents); }
    parents.add(from);
    relationshipEdges.push({ from, to, relation });
  };
  const kind = (id: string, k: "page" | "component" | "control" | "group"): void => {
    if (!nodeKinds.has(id)) nodeKinds.set(id, k);
  };

  for (const page of pack.pages?.pages ?? []) {
    kind(page.id, "page");
    for (const compId of page.components ?? []) addEdge(page.id, compId, "page.components");
    for (const groupId of pack.pages?.selectionGroups ?? []) {
      if (groupId.members.length > 0 && (page.id === groupId.parent)) addEdge(page.id, groupId.id, "page.selectionGroups");
    }
    if (page.rootControl) addEdge(page.id, page.rootControl, "page.rootControl");
    if (page.navigationControl) addEdge(page.id, page.navigationControl, "page.navigationControl");
  }

  for (const group of pack.pages?.selectionGroups ?? []) {
    kind(group.id, "group");
    for (const member of group.members) addEdge(group.id, member, "selectionGroup.members");
    if (group.parent) addEdge(group.parent, group.id, "selectionGroup.parent");
  }

  for (const component of pack.components?.components ?? []) {
    kind(component.id, "component");
    if (component.rootControl) addEdge(component.id, component.rootControl, "component.rootControl");
    for (const child of component.children ?? []) addEdge(component.id, child, "component.children");
  }

  for (const [id, raw] of Object.entries(pack.controls.controls)) {
    kind(id, "control");
    const entry = raw as Partial<PackControlEntry>;
    if (!entry || typeof entry !== "object" || Array.isArray(raw) || !("selectors" in raw)) continue;
    if (entry.parent) addEdge(entry.parent, id, "control.parent");
    if (entry.group) addEdge(entry.group, id, "control.group");
  }

  return { childrenByNode, parentsByNode, nodeKinds, relationshipEdges };
}

// True when `candidate` is `ancestorId` itself or reachable from it via
// declared edges (BFS, visited set -> safe on cyclic data). False when the
// ancestor is unknown or there is no declared path.
export function isSemanticDescendant(
  graph: SemanticGraph,
  candidateId: string,
  ancestorId: string
): boolean {
  if (candidateId === ancestorId) return true;
  const frontier = graph.childrenByNode.get(ancestorId);
  if (!frontier || frontier.size === 0) return false;
  const visited = new Set<string>([ancestorId]);
  const queue = [...frontier];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === candidateId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    const kids = graph.childrenByNode.get(node);
    if (kids) queue.push(...kids);
  }
  return false;
}

// Shortest declared path from `fromId` to `toId` (BFS), or undefined when no
// path exists. Stable: queue order is insertion-ordered, ties resolve to the
// first-found (declaration order) path.
export function findSemanticPath(
  graph: SemanticGraph,
  fromId: string,
  toId: string
): string[] | undefined {
  if (fromId === toId) return [fromId];
  const start = graph.childrenByNode.get(fromId);
  if (!start || start.size === 0) return undefined;
  const visited = new Set<string>([fromId]);
  const queue: Array<{ node: string; path: string[] }> = [...start].map((n) => ({ node: n, path: [fromId, n] }));
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (node === toId) return path;
    if (visited.has(node)) continue;
    visited.add(node);
    const kids = graph.childrenByNode.get(node);
    if (kids) {
      for (const k of kids) {
        if (!visited.has(k)) queue.push({ node: k, path: [...path, k] });
      }
    }
  }
  return undefined;
}

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
function controlIndex(pack: LoadedPack): Map<string, { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string; controlState?: unknown; postconditions?: unknown[] }> {
  const index = new Map<string, { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string; controlState?: unknown; postconditions?: unknown[] }>();
  for (const [id, raw] of Object.entries(pack.controls.controls)) {
    if (Array.isArray(raw) || !(typeof raw === "object") || !("selectors" in raw)) {
      index.set(id, {});
      continue;
    }
    const entry = raw as { aliases?: string[]; page?: string; group?: string; role?: string; controlState?: unknown; postconditions?: unknown[] };
    index.set(id, {
      aliases: entry.aliases,
      page: entry.page,
      group: entry.group,
      role: entry.role,
      controlState: entry.controlState,
      postconditions: entry.postconditions
    });
  }
  return index;
}

// 方案 B derivation: a selection-group member whose declaration describes
// selected/toggle state is a "make this option the selected one" control -
// the natural-language path should use ensureSelected (idempotent + verified)
// instead of a raw invoke. No pack declaration needed beyond what the control
// already carries.
function deriveRecommendedAction(meta: {
  group?: string;
  controlState?: unknown;
  supportedActions?: string[];
}): "ensureSelected" | undefined {
  if (!meta.group) return undefined;
  const hasSelectionState = meta.controlState !== undefined
    && typeof meta.controlState === "object"
    && meta.controlState !== null
    && (("any" in (meta.controlState as Record<string, unknown>)) || ("all" in (meta.controlState as Record<string, unknown>)));
  const supportsEnsure = Array.isArray(meta.supportedActions) && meta.supportedActions.includes("ensureSelected");
  if (hasSelectionState || supportsEnsure) return "ensureSelected";
  return undefined;
}

// Display name of a control (alias[0] or the control id) for path building.
function controlLabel(pack: LoadedPack, controlId: string): string {
  const idx = controlIndex(pack);
  const meta = idx.get(controlId);
  return meta?.aliases?.[0] ?? controlId;
}

// Resolve which nodes are scoped under `within`. The scope node may be a
// page, component, control or selection-group id. Only declared edges count;
// an unknown scope is an error (SEMANTIC_SCOPE_NOT_FOUND), never a silent
// global search.
function resolveScopeNode(
  graph: SemanticGraph,
  pack: LoadedPack,
  within: string
): string | undefined {
  const known = new Set<string>([
    ...(pack.pages?.pages ?? []).map((p) => p.id),
    ...(pack.components?.components ?? []).map((c) => c.id),
    ...(pack.pages?.selectionGroups ?? []).map((g) => g.id),
    ...Object.keys(pack.controls.controls)
  ]);
  return known.has(within) ? within : undefined;
}

export function resolveSemanticControl(input: ResolveSemanticInput): ResolveSemanticResult {
  const pack = packRegistry.getPack(input.profile);
  if (!pack) {
    throw new McpUiError("PACK_NOT_FOUND", `No App Pack with id '${input.profile}' is loaded.`, { profile: input.profile });
  }
  const graph = buildSemanticGraph(pack);

  let scope: SemanticScope = { resolved: false };
  if (input.within) {
    const scopeNode = resolveScopeNode(graph, pack, input.within);
    if (!scopeNode) {
      throw new McpUiError(
        "SEMANTIC_SCOPE_NOT_FOUND",
        `Scope '${input.within}' is not a page, component, control or selection group in pack '${input.profile}'.`,
        { profile: input.profile, within: input.within }
      );
    }
    scope = { within: scopeNode, resolved: true };
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
    // Scope: within filter - real semantic descendants (or the scope node
    // itself when it is a control). No id-prefix heuristics.
    if (input.within) {
      const withinId = scope.within!;
      const isSelf = controlId === withinId;
      const kind = graph.nodeKinds.get(withinId);
      const withinIsControl = kind === "control";
      const descendant = isSemanticDescendant(graph, controlId, withinId);
      if (!isSelf && !descendant) continue;
      // When the scope is a control, only the control itself may match at
      // the top level (its descendants are not user-operable scope roots).
      if (withinIsControl && !isSelf) continue;
    }
    const { score, reason } = scoreControl(controlId, meta, tokens);
    if (score <= 0) continue;
    const recommended = deriveRecommendedAction(meta);
    matches.push({
      control: controlId,
      ...(meta.group ? { group: meta.group } : {}),
      score,
      reason,
      ...(recommended ? { recommendedAction: recommended } : {})
    });
  }

  // Order matches: score first, then the query-token order of the groups the
  // matches belong to (so "通道1 传感器配置" keeps channel-1 before
  // sensor-config even at equal scores), then stable declaration order.
  const groupOrder = new Map<string, number>();
  tokens.forEach((token, ti) => {
    for (const m of matches) {
      if (m.group && !groupOrder.has(m.group)) {
        const meta = index.get(m.control) ?? {};
        if (scoreControl(m.control, meta, [token]).score > 0) {
          groupOrder.set(m.group, ti);
        }
      }
    }
  });
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ga = a.group ? groupOrder.get(a.group) : undefined;
    const gb = b.group ? groupOrder.get(b.group) : undefined;
    if (ga !== undefined && gb !== undefined && ga !== gb) return ga - gb;
    return a.control.localeCompare(b.control);
  });
  const top = matches.slice(0, input.limit ?? 10);

  // Suggested path: shortest declared path from the page navigation control
  // to the best match, through the relation graph. Never picks unrelated
  // components; navigationControl is prepended when declared.
  const { path, ambiguous } = buildSuggestedPath(graph, pack, top, index, groupOrder);
  const evidence = graph.relationshipEdges.filter((e) =>
    top.some((m) => m.control === e.to || m.control === e.from)
  ).slice(0, 20);

  return {
    profile: pack.manifest.id,
    query: input.query,
    matches: top,
    suggestedPath: path,
    pathAmbiguous: ambiguous,
    scope,
    relationshipEvidence: evidence
  };
}

// Build the suggested action path for the top match(es). Returns a stable,
// shortest declared path (page navigation -> ... -> target). The raw graph
// path is projected onto actionable controls: page/component/group nodes are
// replaced by their actionable representatives (navigationControl /
// rootControl / the member control itself is kept). Never picks unrelated
// components. When multiple matches exist and their relative action order
// cannot be derived from the graph, marks the path ambiguous instead of
// inventing one.
function buildSuggestedPath(
  graph: SemanticGraph,
  pack: LoadedPack,
  top: SemanticMatch[],
  index: Map<string, { displayName?: string; aliases?: string[]; page?: string; group?: string; role?: string; controlState?: unknown; postconditions?: unknown[] }>,
  groupOrder: Map<string, number>
): { path: string[]; ambiguous: boolean } {
  if (top.length === 0) return { path: [], ambiguous: false };
  const best = top[0]!;
  const pageId = index.get(best.control)?.page;
  const page = pack.pages?.pages.find((p) => p.id === pageId);
  if (!page) return { path: [best.control], ambiguous: false };

  // Shortest declared path from the page node to the target control.
  const raw = findSemanticPath(graph, page.id, best.control);
  if (!raw || raw.length === 0) return { path: [best.control], ambiguous: false };

  // Project non-actionable nodes: page -> navigationControl; component ->
  // rootControl (skipped when already present); selection-group -> its
  // member control is already the target; group/parent nodes are dropped.
  const actionable: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (id: string) => {
    if (!seen.has(id)) { seen.add(id); actionable.push(id); }
  };
  for (const node of raw) {
    const kind = graph.nodeKinds.get(node);
    if (kind === "page") {
      if (page.navigationControl) pushUnique(page.navigationControl);
      if (page.rootControl) pushUnique(page.rootControl);
      continue;
    }
    if (kind === "component") {
      const comp = pack.components?.components.find((c) => c.id === node);
      if (comp?.rootControl) pushUnique(comp.rootControl);
      continue;
    }
    if (kind === "group") {
      // Groups are not actionable; the member control is the target itself.
      continue;
    }
    pushUnique(node);
  }
  // Always end at the target control.
  if (actionable[actionable.length - 1] !== best.control) pushUnique(best.control);

  // Multi-match: when the top matches live in different selection groups and
  // the query token order maps each group to a distinct position, the action
  // sequence IS derivable - extend the path with the remaining matches in
  // group order. Otherwise mark ambiguous instead of inventing a sequence.
  let ambiguous = false;
  if (top.length > 1) {
    const groups = [...new Set(top.map((m) => m.group).filter((g): g is string => !!g))];
    if (groups.length > 1) {
      const ordered = [...groups].sort((a, b) => {
        const ga = groupOrder.get(a);
        const gb = groupOrder.get(b);
        if (ga !== undefined && gb !== undefined && ga !== gb) return ga - gb;
        return a.localeCompare(b);
      });
      // Only when EVERY group has a distinct token position is the order
      // unambiguous.
      const positions = ordered.map((g) => groupOrder.get(g));
      if (positions.every((p): p is number => p !== undefined) && new Set(positions).size === positions.length) {
        for (const g of ordered) {
          const member = top.find((m) => m.group === g);
          if (member && member.control !== best.control && !seen.has(member.control)) {
            actionable.push(member.control);
            seen.add(member.control);
          }
        }
      } else {
        ambiguous = true;
      }
    }
  }

  return { path: actionable, ambiguous };
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
