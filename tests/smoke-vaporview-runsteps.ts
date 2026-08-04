// End-to-end test of run_steps against the live VaporView app, in both modes:
//   1. Sequential: launch separately first, then run_steps with the pid/hwnd
//      baked in as literals (no placeholders) - the "manual threading" way.
//   2. Piping: run_steps where step 0 is profile_launch and every later step
//      references ${0.pid} / ${0.hwnd} - the "one call does everything" way.
//
// Workflow per the user's spec: open VaporView -> RTK配置页 -> 检测挂载点 ->
// 测试连接 -> error popup -> OK -> screenshot.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const EXE = "T:\\VaporView\\VaporView.exe";

const RTK = { controlType: "CheckBox", name: "RTK配置" };
const DETECT = { name: "检测挂载点" };
const TEST = { name: "测试连接" };
const OK_WAIT = { controlType: "Button", name: "OK", ancestor: { controlType: "Window", name: "错误" } };
const OK_CLICK = { controlType: "Button", name: "OK", ancestor: { controlType: "Window", name: "错误" }, index: 0 };

type JsonRpcResponse = { id: number; result?: unknown; error?: { message: string } };

function startServer() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"]
  });
  child.stdin?.setDefaultEncoding("utf8");
  return child;
}

function makeClient(child: ReturnType<typeof startServer>) {
  let buffer = "";
  const pending = new Map<number, (res: JsonRpcResponse) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch { /* ignore non-JSON on stdout */ }
    }
  });
  let nextId = 1;
  function call(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout: ${method} id=${id}`)), 60000);
    });
  }
  function notify(method: string, params: unknown) {
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { call, notify };
}

function body(res: JsonRpcResponse): any {
  const text = (res.result as { content?: { text?: string }[] })?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function callTool(client: ReturnType<typeof makeClient>, name: string, args: unknown) {
  const res = await client.call("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name} failed: ${res.error.message}`);
  return body(res);
}

async function closeVaporView(client: ReturnType<typeof makeClient>) {
  const wins = await callTool(client, "list_windows", { processName: "VaporView" });
  for (const w of Array.isArray(wins) ? wins : []) {
    await callTool(client, "close_app", { pid: w.pid }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 600));
}

function logSteps(label: string, result: any) {
  console.error(`\n=== ${label} ===`);
  console.error(`success=${result.success} completed=${result.completed}/${result.total} stoppedAtIndex=${result.stoppedAtIndex}`);
  for (let i = 0; i < result.steps.length; i++) {
    const s = result.steps[i];
    if (s.success) {
      const summary = s.result && typeof s.result === "object"
        ? (s.result.path ? `screenshot -> ${s.result.path}` : (s.result.matched !== undefined ? `matched=${s.result.matched}` : "ok"))
        : "ok";
      console.error(`  [${i}] ${s.tool}: ✓ ${summary}`);
    } else {
      console.error(`  [${i}] ${s.tool}: ✗ ${s.error?.code ?? ""} ${s.error?.message ?? ""}`);
    }
  }
}

async function main() {
  const child = startServer();
  const client = makeClient(child);
  try {
    const init = await client.call("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "smoke-vaporview-runsteps", version: "0.0.0" }
    });
    if (init.error) throw new Error("initialize failed");
    client.notify("notifications/initialized", {});

    // ── 1. Sequential version ──
    // Launch is OUTSIDE run_steps; pid/hwnd are literals in the chain.
    await closeVaporView(client);
    const launched = await callTool(client, "profile_launch", { profile: "vaporview", exePath: EXE });
    const pid: number = launched.pid;
    const hwnd: string = String(launched.hwnd);
    console.error(`[sequential] launched fresh VaporView pid=${pid} hwnd=${hwnd}`);

    const seqRes = await callTool(client, "run_steps", {
      steps: [
        { tool: "ui_action", args: { pid, selector: RTK, action: "invoke" } },
        { tool: "ui_action", args: { pid, selector: DETECT, action: "invoke" } },
        { tool: "ui_action", args: { pid, selector: TEST, action: "invoke" } },
        { tool: "ui_wait", args: { pid, selector: OK_WAIT, condition: "exists", timeoutMs: 10000 } },
        { tool: "ui_action", args: { pid, selector: OK_CLICK, action: "invoke" } },
        { tool: "capture_window", args: { hwnd, focus: false, noActivate: true } }
      ]
    });
    logSteps("SEQUENTIAL (literal pid/hwnd, no placeholders)", seqRes);
    const seqShot = seqRes.steps[seqRes.steps.length - 1]?.result?.path;

    // ── 2. Piping version ──
    // Launch is step 0; every later step references ${0.pid} / ${0.hwnd}.
    await closeVaporView(client);
    const pipeRes = await callTool(client, "run_steps", {
      steps: [
        { tool: "profile_launch", args: { profile: "vaporview", exePath: EXE } },
        { tool: "ui_action", args: { pid: "${0.pid}", selector: RTK, action: "invoke" } },
        { tool: "ui_action", args: { pid: "${0.pid}", selector: DETECT, action: "invoke" } },
        { tool: "ui_action", args: { pid: "${0.pid}", selector: TEST, action: "invoke" } },
        { tool: "ui_wait", args: { pid: "${0.pid}", selector: OK_WAIT, condition: "exists", timeoutMs: 10000 } },
        { tool: "ui_action", args: { pid: "${0.pid}", selector: OK_CLICK, action: "invoke" } },
        { tool: "capture_window", args: { hwnd: "${0.hwnd}", focus: false, noActivate: true } }
      ]
    });
    logSteps("PIPING (${0.pid} / ${0.hwnd} from step 0)", pipeRes);
    const pipeShot = pipeRes.steps[pipeRes.steps.length - 1]?.result?.path;

    assert.equal(seqRes.success, true, "sequential run_steps should fully succeed");
    assert.equal(pipeRes.success, true, "piping run_steps should fully succeed");
    assert.ok(seqShot, "sequential screenshot path missing");
    assert.ok(pipeShot, "piping screenshot path missing");

    console.error("\nsmoke-vaporview-runsteps: PASS");
    console.error(`SEQUENTIAL screenshot: ${seqShot}`);
    console.error(`PIPING      screenshot: ${pipeShot}`);
    // Write paths to a file for the caller to pick up.
    const { writeFileSync } = await import("node:fs");
    writeFileSync("outputs/runsteps-shots.json", JSON.stringify({ sequential: seqShot, piping: pipeShot }, null, 2));
  } finally {
    child.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
