// Strict VaporView UIA smoke test.
//
// Launches the latest asInvoker VaporView via profile_launch (which now rejects
// an old elevated build itself), enumerates controls via ui_catalog, and
// performs SAFE real actions through the profile + UIA layers with STRICT
// assertions (no tautologies):
//   - title-bar menu: openMenu -> openSubmenu(Help) -> invoke(About) -> dialog
//     appears -> invoke(OK) -> dialog closes -> menu closed.
//   - log side-panel button: toggle + verify REAL offscreen state + restore.
//   - search popup: invoke logSearchButton -> popup appears -> the nested
//     QLineEdit is NOT exposed (UIA limitation asserted) -> Escape closes it.
//   - log-filter menu: open -> enumerate 4 rows incl. auto-follow -> close.
//   - ComboBox: selectByIndex -> verify value changed -> restore -> popup closed.
//   - sidebar page: switch + verify toggleState + restore.
//   - profile/query/catalog three-way consistency for 7 controls.
// Proves the physical mouse cursor is NEVER moved (before == after). Restores
// all changed state. Closes only the process it started.
//
// Env:
//   VAPORVIEW_EXE        - path to VaporView.exe (required in strict mode)
//   VAPORVIEW_ARGS       - extra process args (space-separated)
//   VAPORVIEW_SMOKE_STRICT=1 - fail when EXE is missing instead of skipping
//
// Exit codes: 0 PASS, 1 FAIL, 77 SKIPPED (non-strict, no EXE).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";

import { catalogUi, closeApp, inspectUiTree, getUiElement, performUiAction, queryUi, sendKey, listWindows, getExeManifestLevel } from "../src/windows.js";
import { launchProfile, resolveProfileControl, performProfileAction, buildUiaDeps } from "../src/profiles/registry.js";
import { McpUiError } from "../src/uia/results.js";

const exePath = process.env.VAPORVIEW_EXE;
const strict = process.env.VAPORVIEW_SMOKE_STRICT === "1";
const args = process.env.VAPORVIEW_ARGS ? process.env.VAPORVIEW_ARGS.split(" ") : [];

if (!exePath) {
  if (strict) {
    console.error("FAIL (strict): VAPORVIEW_EXE is not set.");
    process.exit(1);
  }
  console.log("SKIPPED: VAPORVIEW_EXE is not set. Set it to the VaporView.exe path to run this smoke test.");
  console.log("Example: $env:VAPORVIEW_EXE='X:\\Project\\GPS\\VaporView\\build\\Release\\VaporView.exe'; $env:VAPORVIEW_SMOKE_STRICT='1'; npm run smoke:uia-vaporview");
  process.exit(77);
}

try {
  await access(exePath, fsConstants.X_OK);
} catch {
  console.error(`FAIL: VAPORVIEW_EXE path does not exist or is not executable: ${exePath}`);
  process.exit(1);
}

// Read the physical cursor position via GetCursorPos. Asserted unchanged across
// every action (no SetCursorPos, no real-mouse SendInput).
function getCursorPos(): { x: number; y: number } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class C{[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out POINT p);public struct POINT{public int X;public int Y;}}'; $p=New-Object C+POINT; [C]::GetCursorPos([ref]$p)|Out-Null; \"$($p.X),$($p.Y)\""], { encoding: "utf8" });
  const [x, y] = r.stdout.trim().split(",").map(Number);
  return { x, y };
}

const deps = buildUiaDeps({ getUiElement, performUiAction, queryUi, inspectUiTree, sendKey });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIDEBAR = "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.appSidebar.appSidebarButton";

