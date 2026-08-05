// Page-restore fixture smoke (public, no private app dependencies).
//
// Compiles a tiny WPF app with THREE mutually-exclusive CheckBoxes (pages)
// (Home / Settings / Device) into a temp directory, loads a temp App Pack
// that declares them as one selectionGroup, then verifies REAL page
// capture/restore through the public MCP surface:
//   - capture happens BEFORE the action and records the ACTUALLY selected
//     page (never the step's target),
//   - restore re-selects the original page and VERIFIES by re-querying the
//     live UI (original selected, target deselected).
//
// The fixture and the pack are written to the system temp dir and deleted
// afterwards; nothing is committed. Exit 77 (SKIPPED) when a C# compiler is
// unavailable.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startServer, initialize, callTool } from "./mcp-client.js";

const CSC = process.env.CSC_EXE
  ?? "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

const FIXTURE_CS = `
using System;
using System.Windows;
using System.Windows.Controls;
public class WpfFixture {
  [STAThread]
  public static void Main() {
    var app = new Application();
    var win = new Window { Title = "WpfFixture", Width = 300, Height = 200 };
    var stack = new StackPanel();
    var home = new CheckBox { Content = "homeTab", IsChecked = true, Margin = new Thickness(10) };
    var settings = new CheckBox { Content = "settingsTab", Margin = new Thickness(10) };
    var device = new CheckBox { Content = "deviceTab", Margin = new Thickness(10) };
    // Mutually exclusive pages (radio semantics via checkbox toggle state).
    home.Checked += (s, e) => { if (home.IsChecked == true) { settings.IsChecked = false; device.IsChecked = false; } };
    settings.Checked += (s, e) => { if (settings.IsChecked == true) { home.IsChecked = false; device.IsChecked = false; } };
    device.Checked += (s, e) => { if (device.IsChecked == true) { home.IsChecked = false; settings.IsChecked = false; } };
    stack.Children.Add(home); stack.Children.Add(settings); stack.Children.Add(device);
    win.Content = stack;
    win.Show();
    app.Run(win);
  }
}
`;

// csc (C# 5) needs the WPF assemblies by absolute path.
const WPF_DIR = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/WPF";

async function compileFixture(dir: string): Promise<string> {
  await writeFile(path.join(dir, "PageFixture.cs"), FIXTURE_CS, "utf8");
  const r = spawnSync(CSC, [
    "/nologo", "/target:winexe", "/out:" + path.join(dir, "PageFixture.exe"),
    "/r:System.dll", "/r:System.Xaml.dll",
    `/r:${WPF_DIR}/WindowsBase.dll`, `/r:${WPF_DIR}/PresentationCore.dll`, `/r:${WPF_DIR}/PresentationFramework.dll`,
    path.join(dir, "PageFixture.cs")
  ], { encoding: "utf8", timeout: 60000 });
  if (r.status !== 0) {
    throw new Error(`csc failed: ${r.stdout} ${r.stderr}`);
  }
  return path.join(dir, "PageFixture.exe");
}

async function writeFixturePack(dir: string): Promise<void> {
  const packDir = path.join(dir, "page-fixture");
  await mkdir(packDir, { recursive: true });
  const control = (name: string) => ({
    selectors: [{ name, controlType: "CheckBox" }],
    confidence: "runtime-verified" as const,
    selectionGroup: "mainNav"
  });
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "page-fixture", displayName: "Page Fixture", version: "1.0.0"
  }), "utf8");
  await writeFile(path.join(packDir, "profile.json"), JSON.stringify({
    id: "page-fixture", executableNames: ["PageFixture.exe"],
    mainWindow: { title: "^WpfFixture$", titleMatch: "regex" },
    launch: { reuseIfRunning: true, waitForWindow: true, timeoutMs: 15000 }
  }), "utf8");
  await writeFile(path.join(packDir, "controls.json"), JSON.stringify({
    controls: {
      homeTab: control("homeTab"),
      settingsTab: control("settingsTab"),
      deviceTab: control("deviceTab")
    }
  }), "utf8");
  await writeFile(path.join(packDir, "actions.json"), JSON.stringify({
    contracts: [
      { control: "settingsTab", action: "ensureSelected", idempotent: true, retrySafe: true, selectionGroup: "mainNav" },
      { control: "deviceTab", action: "ensureSelected", idempotent: true, retrySafe: true, selectionGroup: "mainNav" }
    ]
  }), "utf8");
}

