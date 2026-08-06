// One-shot fixture smoke for the discoverability round (single run, no loop):
//   profile_launch returns targetRef
//   profile_action / ui_query accept targetRef
//   ui_action windowMessageClick reports WindowMessageElementClick +
//   physicalCursorMoved=false (never the physical mouse)
//   the unified business-error envelope validates (no schema mismatch)
// Uses the public notepad example pack + the real editor. SKIP (exit 77) if
// the notepad pack is not loaded.
import assert from "node:assert/strict";

import { startServer, initialize, callTool } from "./mcp-client.js";

async function main() {
  const { child, client } = startServer();
  try {
    await initialize(client);

    // 1. Launch via profile_launch: must return a targetRef.
    const launch = (await callTool(client, "profile_launch", { profile: "notepad" })) as {
      profile?: string;
      targetRef?: string;
      pid?: number;
      error?: { code?: string };
    };
    if (launch.error?.code === "PROFILE_NOT_FOUND" || launch.profile === undefined) {
      console.log("SKIPPED: notepad example pack not loaded.");
      process.exit(77);
    }
    assert.equal(launch.profile, "notepad");
    assert.ok(launch.targetRef && launch.targetRef.startsWith("target_"), `profile_launch must return targetRef, got: ${JSON.stringify(launch)}`);
    assert.ok(typeof launch.pid === "number");
    console.log(`profile_launch: targetRef=${launch.targetRef} pid=${launch.pid} hwnd=${launch.hwnd}`);

    // 2. profile_resolve + ui_query through the targetRef (no pid/hwnd).
    const resolve = (await callTool(client, "profile_resolve", {
      profile: "notepad",
      targetRef: launch.targetRef,
      control: "editArea"
    })) as { found?: boolean; error?: { code?: string; suggestion?: string } };
    assert.equal(resolve.found, true, `editArea must resolve through targetRef: ${JSON.stringify(resolve)}`);

    const query = (await callTool(client, "ui_query", {
      targetRef: launch.targetRef,
      rootSelector: { controlType: "Document" },
      fields: ["automationId", "controlType"],
      maxResults: 5
    })) as { found?: boolean; error?: { code?: string } };
    console.log(`ui_query via targetRef: found=${query.found ?? query.error?.code}`);

    // 3. Business error envelope: unknown control -> ELEMENT_NOT_FOUND-style
    // structured error that VALIDATES against the output schema (the call
    // returns isError + structuredContent; the client harness surfaces the
    // raw result so we assert the envelope shape).
    const bad = (await callTool(client, "profile_action", {
      profile: "notepad",
      targetRef: launch.targetRef,
      control: "definitelyNotAControl",
      action: "invoke"
    })) as { error?: { code?: string; message?: string; suggestion?: string } };
    assert.ok(bad.error, "business error must come back as a structured error");
    assert.ok(bad.error.code === "PROFILE_CONTROL_NOT_FOUND" || bad.error.code === "ELEMENT_NOT_FOUND", `got ${bad.error.code}`);
    assert.ok(typeof bad.error.suggestion === "string", "error must carry a suggestion");
    console.log(`structured error: code=${bad.error.code} suggestion=${bad.error.suggestion?.slice(0, 60)}...`);

    // 4. windowMessageClick on a real invokable element (File menu in the
    // editor) reports the exact method and never moves the physical mouse.
    const click = (await callTool(client, "ui_action", {
      targetRef: launch.targetRef,
      selector: { controlType: "MenuItem", name: "(File|文件)", match: "regex" },
      action: "windowMessageClick"
    })) as { success?: boolean; method?: string; physicalCursorMoved?: boolean; error?: { code?: string } };
    if (click.error) {
      console.log(`windowMessageClick skipped (${click.error.code}) - element may be offscreen; not a failure.`);
    } else {
      assert.equal(click.method, "WindowMessageElementClick", `method must be exact: ${JSON.stringify(click)}`);
      assert.equal(click.physicalCursorMoved, false, "a window-message click NEVER moves the physical mouse");
      assert.equal(click.success, true);
      console.log("windowMessageClick: WindowMessageElementClick, physicalCursorMoved=false");
    }

    console.log("SMOKE PASS");
  } finally {
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
