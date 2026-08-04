// End-to-end smoke test for run_steps: launches the MCP server over stdio and
// issues real tools/call requests. Verifies the sequential dispatch path, the
// result shape, and stop-on-first-error semantics - without needing a GUI app
// (uses read_clipboard and list_windows, which take no target).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

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
      } catch {
        // Non-JSON lines (shouldn't happen on stdout) - ignore.
      }
    }
  });

  let nextId = 1;
  function call(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method} id=${id}`)), 30000);
    });
  }

  function notify(method: string, params: unknown) {
    child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  return { call, notify };
}

async function main() {
  const child = startServer();
  const client = makeClient(child);

  try {
    // 1. Initialize.
    const init = await client.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-run-steps", version: "0.0.0" }
    });
    assert.equal(init.error, undefined, "initialize should succeed");
    client.notify("notifications/initialized", {});

    // 2. run_steps: all-success path.
    const ok = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "read_clipboard" },
          { tool: "list_windows" },
          { tool: "read_clipboard" }
        ]
      }
    });
    assert.equal(ok.error, undefined, "run_steps call should not error");
    const okText = (ok.result as { content: { type: string; text: string }[] }).content[0]!.text;
    const okBody = JSON.parse(okText) as {
      success: boolean; total: number; completed: number; stoppedAtIndex: number | null;
      steps: { tool: string; success: boolean; result?: unknown; error?: unknown }[];
    };

    assert.equal(okBody.success, true);
    assert.equal(okBody.total, 3);
    assert.equal(okBody.completed, 3);
    assert.equal(okBody.stoppedAtIndex, null);
    assert.equal(okBody.steps.length, 3);
    assert.equal(okBody.steps[0]!.success, true);
    assert.equal(okBody.steps[0]!.tool, "read_clipboard");
    assert.equal(okBody.steps[1]!.success, true);
    assert.equal(okBody.steps[1]!.tool, "list_windows");

    // 3. run_steps: stop-on-first-error path. close_app without a pid fails
    //    argument validation, so the chain should stop at index 1 and step 2
    //    (list_windows) must be skipped.
    const fail = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "read_clipboard" },
          { tool: "close_app", args: {} },
          { tool: "list_windows" }
        ]
      }
    });
    assert.equal(fail.error, undefined, "run_steps itself succeeds even when a step fails");
    const failText = (fail.result as { content: { type: string; text: string }[] }).content[0]!.text;
    const failBody = JSON.parse(failText) as {
      success: boolean; total: number; completed: number; stoppedAtIndex: number | null;
      steps: { tool: string; success: boolean; error?: { code?: string; message: string } }[];
    };

    assert.equal(failBody.success, false);
    assert.equal(failBody.total, 3);
    assert.equal(failBody.completed, 1);
    assert.equal(failBody.stoppedAtIndex, 1);
    assert.equal(failBody.steps.length, 2);
    assert.equal(failBody.steps[0]!.success, true);
    assert.equal(failBody.steps[1]!.success, false);
    assert.equal(failBody.steps[1]!.tool, "close_app");
    assert.ok(failBody.steps[1]!.error!.message.length > 0, "failed step must carry an error message");

    // 4. run_steps: output piping. Write a marker, read it, pipe the read text
    //    into another write (whole-value placeholder, type preserved), then
    //    read it back and confirm the value round-tripped.
    const pipe = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "write_clipboard", args: { text: "piped-marker" } },
          { tool: "read_clipboard" },
          { tool: "write_clipboard", args: { text: "${1.text}" } },
          { tool: "read_clipboard" }
        ]
      }
    });
    assert.equal(pipe.error, undefined, "piping run_steps should succeed");
    const pipeBody = JSON.parse((pipe.result as { content: { text: string }[] }).content[0]!.text) as {
      success: boolean; completed: number;
      steps: { success: boolean; result?: { text?: string } }[];
    };
    assert.equal(pipeBody.success, true);
    assert.equal(pipeBody.completed, 4);
    assert.equal(pipeBody.steps[3]!.result!.text, "piped-marker", "piped text should round-trip");

    // 5. run_steps: embedded placeholder stringifies a number (${1.length}).
    const emb = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "write_clipboard", args: { text: "abc" } },
          { tool: "read_clipboard" },
          { tool: "write_clipboard", args: { text: "len=${1.length}" } },
          { tool: "read_clipboard" }
        ]
      }
    });
    const embBody = JSON.parse((emb.result as { content: { text: string }[] }).content[0]!.text) as {
      steps: { result?: { text?: string } }[];
    };
    assert.equal(embBody.steps[3]!.result!.text, "len=3", "embedded number placeholder should stringify");

    // 6. run_steps: a forward reference (${2...} in step 1) is a structural
    //    error - the whole call fails before any step runs.
    const fwd = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "read_clipboard" },
          { tool: "write_clipboard", args: { text: "${2.text}" } }
        ]
      }
    });
    assert.ok(fwd.error, "forward reference should fail the call with a JSON-RPC error");

    // 7. run_steps: an unresolvable field at runtime fails just that step and
    //    stops the chain (not a whole-call error).
    const unres = await client.call("tools/call", {
      name: "run_steps",
      arguments: {
        steps: [
          { tool: "read_clipboard" },
          { tool: "write_clipboard", args: { text: "${0.nonexistentField}" } },
          { tool: "read_clipboard" }
        ]
      }
    });
    assert.equal(unres.error, undefined, "unresolvable placeholder is a step error, not a call error");
    const unresBody = JSON.parse((unres.result as { content: { text: string }[] }).content[0]!.text) as {
      success: boolean; completed: number; stoppedAtIndex: number | null;
      steps: { success: boolean; error?: { message: string } }[];
    };
    assert.equal(unresBody.success, false);
    assert.equal(unresBody.stoppedAtIndex, 1);
    assert.equal(unresBody.completed, 1);
    assert.equal(unresBody.steps[1]!.success, false);
    assert.match(unresBody.steps[1]!.error!.message, /nonexistentField/);

    console.error("smoke-run-steps: PASS (sequential + piping + stop-on-error verified)");
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
