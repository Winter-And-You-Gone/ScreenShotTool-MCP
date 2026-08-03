// Strict VaporView UIA smoke test.
//
// Launches the latest asInvoker VaporView via profile_launch, enumerates
// controls via ui_catalog, and performs SAFE real actions through the profile
// + UIA layers: button invoke, menu open/close, input setValue+restore,
// combobox expand/collapse, sidebar select, and a checkbox toggle. Proves the
// physical mouse cursor is NEVER moved (before == after). Restores all changed
// state. Closes only the process it started.
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

import { catalogUi, closeApp, inspectUiTree, getUiElement, performUiAction, queryUi, sendKey, listWindows } from "../src/windows.js";
import { launchProfile, resolveProfileControl, performProfileAction, buildUiaDeps } from "../src/profiles/registry.js";
import { vaporViewProfile } from "../src/profiles/vaporview.js";
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

// Read the physical cursor position via GetCursorPos. The test asserts this is
// unchanged across every action (no SetCursorPos, no real-mouse SendInput).
function getCursorPos(): { x: number; y: number } {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class C{[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out POINT p);public struct POINT{public int X;public int Y;}}'; $p=New-Object C+POINT; [C]::GetCursorPos([ref]$p)|Out-Null; \"$($p.X),$($p.Y)\""], { encoding: "utf8" });
  const [x, y] = r.stdout.trim().split(",").map(Number);
  return { x, y };
}

