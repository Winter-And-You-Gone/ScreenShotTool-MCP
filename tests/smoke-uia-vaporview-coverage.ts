// VaporView UIA coverage report.
//
// Distinguishes three NON-equivalent coverage notions (per spec):
//   pattern-exposed         - the control exposes a UIA pattern (ExpandCollapse,
//                             Invoke, Value, Toggle, ...). This is NOT "operated".
//   action-smoke-verified   - the control was actually operated end-to-end with
//                             a verified state change in smoke:uia-vaporview.
//   profile-runtime-verified- a profile selector resolved the control uniquely
//                             against the live tree (confidence runtime-verified).
// These are reported separately and NEVER collapsed into a single "100%
// operated" figure. Also reports Pattern coverage %, action-smoke sample %,
// and profile runtime verification %.
//
// No physical mouse movement; restores the page to home. Menu controls are
// verified by opening the menu (Help section) without invoking destructive
// commands.
//
// Env: VAPORVIEW_EXE (required), VAPORVIEW_SMOKE_STRICT (optional).

import { access, constants as fsConstants } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { catalogUi, closeApp, getUiElement, performUiAction, queryUi, inspectUiTree, listWindows, sendKey } from "../src/windows.js";
import { launchProfile, resolveProfileControl, performProfileAction, buildUiaDeps } from "../src/profiles/registry.js";
import { vaporViewProfile } from "../src/profiles/vaporview.js";
import { normalizeControlEntry } from "../src/profiles/types.js";

const exePath = process.env.VAPORVIEW_EXE;
const strict = process.env.VAPORVIEW_SMOKE_STRICT === "1";
if (!exePath) {
  if (strict) { console.error("FAIL (strict): VAPORVIEW_EXE is not set."); process.exit(1); }
  console.log("SKIPPED: VAPORVIEW_EXE is not set.");
  process.exit(77);
}
try { await access(exePath, fsConstants.X_OK); } catch { console.error(`FAIL: EXE not found: ${exePath}`); process.exit(1); }

const deps = buildUiaDeps({ getUiElement, performUiAction, queryUi, inspectUiTree, sendKey });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIDEBAR = "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.appSidebar.appSidebarButton";

console.log(`Launching VaporView: ${exePath}`);
const launched = await launchProfile(deps, async (i) => {
  const { launchApp } = await import("../src/windows.js");
  return launchApp({ exePath: i.exePath, args: i.args ?? [], waitForWindow: i.waitForWindow ?? true, noActivate: i.noActivate ?? true, startMinimized: i.startMinimized ?? false, timeoutMs: i.timeoutMs ?? 30000 });
}, (f) => listWindows(f), { profile: "vaporview", exePath, noActivate: true, timeoutMs: 30000, reuseIfRunning: false });
const pid = launched.pid;
const hwnd = launched.hwnd;

// Controls actually operated end-to-end (verified state change) by the strict
// smoke (smoke:uia-vaporview). This is the action-smoke-verified set - it is a
// SAMPLE, not the full control set, and is reported as such.
const ACTION_SMOKE_VERIFIED = new Set([
  "titleBarMenuButton", "titleMenuHelpSection", "titleMenuAbout", "aboutDialogOkButton",
  "logSidePanelToggleButton", "logSearchButton", "logFilterButton",
  "ai8TemperatureRateCombo",
  "sidebarHome", "sidebarTemperature", "sidebarDeviceConfig"
]);

// Category aggregation: pattern-exposed vs unsupported.
type CatEntry = { total: number; patternExposed: number; unsupported: number; methods: Record<string, number> };
const byCat: Record<string, CatEntry> = {};
const bump = (cat: string, patternExposed: boolean, method: string) => {
  byCat[cat] ??= { total: 0, patternExposed: 0, unsupported: 0, methods: {} };
  byCat[cat].total++;
  if (patternExposed) byCat[cat].patternExposed++; else byCat[cat].unsupported++;
  byCat[cat].methods[method] = (byCat[cat].methods[method] ?? 0) + 1;
};

// profile-runtime-verified: profile controls whose selectors resolve uniquely.
let profileRuntimeVerified = 0;
let profileSourceDerived = 0;
let profileUnresolved = 0;
const unresolved: string[] = [];

async function resolveProfileControlSafe(control: string, entry: { selectors: unknown[]; confidence?: string }, openMenu = false) {
  try {
    if (openMenu) {
      await performProfileAction(deps, { profile: "vaporview", control: "titleBarMenuButton", action: "openMenu", pid, hwnd, timeoutMs: 15000 }).catch(() => undefined);
      await sleep(400);
    }
    const r = await resolveProfileControl(deps, { profile: "vaporview", control, pid, hwnd, includeProcessPopups: true, timeoutMs: 8000 });
    if (r.found) {
      if (entry.confidence === "runtime-verified") profileRuntimeVerified++;
      else profileSourceDerived++;
    } else { profileUnresolved++; unresolved.push(control); }
  } catch {
    profileUnresolved++; unresolved.push(control);
  }
}

