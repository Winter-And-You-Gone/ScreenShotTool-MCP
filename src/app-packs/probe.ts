// app_pack_probe: generate an App Pack draft for an unknown running app.
//
// Probes a live process (by pid), enumerates its windows and operable UIA
// controls, and returns candidate rules for a controls.json / profile.json
// draft. The draft is returned as structuredContent (and optionally written
// to a temp directory). It is NEVER auto-installed as a formal pack - the
// user validates and loads it explicitly.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UiElementSelector, UiElementState } from "../uia/types.js";
import type { PackControls, PackProfile } from "./types.js";

export type ProbeDeps = {
  listWindows: (filters: { pid?: number }) => Promise<Array<{ hwnd: string; title: string; pid: number; processName: string; className: string }>>;
  catalogUi: (input: {
    hwnd?: string | number; pid?: number; includeProcessPopups?: boolean;
    visibleOnly?: boolean; enabledOnly?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number;
  }) => Promise<{
    controls: Array<{
      controlType: string; automationId: string; name: string; className: string; frameworkId: string;
      enabled: boolean; visible: boolean; rootHwnd: string;
      recommendedSelector: Record<string, unknown>; selectorConfidence: string; selectorVerified: boolean;
      selectorMatchCount: number; supportedActions: string[]; patterns: string[];
    }>;
    totalNodes: number; actionableNodes: number; truncated: boolean; elapsedMs: number;
  }>;
  inspectUiTree: (input: { pid?: number; includeProcessPopups?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number; controlTypes?: string[] }) => Promise<{
    roots: Array<{ hwnd: string; title: string; className: string; isMain: boolean }>;
    nodes: Array<{ automationId: string; controlType: string; name: string; offscreen: boolean }>;
  }>;
};

export type ProbeResult = {
  pid: number;
  hwnd?: string;
  title?: string;
  windowCandidates: Array<{ hwnd: string; title: string; className: string; isMain: boolean; rule: { title?: string; titleMatch?: string; className?: string } }>;
  controls: Array<{
    automationId: string; name: string; controlType: string; className: string; frameworkId: string;
    supportedActions: string[]; patterns: string[]; selector: Record<string, unknown>; stable: boolean;
  }>;
  patterns: Record<string, number>;
  menuCandidates: Array<{ automationId: string; name: string }>;
  inputCandidates: Array<{ automationId: string; name: string; controlType: string }>;
  dialogCandidates: Array<{ title: string; hwnd: string }>;
  unreachableControls: Array<{ automationId: string; name: string; controlType: string; reason: string }>;
  draft: { profile: PackProfile; controls: PackControls };
  tempDir?: string;
  warnings: string[];
};

const MAX_DRAFT_CONTROLS = 40;

