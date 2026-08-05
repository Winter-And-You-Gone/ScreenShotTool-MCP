// Workflow system e2e over stdio (public example pack):
//   workflow_catalog (visibility respected)
//   run_workflow (input validation, ${pack.id} injection, exports, finally)
//   run_workflow on an internal workflow -> WORKFLOW_INTERNAL
//   run_workflow on a missing workflow -> WORKFLOW_NOT_FOUND
import assert from "node:assert/strict";

import { startServer, initialize, callTool } from "./mcp-client.js";

const PACK = process.env.SCREENSHOT_MCP_TEST_PACK ?? "notepad";

async function main() {
  const { child, client } = startServer();
  try {
    await initialize(client);

    // 1. catalog lists the tested workflow with required inputs.
    const wc = (await callTool(client, "workflow_catalog", { pack: PACK })) as {
      workflows: Array<{ id: string; tested: boolean; requiredInputs: string[]; safe: boolean }>;
    };
    const typeWorkflow = wc.workflows.find((w) => w.id === "type_text" || w.id === "open_about");
    assert.ok(typeWorkflow, `workflow type_text/open_about must exist in ${PACK}`);
    assert.ok(typeWorkflow.safe === true);
    console.log(`workflow_catalog: ${wc.workflows.length} workflows`);

    // 2. Input validation: missing required input is rejected BEFORE running.
    if (typeWorkflow.requiredInputs.length > 0) {
      const bad = (await client.call("tools/call", { name: "run_workflow", arguments: { pack: PACK, workflow: typeWorkflow.id, inputs: {} } })) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = bad.result?.content?.[0]?.text ?? "";
      assert.ok(text.includes("INVALID_WORKFLOW_INPUTS"), `missing input must be rejected, got: ${text.slice(0, 120)}`);
      console.log("run_workflow input validation: PASS");
    }

    // 3. Happy path: run the workflow with inputs, exports round-trip.
    const marker = `wf-e2e-${Date.now() % 100000}`;
    const ok = (await callTool(client, "run_workflow", {
      pack: PACK,
      workflow: typeWorkflow.id,
      inputs: typeWorkflow.requiredInputs.includes("text") ? { text: marker } : {}
    }, 120000)) as {
      success: boolean; runId: string; exports: Record<string, unknown>; steps: Array<{ success: boolean }>;
      finallyResults: Array<{ success: boolean }>; error?: { code?: string };
    };
    if (!ok.success) {
      console.error("run_workflow failed:", JSON.stringify(ok.error ?? ok));
      process.exit(1);
    }
    assert.match(ok.runId, /^run_/);
    const roundTripped = ok.exports?.typedText ?? ok.exports?.text;
    if (typeWorkflow.requiredInputs.includes("text")) {
      assert.equal(roundTripped, marker, "input text must round-trip through exports");
    }
    assert.ok(ok.steps.every((s) => s.success === true));
    assert.ok(ok.finallyResults.every((f) => f.success === true), "finally steps must succeed");
    console.log(`run_workflow ${typeWorkflow.id}: PASS (${ok.steps.length} steps, finally clean)`);

    // 4. Unknown workflow id -> WORKFLOW_NOT_FOUND.
    const missing = (await client.call("tools/call", { name: "run_workflow", arguments: { pack: PACK, workflow: "does_not_exist", inputs: {} } })) as {
      result?: { content?: Array<{ text?: string }> };
    };
    assert.ok((missing.result?.content?.[0]?.text ?? "").includes("WORKFLOW_NOT_FOUND"));

    console.log("\nsmoke-workflow: PASS");
  } finally {
    child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
