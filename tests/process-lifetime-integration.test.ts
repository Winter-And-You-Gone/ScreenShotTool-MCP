// Windows integration test: process lifetime decoupling for real.
//
// Proves the full launchApp(lifetime=independent) path: a PARENT process
// (stand-in for the MCP server) launches a child through the real
// src/windows.ts, the parent EXITS, and the child must survive. This covers
// whichever independent method was actually used (breakaway when the host job
// allows it, detached-spawn otherwise) - the report is read back and
// asserted to be honest (verified true only when proven).
//
// Uses a lightweight node child, never VaporView, and cleans the child up at
// the end - no orphans. Windows-only (job objects are Windows semantics).
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// The test child: waits on a signal file, then exits. Long-lived enough for
// the parent to die first.
const CHILD_SOURCE = `
const fs = require("node:fs");
const signal = process.argv[2];
const timer = setInterval(() => {
  if (fs.existsSync(signal)) { clearInterval(timer); process.exit(0); }
}, 250);
`;

// The parent (stand-in for the MCP server): launches the child through the
// REAL launchApp with lifetime=independent, prints the pid, then exits. The
// child must survive this parent's exit.
const PARENT_SOURCE = `
import { launchApp } from ${JSON.stringify(pathToFileUrl(path.resolve("src", "windows.js"))).replace(/"/g, "'")};
const [exe, childScript, signalPath] = process.argv.slice(2);
const result = await launchApp({ exePath: exe, args: [childScript, signalPath], waitForWindow: false, lifetime: "independent" });
console.log(JSON.stringify({ pid: result.pid, processLifetime: result.processLifetime }));
process.exit(0);
`;

function pathToFileUrl(p: string): string {
  return "file:///" + p.replace(/\\/g, "/");
}

function processState(pid: number): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "alive" } else { "gone" }`],
    { encoding: "utf8" }
  ).trim();
}

test("windows: launchApp(independent) child survives parent exit", { skip: process.platform !== "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-mcp-lifetime-"));
  const signalPath = path.join(dir, "signal");
  const childScript = path.join(dir, "lifetime-child.cjs");
  const parentScript = path.join(dir, "lifetime-parent.mjs");
  fs.writeFileSync(childScript, CHILD_SOURCE);
  fs.writeFileSync(parentScript, PARENT_SOURCE);

  let childPid = 0;
  let lifetimeReport: unknown = undefined;
  try {
    // 1. Parent launches the child via the REAL launchApp and exits.
    const parent = spawn(
      process.execPath,
      ["--import", "tsx", parentScript, process.execPath, childScript, signalPath],
      { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    let stdout = "";
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.on("data", (c: string) => { stdout += c; });
    const parentExit = await new Promise<number | null>((resolve, reject) => {
      parent.on("error", reject);
      parent.on("close", (code) => resolve(code));
    });
    assert.equal(parentExit, 0, `parent must exit cleanly, code=${parentExit}; stdout=${stdout}`);
    const launched = JSON.parse(stdout.trim()) as { pid: number; processLifetime?: { requested: string; effective: string; isolationMethod?: string; verified: boolean } };
    childPid = launched.pid;
    assert.ok(childPid > 0, `parent must report a pid: ${stdout}`);
    lifetimeReport = launched.processLifetime;
    assert.equal(launched.processLifetime?.requested, "independent");
    // The report is HONEST: verified=true only when isolation was proven;
    // effective=best-effort otherwise (never a fabricated success).
    assert.ok(
      launched.processLifetime?.effective === "independent" || launched.processLifetime?.effective === "best-effort",
      `effective must be independent or best-effort, got ${JSON.stringify(launched.processLifetime)}`
    );
    if (launched.processLifetime?.effective === "independent") {
      assert.equal(launched.processLifetime.verified, true, "independent effective must be verified");
    }

    // 2. The parent has EXITED. The child must still be alive.
    await new Promise((r) => setTimeout(r, 800));
    const aliveAfterParent = processState(childPid);
    assert.equal(aliveAfterParent, "alive", "child must survive the launching parent's exit");
  } finally {
    // 3. Cleanup: signal the child to exit, then force-clean if needed.
    if (childPid > 0) {
      try {
        fs.writeFileSync(signalPath, "1");
      } catch {
        // signal write failed; fall through to force-clean
      }
      const deadline = Date.now() + 10000;
      let gone = false;
      while (Date.now() < deadline) {
        try {
          if (processState(childPid) === "gone") { gone = true; break; }
        } catch {
          gone = true; break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!gone) {
        // Never leave an orphan behind.
        try {
          execFileSync("taskkill.exe", ["/PID", String(childPid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // already gone
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