let exitCode = 0;
try {
  // ── Pattern-exposed coverage across sidebar pages ──
  const pages = [
    { name: "home", sel: { automationId: SIDEBAR, name: "首页" } },
    { name: "device", sel: { automationId: SIDEBAR, name: "设备配置" } },
    { name: "temperature", sel: { automationId: SIDEBAR, name: "温控" } },
    { name: "rtk", sel: { automationId: SIDEBAR, name: "RTK配置" } },
  ];
  const seenAids = new Set<string>();
  for (const p of pages) {
    try {
      await performUiAction({ hwnd: hwnd!, selector: p.sel, action: "invoke", timeoutMs: 10000 });
      await sleep(900);
    } catch { /* page may not exist */ }
    const cat = await catalogUi({ pid, hwnd, includeProcessPopups: false, visibleOnly: false, maxDepth: 25, maxNodes: 5000, timeoutMs: 30000 });
    console.log(`page=${p.name} actionable=${cat.actionableNodes} truncated=${cat.truncated}`);
    for (const c of cat.controls) {
      if (c.automationId) {
        const key = c.automationId + "|" + c.controlType;
        if (seenAids.has(key)) continue;
        seenAids.add(key);
      }
      const ct = c.controlType.replace(/^ControlType\./, "");
      const acts = new Set(c.supportedActions);
      const pats = c.patterns.join(",");
      const exposed = c.patterns.length > 0;
      if (ct === "Button") bump("button", exposed, acts.has("invoke") ? "InvokePattern" : (acts.has("toggle") ? "TogglePattern" : "none"));
      else if (ct === "Edit") bump("edit", exposed, "ValuePattern");
      else if (ct === "ComboBox") bump("combobox", exposed, pats.includes("ExpandCollapse") ? "ExpandCollapsePattern" : "ValuePattern");
      else if (ct === "MenuItem") bump("menuItem", exposed, "InvokePattern");
      else if (ct === "CheckBox" || ct === "RadioButton") bump("switch", exposed, "TogglePattern");
      else if (ct === "TabItem") bump("tab", exposed, "SelectionItemPattern");
      else if (ct === "Slider" || ct === "Spinner") bump("slider", exposed, "RangeValuePattern");
      else if (ct === "ListItem" || ct === "TreeItem" || ct === "DataItem") bump("listItem", exposed, "SelectionItemPattern");
      else if (ct === "Custom" || ct === "Image" || ct === "Text") bump("custom", c.enabled && c.focusable, "KeyboardFallback");
      else bump("other", exposed, "patterns");
    }
  }
  await performUiAction({ hwnd: hwnd!, selector: pages[0]!.sel, action: "invoke", timeoutMs: 10000 }).catch(() => undefined);
  await sleep(400);

  // ── Profile runtime verification (non-menu controls) ──
  // Home-page controls resolve on the home page.
  const deviceControls = new Set([
    "epsilonPortCombo", "pressurePortCombo", "humidityPortCombo", "lidarPortCombo",
    "temperaturePortCombo", "ai8TemperaturePortCombo", "ai8TemperatureBaudCombo",
    "ai8TemperatureRateCombo", "pressureSourceCombo", "humiditySourceCombo"
  ]);
  for (const [name, raw] of Object.entries(vaporViewProfile.controls)) {
    const entry = normalizeControlEntry(raw);
    if (!entry) continue;
    if (/^titleMenu|^aboutDialog/.test(name)) continue;       // verified with menu open
    if (deviceControls.has(name)) continue;                    // verified on device page
    if (/^logFilter.+MenuAction$/.test(name)) continue;        // verified with filter menu open
    if (name === "logFilterMenu") continue;                    // window is lazily created on first open
    if (entry.confidence === "unsupported") continue;          // expected unresolvable
    await resolveProfileControlSafe(name, entry);
  }
  // Device-page controls resolve on the device-config page.
  await performUiAction({ hwnd: hwnd!, selector: { automationId: SIDEBAR, name: "设备配置" }, action: "invoke", timeoutMs: 10000 }).catch(() => undefined);
  await sleep(1000);
  for (const name of deviceControls) {
    const entry = normalizeControlEntry(vaporViewProfile.controls[name]);
    if (entry) await resolveProfileControlSafe(name, entry);
  }
  await performUiAction({ hwnd: hwnd!, selector: { automationId: SIDEBAR, name: "首页" }, action: "invoke", timeoutMs: 10000 }).catch(() => undefined);
  await sleep(400);

  // ── Profile runtime verification (menu + dialog controls) ──
  // Open the menu once, resolve the section rows and the Help submenu items.
  let menuOpened = false;
  try {
    await performProfileAction(deps, { profile: "vaporview", control: "titleBarMenuButton", action: "openMenu", pid, hwnd, timeoutMs: 15000 });
    menuOpened = true;
    await sleep(300);
    for (const name of Object.keys(vaporViewProfile.controls)) {
      if (!/^titleMenuFileSection$|^titleMenuViewSection$|^titleMenuDeveloperSection$|^titleMenuHelpSection$/.test(name)) continue;
      const entry = normalizeControlEntry(vaporViewProfile.controls[name])!;
      await resolveProfileControlSafe(name, entry);
    }
    // Help submenu items
    await performProfileAction(deps, { profile: "vaporview", control: "titleMenuHelpSection", action: "openSubmenu", pid, hwnd, timeoutMs: 15000 }).catch(() => undefined);
    await sleep(400);
    for (const name of ["titleMenuCheckUpdates", "titleMenuAbout"]) {
      const entry = normalizeControlEntry(vaporViewProfile.controls[name])!;
      await resolveProfileControlSafe(name, entry);
    }
    // Close the menu via Escape (no mouse).
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
    await sleep(300);
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
    await sleep(300);
  } catch { /* menu probe best-effort */ }
  void menuOpened;

  // ── Profile runtime verification (log-filter menu rows) ──
  // Rows only exist in the tree while logFilterMenu is open.
  try {
    await performProfileAction(deps, { profile: "vaporview", control: "logFilterButton", action: "invoke", pid, hwnd, timeoutMs: 10000 }).catch(() => undefined);
    await sleep(400);
    for (const name of ["logFilterMenu", "logFilterAttentionMenuAction", "logFilterAllMenuAction", "logFilterDebugMenuAction", "logFilterAutoFollowMenuAction"]) {
      const entry = normalizeControlEntry(vaporViewProfile.controls[name])!;
      await resolveProfileControlSafe(name, entry);
    }
    // Close the filter menu via Escape on its popup window.
    const filterWin = await getUiElement({ pid, selector: { automationId: "QApplication.logFilterMenu" }, includeProcessPopups: true, timeoutMs: 5000 }).catch(() => null);
    if (filterWin && filterWin.found) {
      await sendKey({ hwnd: filterWin.element!.nativeWindowHandle, key: "escape", noActivate: true }).catch(() => undefined);
      await sleep(300);
    }
  } catch { /* filter-menu probe best-effort */ }

  // ── action-smoke-verified: count how many of the ACTION_SMOKE_VERIFIED set
  // are profile controls (they were operated in smoke:uia-vaporview). ──
  let actionSmokeVerified = 0;
  for (const c of ACTION_SMOKE_VERIFIED) {
    if (normalizeControlEntry(vaporViewProfile.controls[c])) actionSmokeVerified++;
  }

  const report = {
    byCategory: byCat,
    actionSmokeVerifiedCount: actionSmokeVerified,
    actionSmokeVerifiedSet: [...ACTION_SMOKE_VERIFIED],
    profileRuntimeVerified,
    profileSourceDerived,
    profileUnresolved,
    unresolvedControls: unresolved,
    generatedAt: new Date().toISOString(),
  };

  console.log("\n=== VAPORVIEW UIA COVERAGE ===");
  console.log("(pattern-exposed != action-verified. These are reported separately.)\n");
  console.log("category              total  patternExposed  unsupported  method");
  for (const [cat, e] of Object.entries(byCat)) {
    const methods = Object.entries(e.methods).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`${cat.padEnd(20)}  ${String(e.total).padStart(5)}  ${String(e.patternExposed).padStart(14)}  ${String(e.unsupported).padStart(11)}  ${methods}`);
  }
  const totalCats = Object.values(byCat).reduce((a, e) => a + e.total, 0);
  const totalExposed = Object.values(byCat).reduce((a, e) => a + e.patternExposed, 0);
  console.log(`\nPattern-exposed coverage:        ${totalExposed}/${totalCats} (${totalCats ? Math.round(100 * totalExposed / totalCats) : 0}%)`);
  console.log(`Action-smoke-verified (sample):  ${actionSmokeVerified} controls (operated in smoke:uia-vaporview with verified state change)`);
  console.log(`Profile runtime-verified:        ${profileRuntimeVerified}`);
  console.log(`Profile source-derived:          ${profileSourceDerived}`);
  console.log(`Profile unresolved:              ${profileUnresolved}`);
  if (unresolved.length) console.log("Unresolved: " + unresolved.join(", "));

  const outPath = path.join(tmpdir(), `vaporview-coverage-${pid}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nCoverage report written to: ${outPath} (temp dir, not committed)`);

  // Custom-painted non-interactive Text/Image controls are NOT required to be
  // clickable (documented); only flag standard categories that are unexpectedly
  // non-pattern-exposed as a NOTE (disabled/offscreen is acceptable).
  for (const cat of ["button", "edit", "combobox", "switch", "tab", "slider"]) {
    const e = byCat[cat];
    if (e && e.patternExposed < e.total) {
      console.log(`NOTE: ${cat} has ${e.total - e.patternExposed} non-pattern-exposed (may be disabled/offscreen - acceptable)`);
    }
  }
} catch (e) {
  console.error("COVERAGE FAILED:", e instanceof Error ? e.message : String(e));
  exitCode = 1;
} finally {
  await closeApp(pid).catch(() => undefined);
  console.log(`Cleaned up pid=${pid}.`);
}
if (exitCode !== 0) process.exit(exitCode);
console.log("smoke:uia-vaporview-coverage DONE");