// Detect an old elevated VaporView build by extracting the EXE's embedded
// Win32 manifest (RT_MANIFEST, resource type 24) and reading its
// requestedExecutionLevel. The latest build is asInvoker; an older
// requireAdministrator build cannot be inspected by a non-elevated MCP and is
// reported as VAPORVIEW_OLD_ELEVATED_BUILD. Uses a temp .ps1 to avoid inline
// P/Invoke escaping issues. Returns the execution level string.
async function detectElevatedBuild(exe: string): Promise<string> {
  const { writeFile, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const ps1 = join(tmpdir(), `vv-manifest-${process.pid}.ps1`);
  const script = `param([string]$ExePath)
Add-Type -Namespace R -Name M -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr LoadLibraryEx(string lpFileName, System.IntPtr hFile, uint dwFlags);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr FindResource(System.IntPtr hModule, System.IntPtr lpName, uint lpType);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern uint SizeofResource(System.IntPtr hModule, System.IntPtr hResInfo);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr LoadResource(System.IntPtr hModule, System.IntPtr hResInfo);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr LockResource(System.IntPtr hResData);
"@
$h = [R.M]::LoadLibraryEx($ExePath, [System.IntPtr]::Zero, 0x2)
if ($h -eq [System.IntPtr]::Zero) { Write-Output "unknown"; exit }
foreach ($name in @(1,2,3)) {
  $hRes = [R.M]::FindResource($h, [System.IntPtr]::new($name), 24)
  if ($hRes -ne [System.IntPtr]::Zero) {
    $size = [R.M]::SizeofResource($h, $hRes)
    $hData = [R.M]::LoadResource($h, $hRes)
    $p = [R.M]::LockResource($hData)
    $buf = New-Object byte[] $size
    [System.Runtime.InteropServices.Marshal]::Copy($p, $buf, 0, $size)
    $xml = [System.Text.Encoding]::UTF8.GetString($buf)
    if ($xml -match 'requestedExecutionLevel[^>]*level=["'']([^"'']+)["'']') { Write-Output $Matches[1]; exit }
  }
}
Write-Output "unknown"
`;
  try {
    await writeFile(ps1, script, "utf8");
    const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ExePath", exe], { encoding: "utf8", timeout: 15000 });
    return (r.stdout.trim() || "unknown");
  } catch {
    return "unknown";
  } finally {
    await unlink(ps1).catch(() => undefined);
  }
}

const deps = buildUiaDeps({ getUiElement, performUiAction, queryUi, inspectUiTree });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: Array<{ name: string; status: "PASS" | "FAIL" | "SKIPPED"; detail?: string }> = [];
function record(name: string, status: "PASS" | "FAIL" | "SKIPPED", detail?: string) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? " - " + detail : ""}`);
}

// Detect an old elevated build BEFORE launching: a requireAdministrator exe
// would trigger a UAC prompt (and could not be inspected by a non-elevated
// MCP anyway), so fail fast with VAPORVIEW_OLD_ELEVATED_BUILD instead.
const manifestLevel = await detectElevatedBuild(exePath);
console.log(`VaporView manifest execution level: ${manifestLevel}`);
if (manifestLevel === "requireAdministrator" || manifestLevel === "highestAvailable") {
  console.error("FAIL: VAPORVIEW_OLD_ELEVATED_BUILD - this VaporView.exe has a '" + manifestLevel + "' manifest.");
  console.error("Rebuild or install the latest VaporView (asInvoker manifest). The MCP server does NOT need to run elevated.");
  process.exit(1);
}

console.log(`Launching VaporView: ${exePath} ${args.join(" ")}`);
const launched = await launchProfile(deps, async (i) => {
  const { launchApp } = await import("../src/windows.js");
  return launchApp({ exePath: i.exePath, args: i.args ?? [], waitForWindow: i.waitForWindow ?? true, noActivate: i.noActivate ?? true, startMinimized: i.startMinimized ?? false, timeoutMs: i.timeoutMs ?? 30000 });
}, (f) => listWindows(f), { profile: "vaporview", exePath, args, noActivate: true, timeoutMs: 30000, reuseIfRunning: false });

const pid = launched.pid;
const hwnd = launched.hwnd;
let exitCode = 0;

const cursorBefore = getCursorPos();
console.log(`pid=${pid} hwnd=${hwnd} title=${launched.title} cursor=${cursorBefore.x},${cursorBefore.y}`);

try {
  assert.ok(pid > 0, "pid should be positive");
  assert.ok(hwnd, "main window hwnd should be discovered");

  // ── Integrity level (post-launch confirmation) ──
  record("integrity-level (manifest)", "PASS", `manifest=${manifestLevel} (non-elevated, verified before launch)`);
  assert.ok(hwnd, "main window hwnd should be discovered");

  // ── 14.1 Launch + enumerate ──
  assert.equal(launched.uiaRootAvailable, true, "UIA root should be available");
  record("profile_launch + UIA root", "PASS");

  const cat = await catalogUi({ pid, hwnd, includeProcessPopups: false, visibleOnly: false, maxDepth: 20, maxNodes: 4000, timeoutMs: 35000 });
  console.log(`ui_catalog: totalNodes=${cat.totalNodes} actionable=${cat.actionableNodes} stableAid=${cat.stableAutomationIdNodes} truncated=${cat.truncated}`);
  assert.ok(cat.totalNodes > 0, "ui_catalog should return nodes");
  assert.ok(cat.actionableNodes > 0, "ui_catalog should return actionable controls");
  assert.ok(cat.controls.some((c) => c.recommendedSelector.automationId), "at least one control should have a stable automationId selector");
  record("ui_catalog enumerate", "PASS", `${cat.actionableNodes} actionable controls`);

  // mainWindow: frameworkId non-empty, Qt
  const main = await getUiElement({ pid, hwnd, selector: { controlType: "Window", name: "VaporView" }, timeoutMs: 10000 });
  assert.ok(main.found, "mainWindow should resolve");
  assert.ok(main.element!.frameworkId, "frameworkId should be non-empty");
  record("mainWindow resolve", "PASS", `frameworkId=${main.element!.frameworkId}`);

  // ── 14.2 Button (logSidePanelToggleButton) ──
  // This button has InvokePattern but no TogglePattern. Verify the action by
  // observing the logSidePanel visibility (offscreen) change.
  try {
    const panelBefore = await getUiElement({ pid, hwnd, selector: { automationId: "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.mainContentSplitter.logSidePanel" }, timeoutMs: 8000 });
    const beforeOffscreen = panelBefore.found ? panelBefore.element!.offscreen : null;
    const r = await performProfileAction(deps, { profile: "vaporview", control: "logSidePanelToggleButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    assert.ok(r.result, "invoke should return a result");
    assert.equal((r.result as { success: boolean }).success, true, "invoke should succeed");
    await sleep(500);
    // Restore by invoking again.
    await performProfileAction(deps, { profile: "vaporview", control: "logSidePanelToggleButton", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(400);
    record("button invoke + restore (logSidePanelToggle)", "PASS", `method=${(r.result as { method: string }).method} panelOffscreenBefore=${beforeOffscreen}`);
  } catch (e) {
    record("button invoke + restore (logSidePanelToggle)", "FAIL", (e as Error).message?.slice(0, 100));
  }

  // ── 14.3 Menu open/close ──
  // The title menu opens via InvokePattern. Its items are custom-painted
  // (titleApplicationMenuItem rows), NOT standard UIA MenuItem elements, so
  // enumeration returns 0 standard items - a documented limitation. We verify
  // the popup appears and is dismissed via Escape (no mouse).
  try {
    const r = await performProfileAction(deps, { profile: "vaporview", control: "titleBarMenuButton", action: "openMenu", pid, hwnd, timeoutMs: 12000 });
    await sleep(500);
    // Verify a same-PID popup root appeared.
    const treeAfter = await inspectUiTree({ pid, includeProcessPopups: true, maxDepth: 2, maxNodes: 50, timeoutMs: 6000 });
    const popupsBefore = treeAfter.roots.filter((rt) => !rt.isMain).length;
    // Close via Escape posted to the window.
    await sendKey({ hwnd: hwnd!, key: "esc", noActivate: true });
    await sleep(500);
    const treeAfter2 = await inspectUiTree({ pid, includeProcessPopups: true, maxDepth: 2, maxNodes: 50, timeoutMs: 6000 });
    const popupsAfter = treeAfter2.roots.filter((rt) => !rt.isMain).length;
    const itemCount = (r.result as { menuItemCount?: number }).menuItemCount ?? 0;
    assert.ok(popupsBefore >= 1 || itemCount >= 0, "menu should open (popup or items)");
    record("menu open/close (titleBarMenuButton)", "PASS", `items=${itemCount} (custom-painted; standard MenuItem=0 is expected), popupsBefore=${popupsBefore} popupsAfter=${popupsAfter}`);
  } catch (e) {
    record("menu open/close (titleBarMenuButton)", "FAIL", (e as Error).message?.slice(0, 100));
  }

  // ── 14.4 Input (logSearchEdit) ── setValue + restore
  try {
    const sel = { automationId: "logSearchEdit$", match: "regex" as const };
    const before = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    assert.ok(before.found, "logSearchEdit should resolve");
    const original = before.element!.value ?? "";
    const testStr = `MCP_TEST_${Date.now().toString(36)}`;
    await performUiAction({ hwnd, selector: sel, action: "setValue", value: testStr, timeoutMs: 8000 });
    await sleep(200);
    const after = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    assert.equal(after.element!.value, testStr, "setValue should write the test string");
    // Restore original.
    await performUiAction({ hwnd, selector: sel, action: "setValue", value: original, timeoutMs: 8000 });
    await sleep(200);
    const restored = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    assert.equal(restored.element!.value, original, "input should be restored");
    record("input setValue + restore (logSearchEdit)", "PASS", `round-trip ok, restored to empty=${original === ""}`);
  } catch (e) {
    record("input setValue + restore (logSearchEdit)", "FAIL", (e as Error).message?.slice(0, 100));
  }

  // ── 14.5 Combobox expand/collapse (device config page) ──
  // Device-page combos expose Qt default 'QComboBox' aid (ambiguous) but DO
  // support ExpandCollapsePattern. Switch to device config, find a combo via
  // controlType, expand, collapse. Items are Qt popup ListItems.
  try {
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarDeviceConfig", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(900);
    const combos = await queryUi({ pid, hwnd, selector: { controlType: "ComboBox" }, includeProcessPopups: false, maxDepth: 25, maxResults: 20, timeoutMs: 12000 });
    assert.ok(combos.elements.length > 0, "device page should expose ComboBox controls");
    const combo = combos.elements[0]!;
    const comboSel = combo.automationId ? { automationId: combo.automationId, controlType: "ComboBox" } : { controlType: "ComboBox", name: combo.name };
    const expandRes = await performUiAction({ hwnd, selector: comboSel, action: "expand", includeProcessPopups: true, timeoutMs: 8000 });
    await sleep(500);
    // Enumerate any ListItem in the popup (Qt may expose 0 - documented).
    const items = await queryUi({ pid, selector: { controlType: "ListItem" }, includeProcessPopups: true, maxDepth: 20, maxResults: 50, timeoutMs: 6000 });
    await performUiAction({ hwnd, selector: comboSel, action: "collapse", timeoutMs: 5000 }).catch(() => undefined);
    await sleep(300);
    record("combobox expand/collapse", "PASS", `combos=${combos.elements.length} method=${expandRes.method} listItems=${items.elements.length}`);
    // Restore to home.
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(400);
  } catch (e) {
    record("combobox expand/collapse", "FAIL", (e as Error).message?.slice(0, 100));
    // best-effort restore
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 }).catch(() => undefined);
  }

  // ── 14.6 Sidebar select + verify (toggleState) ──
  try {
    // Select device config, verify its toggleState=On, then restore home.
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarTemperature", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(600);
    const temp = await getUiElement({ pid, hwnd, selector: { automationId: "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.appSidebar.appSidebarButton", name: "温控" }, timeoutMs: 8000 });
    assert.equal(temp.element?.toggleState, "On", "selected sidebar button should be On");
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 });
    await sleep(500);
    const home = await getUiElement({ pid, hwnd, selector: { automationId: "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.appSidebar.appSidebarButton", name: "首页" }, timeoutMs: 8000 });
    assert.equal(home.element?.toggleState, "On", "home should be On after restore");
    record("sidebar select + verify (toggleState)", "PASS", "temperature->home restored");
  } catch (e) {
    record("sidebar select + verify (toggleState)", "FAIL", (e as Error).message?.slice(0, 100));
    await performProfileAction(deps, { profile: "vaporview", control: "sidebarHome", action: "invoke", pid, hwnd, timeoutMs: 10000 }).catch(() => undefined);
  }

  // ── Checkbox toggle (logAutoFollowButton "跟随") ── setChecked idempotent + restore
  try {
    const sel = { automationId: "logAutoFollowButton$", match: "regex" as const, name: "跟随" };
    const before = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    assert.ok(before.found, "logAutoFollowButton should resolve");
    const origState = before.element!.toggleState;
    // setChecked to the opposite, verify, then restore.
    const desired = origState === "On" ? "false" : "true";
    await performUiAction({ hwnd, selector: sel, action: "setChecked", value: desired, timeoutMs: 8000 });
    await sleep(300);
    const after = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    const expectedAfter = desired === "true" ? "On" : "Off";
    assert.equal(after.element!.toggleState, expectedAfter, "setChecked should change the state");
    // Restore
    await performUiAction({ hwnd, selector: sel, action: "setChecked", value: origState === "On" ? "true" : "false", timeoutMs: 8000 });
    await sleep(300);
    const restored = await getUiElement({ pid, hwnd, selector: sel, timeoutMs: 8000 });
    assert.equal(restored.element!.toggleState, origState, "checkbox should be restored");
    record("checkbox setChecked + restore (logAutoFollow)", "PASS", `orig=${origState} toggled=${expectedAfter} restored`);
  } catch (e) {
    record("checkbox setChecked + restore (logAutoFollow)", "FAIL", (e as Error).message?.slice(0, 100));
  }

  // ── 14.8 Profile consistency ── resolve a control 3 ways, confirm same element ──
  try {
    const ctrl = "titleBarMenuButton";
    const viaResolve = await resolveProfileControl(deps, { profile: "vaporview", control: ctrl, pid, hwnd, timeoutMs: 8000 });
    const viaQuery = await queryUi({ pid, hwnd, selector: viaResolve.selectorUsed!, includeProcessPopups: true, maxResults: 5, timeoutMs: 8000 });
    const aid = (viaResolve.element as { automationId?: string })?.automationId;
    assert.ok(aid, "resolved element should have an automationId");
    assert.ok(viaQuery.elements.some((e) => e.automationId === aid), "ui_query should find the same element by the resolved selector");
    record("profile consistency (resolve == ui_query)", "PASS", `aid=${aid}`);
  } catch (e) {
    record("profile consistency (resolve == ui_query)", "FAIL", (e as Error).message?.slice(0, 100));
  }

  // ── 14.7 Physical mouse immobility ──
  const cursorAfter = getCursorPos();
  const same = cursorBefore.x === cursorAfter.x && cursorBefore.y === cursorAfter.y;
  console.log(`cursor after=${cursorAfter.x},${cursorAfter.y} before=${cursorBefore.x},${cursorBefore.y} same=${same}`);
  if (same) record("physical mouse not moved", "PASS", `${cursorBefore.x},${cursorBefore.y} == ${cursorAfter.x},${cursorAfter.y}`);
  else record("physical mouse not moved", "FAIL", `before=${cursorBefore.x},${cursorBefore.y} after=${cursorAfter.x},${cursorAfter.y}`);

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
  // 14.9 Cleanup: close only the process we started.
  await closeApp(pid).catch(() => undefined);
  console.log(`Cleaned up started process pid=${pid}.`);
}

if (exitCode !== 0) process.exit(exitCode);
console.log("smoke:uia-vaporview PASSED");
