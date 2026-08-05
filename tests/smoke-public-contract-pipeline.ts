// Public-contract pipeline test (contract-driven first-use simulation).
//
// PROVES: a caller who reads ONLY what the MCP server exposes - tools/list
// (with input/output schemas and annotations), tool_contract_describe,
// app_pack_describe, workflow_catalog - can construct a VALID named-step
// pipeline WITHOUT reading server source or importing any implementation
// module. This file deliberately imports nothing from src/ (no contracts.ts,
// no pipeline.ts, no app-packs/*, no tool implementations).
//
// SKIP (exit 77) when the test pack is not loaded.
import assert from "node:assert/strict";

import { startServer, initialize, callTool, listTools, type JsonRpcResponse } from "./mcp-client.js";

const PACK = process.env.SCREENSHOT_MCP_TEST_PACK ?? "notepad";

type ToolFromList = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

async function main() {
  const { child, client } = startServer();
  try {
    await initialize(client);

    // 1. tools/list must expose machine-readable output contracts.
    const res = await client.call("tools/list", {});
    assert.equal(res.error, undefined, "tools/list must not error");
    const tools = ((res.result as { tools?: ToolFromList[] }).tools ?? []).sort((a, b) => a.name.localeCompare(b.name));
    assert.ok(tools.length >= 30, `expected a full tool table, got ${tools.length}`);

    const contractHoles: string[] = [];
    for (const t of tools) {
      if (!t.inputSchema) contractHoles.push(`${t.name}:inputSchema`);
      if (!t.outputSchema) contractHoles.push(`${t.name}:outputSchema`);
      if (!t.annotations) contractHoles.push(`${t.name}:annotations`);
      if (!Array.isArray(t._meta?.pipeSafeFields)) contractHoles.push(`${t.name}:_meta.pipeSafeFields`);
    }
    assert.deepEqual(contractHoles, [], `every tool must expose inputSchema/outputSchema/annotations/pipeSafeFields, missing: ${contractHoles.join(", ")}`);
    console.log(`tools/list: ${tools.length} tools, all with outputSchema + annotations`);

    // 2. Derive the pipeline contract from the PUBLIC schemas only.
    const launch = tools.find((t) => t.name === "profile_launch");
    assert.ok(launch, "profile_launch must exist");
    const launchOutput = launch.outputSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    const pidType = launchOutput.properties?.pid?.type;
    assert.equal(pidType, "integer", "profile_launch outputSchema must declare pid:integer");
    assert.ok(launchOutput.required?.includes("pid"), "pid must be required in profile_launch outputSchema");
    const pipeSafe = (launch._meta?.pipeSafeFields as string[]) ?? [];
    assert.ok(pipeSafe.includes("pid"), "pid must be pipe-safe per _meta");
    console.log(`derived from public contract: profile_launch outputSchema.pid = ${pidType}, pipeSafe=${pipeSafe.join(",")}`);

    // 3. Tool contract describe adds full details (schema + examples).
    const describe = (await callTool(client, "tool_contract_describe", { tool: "profile_launch" })) as {
      name: string; schemaVersion: number; inputSchema: unknown; outputSchema: unknown;
      pipeSafeFields: string[]; examples: Array<{ resultPath: string; type: string }>;
    };
    assert.equal(describe.name, "profile_launch");
    assert.equal(describe.schemaVersion, 1);
    assert.ok(describe.examples.some((e) => e.resultPath === "pid" && e.type === "integer"));
    const listContracts = (await callTool(client, "tool_contract_list", {})) as {
      tools: Array<{ name: string; outputSchema: unknown; pipeSafeFields: string[] }>;
    };
    assert.ok(listContracts.tools.length >= 30);
    console.log("tool_contract_describe/list: PASS");

    // 4. Build a named-step pipeline from the public contracts:
    //    ${app.pid} is legal because pid is a required, pipe-safe output
    //    field of profile_launch; ui_wait declares selector/condition inputs.
    const steps = [
      { id: "app", tool: "profile_launch", args: { profile: PACK }, exports: { pid: "pid", hwnd: "hwnd" } },
      { id: "wait", tool: "ui_wait", args: { pid: "${app.pid}", selector: { controlType: "Window" }, condition: "exists", timeoutMs: 15000 } },
      { id: "state", tool: "get_window_state", args: { hwnd: "${app.hwnd}" }, exports: { visible: "visible" } }
    ];

    // 5. validate_steps accepts the contract-derived pipeline.
    const vs = (await callTool(client, "validate_steps", { pack: PACK, steps })) as {
      valid: boolean; errors: Array<{ code: string; message: string }>;
    };
    if (!vs.valid) {
      console.error("validate_steps rejected the contract-derived pipeline:", JSON.stringify(vs.errors, null, 2));
      process.exit(1);
    }
    console.log("validate_steps: PASS (contract-derived pipeline is valid)");

    // 6. Execute it.
    const run = (await callTool(client, "run_steps", { steps }, 120000)) as {
      success: boolean; exports: Record<string, unknown>; error?: { code?: string; message?: string };
    };
    if (!run.success) {
      console.error("run_steps failed:", JSON.stringify(run.error ?? run));
      process.exit(1);
    }
    assert.equal(typeof run.exports.pid, "number", "pid export from ${app.pid} reference");
    assert.equal(typeof run.exports.visible, "boolean");
    console.log(`run_steps: PASS (pid=${run.exports.pid} visible=${run.exports.visible})`);

    console.log("\nsmoke-public-contract-pipeline: PASS");
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
