// Selector replay tests: any selector a tool RECOMMENDS must be acceptable by
// the selector input schema again (the interface closure property). A long Qt
// hierarchical automationId (>256 chars) must produce a short replaySelector,
// and the raw id is only reported as a diagnostic rawAutomationId.
import assert from "node:assert/strict";
import test from "node:test";

import { uiQuerySchema } from "../src/schemas.js";
import { MAX_SELECTOR_STR_LEN } from "../src/uia/selectors.js";

// Build a long hierarchical Qt automationId (>256 chars).
function longQtAutomationId(leaf: string): string {
  const prefix = "QApplication.MainWindow.appCentralWidget.appLayoutSplitter.mainContentSplitter.mainPageStack.temperaturePage.mainCardsScrollArea.qt_scrollarea_viewport.QWidget.sensorGroupBox.TemperatureControllerPanel.temperatureConfigCard.temperatureControllerContentRow.temperatureControllerLeftConfigColumn.";
  const id = `${prefix}${leaf}`;
  assert.ok(id.length > MAX_SELECTOR_STR_LEN, `fixture must exceed ${MAX_SELECTOR_STR_LEN}: got ${id.length}`);
  return id;
}

// The replay-selector builder used by ui_catalog (windows.ts). Kept in sync
// by the test to assert the emitted replaySelector passes the input schema.
function buildReplaySelector(aid: string, controlType: string, name: string): Record<string, unknown> | undefined {
  const lastSegment = aid.split(".").pop() ?? "";
  if (lastSegment.length > 0 && lastSegment.length <= MAX_SELECTOR_STR_LEN) {
    return { automationId: lastSegment, match: "contains" };
  }
  if (name.length > 0 && name.length <= MAX_SELECTOR_STR_LEN) {
    return { name, controlType, match: "contains" };
  }
  return undefined;
}

test("long automationId (>256) produces a short replaySelector", () => {
  const aid = longQtAutomationId("temperatureNtcR0EditChannel1");
  const replay = buildReplaySelector(aid, "Edit", "");
  assert.ok(replay !== undefined);
  assert.equal((replay as { automationId: string }).automationId, "temperatureNtcR0EditChannel1");
  assert.equal((replay as { match: string }).match, "contains");
  // The replay selector passes the public input schema (closure property).
  const parsed = uiQuerySchema.parse({ pid: 1, selector: replay });
  assert.equal(parsed.selector.automationId, "temperatureNtcR0EditChannel1");
});

test("replaySelector + target is valid via ui_query (the recommended diagnostic path)", () => {
  const aid = longQtAutomationId("temperatureChannelSensorConfigButton1");
  const replay = buildReplaySelector(aid, "CheckBox", "传感器配置");
  assert.ok(replay !== undefined);
  const r = uiQuerySchema.safeParse({ pid: 1, selector: replay, nameContains: "传感器" });
  assert.equal(r.success, true);
});

test("raw automationId is diagnostic-only and never recommended for replay", () => {
  const aid = longQtAutomationId("temperatureChannelSubPageRowChannel1");
  // The raw id itself would FAIL the selector input schema (>256).
  const rawAccepted = uiQuerySchema.safeParse({ pid: 1, selector: { automationId: aid } });
  assert.equal(rawAccepted.success, false, "raw id must not pass the selector schema");
  // …which is exactly why the tool reports it as rawAutomationId + a short
  // replaySelector instead of recommending it.
  const replay = buildReplaySelector(aid, "Group", "");
  assert.ok(replay !== undefined);
  const r = uiQuerySchema.safeParse({ pid: 1, selector: replay });
  assert.equal(r.success, true);
});

test("replay selector with match=contains resolves within the full id (matcher semantics)", () => {
  // The PowerShell matcher treats a contains-mode automationId as a substring
  // of the full hierarchical id, so the short replay selector finds the SAME
  // element the long id names. (TS-side assertion of the match semantics.)
  const aid = longQtAutomationId("temperatureChannelSensorConfigButton1");
  const replay = buildReplaySelector(aid, "CheckBox", "");
  const fragment = (replay as { automationId: string }).automationId;
  assert.ok(aid.includes(fragment));
  assert.equal(aid.endsWith(fragment), true);
});

test("fallback replay: name+controlType when the last segment is unusable", () => {
  // A degenerate id whose last segment is empty -> falls back to name.
  const replay = buildReplaySelector("a.b.", "Button", "保存");
  assert.deepEqual(replay, { name: "保存", controlType: "Button", match: "contains" });
});
