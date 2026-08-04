// Piping-only demo: one run_steps call does the whole VaporView workflow.
// launch is step 0; every later step references ${0.pid} / ${0.hwnd}.
import { spawn } from "node:child_process";

const EXE = "T:\\VaporView\\VaporView.exe";
const RTK = { controlType: "CheckBox", name: "RTK配置" };
const DETECT = { name: "检测挂载点" };
const TEST = { name: "测试连接" };
const OK_WAIT = { controlType: "Button", name: "OK", ancestor: { controlType: "Window", name: "错误" } };
const OK_CLICK = { ...OK_WAIT, index: 0 };

type Res = { id: number; result?: unknown; error?: { message: string } };

const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
  cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"]
});
child.stdin?.setDefaultEncoding("utf8");

let buf = "";
const pending = new Map<number, (r: Res) => void>();
child.stdout!.on("data", (c: Buffer) => {
  buf += c.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line) as Res;
      if (typeof m.id === "number" && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    } catch { /* ignore */ }
  }
});
let id = 1;
function call(method: string, params: unknown): Promise<Res> {
  const myId = id++;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
  });
}
function notify(method: string, params: unknown) {
  child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
async function tool(name: string, args: unknown): Promise<any> {
  const r = await call("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return JSON.parse((r.result as { content: { text: string }[] }).content[0]!.text);
}

async function main() {
  const init = await call("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "piping-demo", version: "0.0.0" }
  });
  if (init.error) throw new Error("init failed");
  notify("notifications/initialized", {});

  // Close any running VaporView so the launch in step 0 starts fresh.
  const wins = await tool("list_windows", { processName: "VaporView" });
  for (const w of Array.isArray(wins) ? wins : []) {
    await tool("close_app", { pid: w.pid }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 600));

  console.error("\n>>> single run_steps call (piping) — 7 steps, launch is step 0\n");
  const t0 = Date.now();
  const res = await tool("run_steps", {
    steps: [
      { tool: "profile_launch",       args: { profile: "vaporview", exePath: EXE } },
      { tool: "ui_action",            args: { pid: "${0.pid}", selector: RTK, action: "invoke" } },
      { tool: "ui_action",            args: { pid: "${0.pid}", selector: DETECT, action: "invoke" } },
      { tool: "ui_action",            args: { pid: "${0.pid}", selector: TEST, action: "invoke" } },
      { tool: "ui_wait",              args: { pid: "${0.pid}", selector: OK_WAIT, condition: "exists", timeoutMs: 10000 } },
      { tool: "ui_action",            args: { pid: "${0.pid}", selector: OK_CLICK, action: "invoke" } },
      { tool: "capture_window",       args: { hwnd: "${0.hwnd}", focus: false, noActivate: true } }
    ]
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.error(`success=${res.success}  completed=${res.completed}/${res.total}  stoppedAtIndex=${res.stoppedAtIndex}  (${elapsed}s total)`);
  for (let i = 0; i < res.steps.length; i++) {
    const s = res.steps[i];
    const pipe = i > 0 ? "pid=${0.pid}" + (s.tool === "capture_window" ? " -> hwnd=${0.hwnd}" : "") : "launch → produces pid/hwnd";
    if (s.success) {
      let extra = "";
      if (s.result?.pid) extra = `pid=${s.result.pid} hwnd=${s.result.hwnd}`;
      else if (s.result?.matched !== undefined) extra = `matched=${s.result.matched}`;
      else if (s.result?.path) extra = `screenshot: ${s.result.path}`;
      console.error(`  [${i}] ${s.tool.padEnd(16)} ${pipe.padEnd(28)} ✓ ${extra}`);
    } else {
      console.error(`  [${i}] ${s.tool.padEnd(16)} ${pipe.padEnd(28)} ✗ ${s.error?.message ?? ""}`);
    }
  }
  const shot = res.steps[res.steps.length - 1]?.result?.path;
  if (shot) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("outputs/piping-demo-shot.txt", shot);
    console.error(`\nscreenshot: ${shot}`);
  }
  child.kill();
}
main().catch((e) => { console.error(e); child.kill(); process.exit(1); });