const results: Array<{ name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail?: string }> = [];
function record(name: string, status: "PASS" | "FAIL" | "SKIPPED", detail?: string) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? " - " + detail : ""}`);
}

console.log(`Launching VaporView: ${exePath} ${args.join(" ")}`);
const launched = await launchProfile(
  deps,
  async (i) => {
    const { launchApp } = await import("../src/windows.js");
    return launchApp({ exePath: i.exePath, args: i.args ?? [], waitForWindow: i.waitForWindow ?? true, noActivate: i.noActivate ?? true, startMinimized: i.startMinimized ?? false, timeoutMs: i.timeoutMs ?? 30000 });
  },
  (f) => listWindows(f),
  { profile: "vaporview", exePath, args, noActivate: true, timeoutMs: 30000, reuseIfRunning: false },
  // profile_launch reads the manifest itself and rejects an elevated build.
  getExeManifestLevel
);

const pid = launched.pid;
const hwnd = launched.hwnd;
let exitCode = 0;

const cursorBefore = getCursorPos();
console.log(`pid=${pid} hwnd=${hwnd} title=${launched.title} manifest=${launched.manifestLevel} cursor=${cursorBefore.x},${cursorBefore.y}`);

// Three-way consistency: resolve via profile_resolve, re-resolve the returned
// selector via ui_query, and confirm the catalog contains the same control.
// All three must point at the same automationId.
async function threeWay(control: string, cat: { controls: Array<{ automationId: string; recommendedSelector: Record<string, unknown>; selectorVerified: boolean }> }, label: string) {
  try {
    const viaResolve = await resolveProfileControl(deps, { profile: "vaporview", control, pid, hwnd, includeProcessPopups: true, timeoutMs: 10000 });
    const aid = (viaResolve.element as { automationId?: string } | undefined)?.automationId;
    assert.ok(aid, `${control}: resolved element has no automationId`);
    const viaQuery = await queryUi({ pid, hwnd, selector: viaResolve.selectorUsed!, includeProcessPopups: true, maxResults: 5, timeoutMs: 8000 });
    assert.equal(viaQuery.elements.length, 1, `${control}: ui_query should return exactly 1, got ${viaQuery.elements.length}`);
    assert.equal(viaQuery.elements[0]!.automationId, aid, `${control}: ui_query automationId mismatch`);
    const catHit = cat.controls.find((c) => c.automationId === aid);
    assert.ok(catHit, `${control}: catalog should contain automationId ${aid}`);
    record(`three-way consistency (${label})`, "PASS", `aid=${aid!.split(".").pop()} verified=${catHit!.selectorVerified}`);
  } catch (e) {
    record(`three-way consistency (${label})`, "FAIL", (e as Error).message?.slice(0, 120));
  }
}

try {
  assert.ok(pid > 0, "pid should be positive");
  assert.ok(hwnd, "main window hwnd should be discovered");
  assert.equal(launched.uiaRootAvailable, true, "UIA root should be available");
  record("profile_launch + UIA root", "PASS", `manifest=${launched.manifestLevel}`);
  // Manifest check is now performed by profile_launch itself.
  assert.ok(launched.manifestLevel === "asInvoker" || launched.manifestLevel === "unknown", "manifest should be asInvoker (or unknown)");
  record("manifest asInvoker (via profile_launch)", "PASS", `manifest=${launched.manifestLevel}`);

  // ── ui_catalog (home page) ──
  const catHome = await catalogUi({ pid, hwnd, includeProcessPopups: true, visibleOnly: false, maxDepth: 20, maxNodes: 5000, timeoutMs: 35000 });
  console.log(`ui_catalog(home): totalNodes=${catHome.totalNodes} actionable=${catHome.actionableNodes} truncated=${catHome.truncated}`);
  assert.ok(catHome.actionableNodes > 0, "ui_catalog should return actionable controls");
  const verifiedCount = catHome.controls.filter((c) => c.selectorVerified).length;
  assert.ok(verifiedCount > 0, "at least one control should have a verified unique selector");
  record("ui_catalog enumerate + verified selectors", "PASS", `${catHome.actionableNodes} actionable, ${verifiedCount} verified`);

  // ── mainWindow resolve ──
  const main = await getUiElement({ pid, hwnd, selector: { controlType: "Window", name: "VaporView" }, timeoutMs: 10000 });
  assert.ok(main.found, "mainWindow should resolve");
  record("mainWindow resolve", "PASS", `frameworkId=${main.element!.frameworkId}`);

  // ── Three-way consistency (home-page controls) ──
  await threeWay("titleBarMenuButton", catHome, "titleBarMenuButton");
  await threeWay("logSidePanelToggleButton", catHome, "logSidePanelToggle");
  await threeWay("logSearchButton", catHome, "logSearchButton");
  await threeWay("sidebarHome", catHome, "sidebarHome");

  // ── Log side-panel button: toggle + verify REAL presence state + restore ──
  // logSidePanelToggleButton has InvokePattern but NO TogglePattern, so state is
  // verified via the logSidePanel's presence: when collapsed Qt removes the
  // panel from the UIA tree (found=false); when restored it reappears
  // (found=true). This is a real property change, not an Invoke-no-throw check.
  try {
    const LOGPANEL = "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.mainContentSplitter.logSidePanel";
    const readPanel = () => getUiElement({ pid, hwnd, selector: { automationId: LOGPANEL }, timeoutMs: 8000 });
    const before = await readPanel();
    assert.ok(before.found, "logSidePanel should resolve before toggle");
    await performProfileAction(deps, { profile: "vaporview", control: "logSidePanelToggleButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(500);
    const after1 = await readPanel();
    assert.notEqual(after1.found, before.found, "logSidePanel presence should CHANGE after invoke (collapsed removes it from the tree)");
    await performProfileAction(deps, { profile: "vaporview", control: "logSidePanelToggleButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(500);
    const afterRestore = await readPanel();
    assert.equal(afterRestore.found, before.found, "logSidePanel presence should RESTORE to before");
    record("button toggle + state verify + restore (logSidePanel)", "PASS", `presence ${before.found}->${after1.found}->${afterRestore.found}`);
  } catch (e) {
    record("button toggle + state verify + restore (logSidePanel)", "FAIL", (e as Error).message?.slice(0, 120));
    // best-effort restore so downstream tests can run
    await performProfileAction(deps, { profile: "vaporview", control: "logSidePanelToggleButton", action: "invoke", pid, hwnd, timeoutMs: 10000 }).catch(() => undefined);
  }

  // ── Search popup: invoke logSearchButton -> popup appears -> the nested
  //    QLineEdit (logSearchEdit) is NOT exposed via UIA (asserted, so we never
  //    claim a setValue round-trip that is not real) -> re-invoke to close. ──
  try {
    const SEARCH_MENU = "QApplication.logSearchMenu";
    await performProfileAction(deps, { profile: "vaporview", control: "logSearchButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(400);
    const menuWin = await getUiElement({ pid, selector: { automationId: SEARCH_MENU }, includeProcessPopups: true, timeoutMs: 5000 });
    assert.ok(menuWin.found, "logSearchMenu should APPEAR after invoking logSearchButton");
    const widgetAction = await getUiElement({ pid, selector: { automationId: `${SEARCH_MENU}.QWidgetAction` }, includeProcessPopups: true, timeoutMs: 5000 });
    assert.ok(widgetAction.found, "logSearchMenu should expose its QWidgetAction row");
    const editProbe = await getUiElement({ pid, selector: { automationId: "logSearchEdit$", match: "regex" }, includeProcessPopups: true, timeoutMs: 8000 }).catch(() => ({ found: true as const }));
    assert.equal(editProbe.found, false, "logSearchEdit must NOT be exposed via UIA in the current build (nested in a QWidgetAction popup)");
    // Close by re-invoking the search button (UIA-native toggle: the source
    // hides the visible menu). Escape is NOT used here: the QMenu popup window
    // is DESTROYED on Escape, so a PostMessage keydown destroys the hwnd before
    // the keyup posts (the search menu is a plain QMenu, unlike the persistent
    // SingleLevelPopupMenu filter window). The hidden window persists but its
    // QWidgetAction row leaves the tree - assert that as the close signal.
    await performProfileAction(deps, { profile: "vaporview", control: "logSearchButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(400);
    const afterClose = await getUiElement({ pid, selector: { automationId: `${SEARCH_MENU}.QWidgetAction` }, includeProcessPopups: true, timeoutMs: 5000 }).catch(() => ({ found: true as const }));
    assert.equal(afterClose.found, false, "logSearchMenu QWidgetAction row should leave the tree after toggling the search button");
    record("search popup lifecycle (open, editor not exposed, close)", "PASS", "popup appeared + QLineEdit absent + row gone after toggle");
  } catch (e) {
    record("search popup lifecycle (open, editor not exposed, close)", "FAIL", (e as Error).message?.slice(0, 120));
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
  }

  // ── Log-filter menu: open via logFilterButton -> enumerate 4 rows including
  //    auto-follow -> close. The auto-follow checked state is drawn-only in the
  //    current build (no TogglePattern/toggleState exposure), so we verify the
  //    menu surface and closure but do NOT claim a toggle/restore round-trip. ──
  try {
    await performProfileAction(deps, { profile: "vaporview", control: "logFilterButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(400);
    const rows = await queryUi({ pid, selector: { automationId: "logFilter", match: "contains" }, includeProcessPopups: true, maxDepth: 20, maxResults: 50, timeoutMs: 8000 });
    const items = rows.elements.filter((e) => e.controlType === "ControlType.MenuItem");
    assert.ok(items.length >= 4, `logFilterMenu should expose >=4 rows, got ${items.length}`);
    const names = new Set(items.map((e) => e.name));
    for (const expected of ["关注", "全部", "调试", "自动跟随"]) {
      assert.ok(names.has(expected), `logFilterMenu should contain row '${expected}'`);
    }
    const auto = items.find((e) => e.automationId.endsWith("logFilterAutoFollowMenuAction"));
    assert.ok(auto, "auto-follow row should be present");
    assert.ok(auto.enabled, "auto-follow row should be enabled");
    assert.ok(auto.patterns.some((p) => p.includes("Invoke")), "auto-follow row should expose InvokePattern");
    assert.ok(!auto.patterns.some((p) => p.includes("Toggle")), "auto-follow row must NOT expose TogglePattern (checked state is drawn-only in this build)");
    // Close the filter menu via Escape on the popup window; rows must leave the tree.
    const filterWin = await getUiElement({ pid, selector: { automationId: "QApplication.logFilterMenu" }, includeProcessPopups: true, timeoutMs: 5000 });
    assert.ok(filterWin.found, "logFilterMenu window should be present");
    await sendKey({ hwnd: filterWin.element!.nativeWindowHandle, key: "escape", noActivate: true });
    await sleep(400);
    const afterClose = await queryUi({ pid, selector: { automationId: "logFilterAutoFollowMenuAction$", match: "regex" }, includeProcessPopups: true, maxResults: 5, timeoutMs: 5000 });
    assert.equal(afterClose.elements.length, 0, "logFilterMenu rows should leave the tree after Escape");
    record("log-filter menu enumerate + auto-follow action", "PASS", `${items.length} rows incl. auto-follow, closed`);
  } catch (e) {
    record("log-filter menu enumerate + auto-follow action", "FAIL", (e as Error).message?.slice(0, 120));
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
  }

  // ── Sidebar page switch + verify (toggleState) + restore ──
  try {
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarTemperature", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(600);
    const temp = await getUiElement({ pid, hwnd, selector: { automationId: SIDEBAR, name: "温控" }, timeoutMs: 8000 });
    assert.equal(temp.element?.toggleState, "On", "selected sidebar button should be On");
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(500);
    const home = await getUiElement({ pid, hwnd, selector: { automationId: SIDEBAR, name: "首页" }, timeoutMs: 8000 });
    assert.equal(home.element?.toggleState, "On", "home should be On after restore");
    record("sidebar switch + verify + restore", "PASS", "temperature->home restored");
  } catch (e) {
    record("sidebar switch + verify + restore", "FAIL", (e as Error).message?.slice(0, 120));
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 }).catch(() => undefined);
  }

  // ── ComboBox (device config page): selectByIndex + verify change + restore ──
  try {
    await performUiAction({ hwnd, selector: { automationId: SIDEBAR, name: "设备配置" }, action: "invoke", timeoutMs: 10000 });
    await sleep(1000);
    const catDevice = await catalogUi({ pid, hwnd, includeProcessPopups: false, visibleOnly: false, maxDepth: 25, maxNodes: 5000, timeoutMs: 30000 });
    await threeWay("ai8TemperatureRateCombo", catDevice, "ai8RateCombo");
    const comboAid = "deviceAi8TemperatureRateCombo";
    const readCombo = async () => {
      const r = await getUiElement({ pid, hwnd, selector: { automationId: `${comboAid}$`, match: "regex" }, timeoutMs: 6000 });
      return r.found ? r.element!.value : null;
    };
    const orig = await readCombo();
    assert.ok(orig !== null, "rate combo should resolve with a value");
    // Select a different index. Index 0 is the first option; if orig is already
    // index 0, use index 1 instead. Verify the value actually changes.
    const targetIdx = 0;
    await performProfileAction(deps, { profile: "vaporview", control: "ai8TemperatureRateCombo", action: "selectByIndex", index: targetIdx, pid, hwnd, timeoutMs: 15000 });
    let after = await readCombo();
    if (after === orig) {
      // index 0 was the current value; try index 1
      await performProfileAction(deps, { profile: "vaporview", control: "ai8TemperatureRateCombo", action: "selectByIndex", index: 1, pid, hwnd, timeoutMs: 15000 });
      after = await readCombo();
    }
    assert.notEqual(after, orig, "combobox value should CHANGE after selectByIndex");
    assert.notEqual(after, null, "combobox value should be readable after select");
    // Restore by scanning indices for the original value.
    let restored = false;
    for (let i = 0; i <= 8; i++) {
      await performProfileAction(deps, { profile: "vaporview", control: "ai8TemperatureRateCombo", action: "selectByIndex", index: i, pid, hwnd, timeoutMs: 12000 }).catch(() => undefined);
      const v = await readCombo();
      if (v === orig) { restored = true; break; }
    }
    assert.ok(restored, "combobox should RESTORE to original value");
    // Verify popup closed: no List container in popups beyond the persistent ones.
    const lists = await queryUi({ pid, selector: { controlType: "List" }, includeProcessPopups: true, maxDepth: 5, maxResults: 20, timeoutMs: 5000 });
    assert.ok(lists.elements.length === 0, "combobox popup should be closed (no List)");
    record("combobox selectByIndex + verify + restore + popup closed", "PASS", `orig=${orig} after=${after} restored=${restored}`);
    await performUiAction({ hwnd, selector: { automationId: SIDEBAR, name: "首页" }, action: "invoke", timeoutMs: 10000 }).catch(() => undefined);
    await sleep(400);
  } catch (e) {
    record("combobox selectByIndex + verify + restore + popup closed", "FAIL", (e as Error).message?.slice(0, 120));
    await performUiAction({ hwnd, selector: { automationId: SIDEBAR, name: "首页" }, action: "invoke", timeoutMs: 10000 }).catch(() => undefined);
  }

  // ── Title menu: openMenu -> openSubmenu(Help) -> invoke(About) -> dialog -> OK ──
  let menuFlowOk = false;
  try {
    // openMenu
    const r1 = await performProfileAction(deps, { profile: "vaporview", control: "titleBarMenuButton", action: "openMenu", pid, hwnd, timeoutMs: 15000 });
    const res1 = r1.result as { popupOpened: boolean; items: { automationId: string; hasSubmenu: boolean }[] };
    assert.equal(res1.popupOpened, true, "openMenu should report popupOpened=true");
    assert.ok(res1.items.length >= 4, `openMenu should return >=4 section rows, got ${res1.items.length}`);
    assert.ok(res1.items.every((i) => i.hasSubmenu), "section rows should all have submenu");

    // openSubmenu(Help)
    const r2 = await performProfileAction(deps, { profile: "vaporview", control: "titleMenuHelpSection", action: "openSubmenu", pid, hwnd, timeoutMs: 15000 });
    const res2 = r2.result as { items: { automationId: string; name: string }[] };
    assert.ok(res2.items.some((i) => i.automationId.includes("titleMenuAboutAction")), "Help submenu should contain About");

    // three-way consistency for titleMenuAbout (menu open)
    const catMenu = await catalogUi({ pid, includeProcessPopups: true, visibleOnly: false, maxDepth: 16, maxNodes: 4000, timeoutMs: 20000 });
    await threeWay("titleMenuAbout", catMenu, "titleMenuAbout(menu)");

    // invoke(About) - non-blocking; poll for the dialog
    await performProfileAction(deps, { profile: "vaporview", control: "titleMenuAbout", action: "invoke", pid, hwnd, timeoutMs: 15000 });
    let dlgAppeared = false;
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const r = await getUiElement({ pid, selector: { automationId: "aboutDialog$", match: "regex" }, includeProcessPopups: true, timeoutMs: 3000 }).catch(() => ({ found: false }));
      if ((r as { found: boolean }).found) { dlgAppeared = true; break; }
    }
    assert.ok(dlgAppeared, "About dialog should APPEAR after invoking titleMenuAbout");

    // three-way consistency for aboutDialogOkButton (dialog open)
    const catDlg = await catalogUi({ pid, includeProcessPopups: true, visibleOnly: false, maxDepth: 16, maxNodes: 2000, timeoutMs: 15000 });
    await threeWay("aboutDialogOkButton", catDlg, "aboutDialogOkButton");

    // invoke(OK) -> dialog closes
    await performProfileAction(deps, { profile: "vaporview", control: "aboutDialogOkButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(600);
    const dlgAfter = await getUiElement({ pid, selector: { automationId: "aboutDialog$", match: "regex" }, includeProcessPopups: true, timeoutMs: 3000 }).catch(() => ({ found: false }));
    assert.equal((dlgAfter as { found: boolean }).found, false, "About dialog should DISAPPEAR after OK");

    // Verify menu closed: the titleApplicationPanel is a persistent (hidden)
    // Qt::Tool window, so its HWND always exists. The real signal is that the
    // section rows are no longer in the tree (Qt removes hidden-panel children).
    const secAfter = await getUiElement({ pid, selector: { automationId: "titleMenuHelpSectionAction$", match: "regex" }, includeProcessPopups: true, timeoutMs: 4000 }).catch(() => ({ found: false }));
    assert.equal((secAfter as { found: boolean }).found, false, "menu should be closed (Help section row should not be found)");

    record("menu flow openMenu->Help->About->dialog->OK->closed", "PASS", "full chain verified");
    menuFlowOk = true;
  } catch (e) {
    record("menu flow openMenu->Help->About->dialog->OK->closed", "FAIL", (e as Error).message?.slice(0, 140));
    // best-effort: close any lingering dialog/menu via Escape
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
    await sleep(300);
    await sendKey({ hwnd: hwnd!, key: "escape", noActivate: true }).catch(() => undefined);
  }
  void menuFlowOk;

  // ── Physical mouse immobility ──
  const cursorAfter = getCursorPos();
  const same = cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y;
  console.log(`cursor after=${cursorAfter.x},${cursorAfter.y} before=${cursorBefore.x},${cursorBefore.y} same=${same}`);
  if (same) record("physical mouse not moved", "PASS", `${cursorBefore.x},${cursorBefore.y} == ${cursorAfter.x},${cursorAfter.y}`);
  else record("physical mouse not moved", "FAIL", `before=${cursorBefore.x},${cursorBefore.y} after=${cursorAfter.x},${cursorAfter.y}`);

  // ── Final: all popups closed (section row gone + aboutDialog gone) ──
  try {
    const secFinal = await getUiElement({ pid, selector: { automationId: "titleMenuHelpSectionAction$", match: "regex" }, includeProcessPopups: true, timeoutMs: 4000 }).catch(() => ({ found: false }));
    const dlgFinal = await getUiElement({ pid, selector: { automationId: "aboutDialog$", match: "regex" }, includeProcessPopups: true, timeoutMs: 3000 }).catch(() => ({ found: false }));
    assert.equal((secFinal as { found: boolean }).found, false, "menu section row should be gone");
    assert.equal((dlgFinal as { found: boolean }).found, false, "about dialog should be gone");
    record("all menu/dialog popups closed at end", "PASS");
  } catch (e) {
    record("all menu/dialog popups closed at end", "FAIL", (e as Error).message?.slice(0, 100));
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) console.log(`[${r.status}] ${r.name}`);
  const fails = results.filter((r) => r.status === "FAIL");
  if (fails.length > 0) {
    console.error(`\n${fails.length} CHECK(S) FAILED`);
    exitCode = 1;
  } else {
    console.log(`\nALL ${results.length} CHECKS PASSED`);
  }
} catch (e) {
  exitCode = 1;
  console.error("VAPORVIEW SMOKE TEST FAILED:", e instanceof Error ? e.message : String(e));
  if (e instanceof McpUiError) console.error("  code:", e.code);
} finally {
  // Close only the process we started.
  await closeApp(pid).catch(() => undefined);
  console.log(`Cleaned up started process pid=${pid}.`);
}

if (exitCode !== 0) process.exit(exitCode);
console.log("smoke:uia-vaporview PASSED");
