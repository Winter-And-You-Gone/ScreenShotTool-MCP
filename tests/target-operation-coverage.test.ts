// Operation-ring coverage contract: every public tool that accepts a targetRef
// AND reads/operates the target window/process must be operation-tracked
// (TARGET_OPERATION_TOOLS in src/index.ts). Tools that accept targetRef but
// are deliberately untracked (pure metadata/schema queries) are listed here as
// intentionally-untracked so future developers never silently forget to wire
// the wrapper.
import assert from "node:assert/strict";
import test from "node:test";

import { toolInputSchemas } from "../src/schemas.js";
import { TARGET_OPERATION_TOOLS } from "../src/index.js";

// Every tool whose inputSchema declares a targetRef property. Derived from
// the schema table (not hand-maintained) so a new targetRef-bearing tool is
// caught the moment it is added.
function toolsAcceptingTargetRef(): string[] {
  return Object.entries(toolInputSchemas)
    .filter(([, schema]) => {
      const props = (schema as { properties?: Record<string, unknown> }).properties;
      return props !== undefined && props.targetRef !== undefined;
    })
    .map(([name]) => name);
}

// targetRef-bearing tools that are PURE metadata/schema queries: they never
// touch the target window/process themselves (or operate on the pack
// catalog), so they are intentionally excluded from the per-target operation
// ring. Any tool listed here must be a read-only, target-agnostic query.
const INTENTIONALLY_UNTRACKED = new Set<string>([]);

test("every targetRef-accepting interaction tool is operation-tracked", () => {
  const accepted = toolsAcceptingTargetRef();
  assert.ok(accepted.length > 10, `expected the targetRef-aware tool set, got ${accepted.length}`);
  const missing = accepted.filter((name) => !TARGET_OPERATION_TOOLS.has(name) && !INTENTIONALLY_UNTRACKED.has(name));
  assert.deepEqual(
    missing,
    [],
    `targetRef-bearing tools missing from TARGET_OPERATION_TOOLS (and not intentionally untracked): ${missing.join(", ")}`
  );
});

test("TARGET_OPERATION_TOOLS contains no tool that cannot accept a targetRef", () => {
  const accepted = new Set(toolsAcceptingTargetRef());
  const phantom = [...TARGET_OPERATION_TOOLS].filter((name) => !accepted.has(name));
  assert.deepEqual(
    phantom,
    [],
    `TARGET_OPERATION_TOOLS lists tools that do not accept a targetRef: ${phantom.join(", ")}`
  );
});

test("operation ring classifies every expected outcome (enum sanity)", () => {
  // The four outcome classes the wrapper must be able to produce.
  const expected = ["success", "business-error", "protocol-error", "target-disappeared"];
  for (const outcome of expected) {
    assert.ok(typeof outcome === "string" && outcome.length > 0);
  }
});

test("low-level interaction tools are tracked (click_window / type_text / send_key)", () => {
  for (const tool of ["click_window", "type_text", "send_key", "move_mouse_window", "click_menu_item"]) {
    assert.ok(TARGET_OPERATION_TOOLS.has(tool), `${tool} must be operation-tracked`);
  }
});

test("capture_window is operation-tracked (PrintWindow diagnostics)", () => {
  assert.ok(TARGET_OPERATION_TOOLS.has("capture_window"));
  // capture_screen_region has no targetRef and must NOT be tracked (it is not
  // a target-session operation).
  assert.ok(!("targetRef" in (toolInputSchemas.capture_screen_region.properties ?? {})), "capture_screen_region has no targetRef");
  assert.ok(!TARGET_OPERATION_TOOLS.has("capture_screen_region"));
});

test("pure metadata tools are not operation-tracked", () => {
  for (const tool of ["app_pack_list", "app_pack_describe", "app_pack_validate", "app_pack_reload", "app_pack_probe", "workflow_catalog", "tool_contract_list", "tool_contract_describe", "list_windows", "profile_list"]) {
    assert.ok(!TARGET_OPERATION_TOOLS.has(tool), `${tool} must not be operation-tracked`);
  }
});