// Read the LIVE selected radio via ui_query (real UI state, no mock).
async function selectedRadio(client: ReturnType<typeof startServer>["client"], hwnd: string): Promise<string | undefined> {
  const q = (await callTool(client, "ui_query", {
    hwnd,
    selector: { controlType: "CheckBox" },
    includeProcessPopups: false,
    maxDepth: 8,
    maxResults: 10,
    timeoutMs: 10000
  })) as { elements?: Array<{ name: string; toggleState: string | null; selected: boolean | null }>; error?: unknown };
  if (!q.elements) {
    console.error("ui_query returned no elements:", JSON.stringify(q));
    process.exit(1);
  }
  const selected = q.elements.filter((e) => e.toggleState === "On" || e.selected === true);
  if (selected.length !== 1) {
    console.error("DEBUG selectedRadio elements:", JSON.stringify(q.elements));
  }
  return selected.length === 1 ? selected[0]!.name : undefined;
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "page-fixture-"));
  let pid: number | undefined;
  const { child, client } = startServer(["--app-pack-dir", dir]);
  try {
    // 1. Compile the fixture (SKIP when no C# compiler).
    let exe: string;
    try {
      exe = await compileFixture(dir);
    } catch (error) {
      console.log(`SKIPPED: C# compiler unavailable (${error instanceof Error ? error.message : String(error)}).`);
      process.exit(77);
    }
    await writeFixturePack(dir);
    await initialize(client);

    // 2. Load the fixture pack.
    const list = (await callTool(client, "app_pack_list", {})) as { packs: Array<{ id: string; valid: boolean }> };
    const pack = list.packs.find((p) => p.id === "page-fixture");
    assert.ok(pack && pack.valid, `page-fixture pack must load, got ${JSON.stringify(list.packs)}`);

    // 3. Launch; default page is Home (checked at construction).
    const launch = (await callTool(client, "profile_launch", { profile: "page-fixture", exePath: exe, reuseIfRunning: false })) as {
      success?: boolean; pid?: number; hwnd?: string; error?: { code?: string; message?: string };
    };
    if (!launch.pid) {
      console.error("profile_launch failed:", JSON.stringify(launch));
      process.exit(1);
    }
    pid = launch.pid;
    const hwnd = String(launch.hwnd);
    await new Promise((r) => setTimeout(r, 600));
    const before = await selectedRadio(client, hwnd);
    assert.equal(before, "homeTab", `fixture must start on Home, got '${before}'`);

    // 4. Navigate to Settings with page capture/restore.
    const run = (await callTool(client, "run_steps", {
      steps: [
        {
          id: "nav",
          tool: "profile_action",
          args: { profile: "page-fixture", pid, hwnd, control: "settingsTab", action: "ensureSelected" },
          captureBefore: { saveAs: "page", read: { tool: "ui_get", args: { hwnd, selector: { name: "homeTab", controlType: "CheckBox" } } } }
        }
      ],
      restore: "always"
    }, 120000)) as {
      success: boolean;
      restoreResults: Array<{
        kind: string; attempted: boolean; success: boolean; verified: boolean; code?: string;
        expected?: unknown; actual?: unknown; method?: string;
      }>;
      error?: { code?: string; message?: string };
    };
    if (!run.success) {
      console.error("run_steps failed:", JSON.stringify(run.error ?? run));
      process.exit(1);
    }
    const restore = run.restoreResults[0]!;
    assert.equal(restore.kind, "page");
    assert.equal(restore.expected, "homeTab", "captured page must be the ORIGINAL page (Home), not the target Settings");
    assert.equal(restore.verified, true, "restore must verify by re-querying the live UI");
    assert.equal(restore.success, true);

    // 5. Confirm with a live UI query: Home selected, Settings NOT selected.
    const after = await selectedRadio(client, hwnd);
    assert.equal(after, "homeTab", `after restore the live UI must read Home, got '${after}'`);
    const settings = (await callTool(client, "ui_get", {
      hwnd, selector: { name: "settingsTab", controlType: "CheckBox" }, timeoutMs: 10000
    })) as { element?: { toggleState: string | null; selected: boolean | null } };
    const settingsOn = settings.element?.toggleState === "On" || settings.element?.selected === true;
    assert.equal(settingsOn, false, "the target page must be deselected after restore");

    console.log(`page restore fixture: PASS (original=homeTab, target=settingsTab, restored to ${after})`);
  } finally {
    if (pid !== undefined) {
      await callTool(client, "close_app", { pid }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800)); // let the process release the exe
    }
    child.kill();
    // Best-effort cleanup: a lingering process handle may keep the exe busy;
    // temp dir leftovers are harmless.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