export async function probeApp(deps: ProbeDeps, input: { pid: number; includeProcessPopups?: boolean; writeDraftToTemp?: boolean }): Promise<ProbeResult> {
  const { pid, includeProcessPopups = true, writeDraftToTemp = false } = input;
  const warnings: string[] = [];

  // 1. Enumerate the process windows -> main window candidates.
  const windows = await deps.listWindows({ pid }).catch(() => [] as Awaited<ReturnType<ProbeDeps["listWindows"]>>);
  if (windows.length === 0) {
    warnings.push("No visible top-level windows found for the pid; the probe can still enumerate by process name.");
  }
  let windowCandidates: ProbeResult["windowCandidates"] = [];
  let primaryHwnd: string | undefined;
  let primaryTitle: string | undefined;
  if (windows.length > 0) {
    primaryHwnd = windows[0]!.hwnd;
    primaryTitle = windows[0]!.title;
    windowCandidates = windows.map((w) => ({
      hwnd: w.hwnd,
      title: w.title,
      className: w.className,
      isMain: w.hwnd === primaryHwnd,
      rule: {
        ...(w.title ? { title: escapeRegex(w.title), titleMatch: "regex" as const } : {}),
        ...(w.className ? { className: w.className } : {})
      }
    }));
  }

  // 2. Catalog the actionable controls of the main window.
  let catalog: Awaited<ReturnType<ProbeDeps["catalogUi"]>> | null = null;
  try {
    catalog = await deps.catalogUi({
      ...(primaryHwnd ? { hwnd: primaryHwnd } : { pid }),
      includeProcessPopups,
      visibleOnly: true,
      enabledOnly: false,
      maxDepth: 15,
      maxNodes: 3000,
      timeoutMs: 30000
    });
  } catch (error) {
    warnings.push(`ui_catalog failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const controls: ProbeResult["controls"] = [];
  const patterns: Record<string, number> = {};
  const menuCandidates: Array<{ automationId: string; name: string }> = [];
  const inputCandidates: Array<{ automationId: string; name: string; controlType: string }> = [];
  const unreachableControls: ProbeResult["unreachableControls"] = [];
  const draftControls: PackControls["controls"] = {};

  if (catalog) {
    for (const c of catalog.controls.slice(0, 200)) {
      for (const p of c.patterns) patterns[p] = (patterns[p] ?? 0) + 1;
      const stable = c.selectorVerified && c.selectorMatchCount === 1 && c.selectorConfidence !== "fragile" && c.selectorConfidence !== "unsupported";
      const selector = c.recommendedSelector as UiElementSelector;
      controls.push({
        automationId: c.automationId,
        name: c.name,
        controlType: c.controlType,
        className: c.className,
        frameworkId: c.frameworkId,
        supportedActions: c.supportedActions,
        patterns: c.patterns,
        selector,
        stable
      });

      // Classify by control type for the report sections.
      if (/menu|Menu/i.test(c.controlType) || /menu/i.test(c.automationId) || /menu/i.test(c.name)) {
        menuCandidates.push({ automationId: c.automationId, name: c.name });
      }
      if (c.controlType === "Edit" || c.controlType === "ComboBox" || c.controlType === "Spinner" || c.controlType === "Slider") {
        inputCandidates.push({ automationId: c.automationId, name: c.name, controlType: c.controlType });
      }
      if (c.selectorConfidence === "unsupported" || !c.supportedActions.length) {
        unreachableControls.push({ automationId: c.automationId, name: c.name, controlType: c.controlType, reason: "no supported UIA action" });
      }

      // Draft: include stable controls with a usable automationId.
      if (stable && c.automationId && draftControls[c.automationId.split(".").pop()!] === undefined && Object.keys(draftControls).length < MAX_DRAFT_CONTROLS) {
        const shortName = c.automationId.split(".").pop()!;
        const entrySelector: UiElementSelector = {
          ...(selector.automationId ? { automationId: `${escapeRegex(shortName)}$`, match: "regex" as const } : selector),
          ...(selector.controlType ? { controlType: selector.controlType } : {})
        };
        draftControls[shortName] = {
          selectors: [entrySelector],
          confidence: "source-derived",
          description: `Probed ${c.controlType}${c.name ? ` '${c.name}'` : ""}.`
        };
      }
    }
    if (catalog.truncated) {
      warnings.push("The UIA catalog was truncated; the draft may miss controls.");
    }
  }

  // 3. Look for dialog-like top-level windows (same-PID popups).
  const dialogCandidates: Array<{ title: string; hwnd: string }> = [];
  try {
    const tree = await deps.inspectUiTree({ pid, includeProcessPopups, maxDepth: 2, maxNodes: 200, timeoutMs: 15000 });
    for (const root of tree.roots) {
      if (!root.isMain && root.title) {
        dialogCandidates.push({ title: root.title, hwnd: root.hwnd });
      }
    }
  } catch { /* best-effort */ }

  // 4. profile.json draft.
  const processName = windows[0]?.processName ?? "";
  const draftProfile: PackProfile = {
    id: "probe-draft",
    displayName: processName || `pid-${pid}`,
    executableNames: processName ? [processName.endsWith(".exe") ? processName : `${processName}.exe`] : [],
    ...(primaryTitle ? { mainWindow: { title: escapeRegex(primaryTitle), titleMatch: "regex" as const } } : {}),
    ...(Object.keys(draftControls).length > 0 ? {} : {}),
    launch: { reuseIfRunning: true, waitForWindow: true, timeoutMs: 30000 },
    security: { requiresAsInvoker: false }
  };
  const draft: ProbeResult["draft"] = {
    profile: draftProfile,
    controls: { controls: draftControls }
  };

  // 5. Optionally write the draft to a temp directory.
  let tempDir: string | undefined;
  if (writeDraftToTemp) {
    tempDir = await mkdtemp(path.join(tmpdir(), "app-pack-probe-"));
    await writeFile(path.join(tempDir, "profile.json"), JSON.stringify(draft.profile, null, 2), "utf8");
    await writeFile(path.join(tempDir, "controls.json"), JSON.stringify(draft.controls, null, 2), "utf8");
  }

  return {
    pid,
    hwnd: primaryHwnd,
    title: primaryTitle,
    windowCandidates,
    controls: controls.slice(0, 100),
    patterns,
    menuCandidates,
    inputCandidates,
    dialogCandidates,
    unreachableControls: unreachableControls.slice(0, 50),
    draft,
    ...(tempDir ? { tempDir } : {}),
    warnings
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
