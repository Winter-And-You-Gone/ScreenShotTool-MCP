// Minimal MCP stdio client shared by smoke tests. Spawns the server and
// provides call()/notify() with JSON-RPC framing.

import { spawn, type ChildProcess } from "node:child_process";

export type JsonRpcResponse = { id: number; result?: unknown; error?: { code?: number; message: string } };

export type McpClient = {
  call: (method: string, params: unknown, timeoutMs?: number) => Promise<JsonRpcResponse>;
  notify: (method: string, params: unknown) => void;
  kill: () => void;
};

export function startServer(extraArgs: string[] = []): { child: ChildProcess; client: McpClient } {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...extraArgs], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"]
  });
  child.stdin?.setDefaultEncoding("utf8");

  let buffer = "";
  const pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; timer: NodeJS.Timeout }>();

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
          const entry = pending.get(msg.id)!;
          clearTimeout(entry.timer);
          pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch {
        // Non-JSON line on stdout - ignore.
      }
    }
  });

  let nextId = 1;
  const client: McpClient = {
    call(method: string, params: unknown, timeoutMs = 60000): Promise<JsonRpcResponse> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method} id=${id}`));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method: string, params: unknown) {
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    kill() {
      child.kill();
    }
  };

  return { child, client };
}

export async function initialize(client: McpClient): Promise<void> {
  const init = await client.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" }
  });
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  client.notify("notifications/initialized", {});
}

export function body(res: JsonRpcResponse): unknown {
  if (res.error) throw new Error(`RPC error: ${res.error.message}`);
  const content = (res.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const text = content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

export async function callTool(client: McpClient, name: string, args: unknown, timeoutMs?: number): Promise<unknown> {
  const res = await client.call("tools/call", { name, arguments: args }, timeoutMs);
  return body(res);
}

export async function listTools(client: McpClient): Promise<string[]> {
  const res = await client.call("tools/list", {});
  if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
  const tools = (res.result as { tools?: Array<{ name: string }> }).tools ?? [];
  return tools.map((t) => t.name);
}
