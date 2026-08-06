// Static guidance regression tests.
//
// Protects the tool-selection guidance (README + public tool contracts)
// against regressing into fixed global priorities between capture tools
// and structured-state tools:
//   - the README must not claim screenshots are slow / 1-5s / a last
//     resort, nor tell models to substitute other tools for screenshots
//   - public tool descriptions must describe capture tools by their
//     VISUAL role and structured-state tools by their STATE role, with
//     no "prefer state tools over capture" phrasing
//
// Assertions are keyword-based, not full-sentence snapshots, so wording
// tweaks do not make the tests brittle.

import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { contracts } from "../src/contracts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");

// ── README: no stale discouragement ──

const FORBIDDEN_README_PATTERNS: Array<[RegExp, string]> = [
  [/截图很慢/, "README must not claim screenshots are slow"],
  [/1-5\s*秒/, "README must not cite a fixed 1-5 second latency"],
  [/优先(用)?其他工具替代截图/, "README must not direct models to substitute other tools for screenshots"],
  [/只有在真正需要.*?才截图/, "README must not make screenshots a last resort"],
  [/只在真正需要视觉内容时才截图/, "README must not gate screenshots behind a last-resort condition"]
];

for (const [re, message] of FORBIDDEN_README_PATTERNS) {
  test(`README guidance: ${message}`, () => {
    assert.ok(!re.test(readme), `${message}; found match for ${re}`);
  });
}

test("README guidance: captures are described for visual content and complement state tools", () => {
  assert.match(readme, /当任务需要查看视觉内容、检查布局、验证渲染效果、生成图像结果/s);
  assert.match(readme, /或用户明确要求截图时，直接使用 `capture_window`/);
  assert.match(readme, /两类工具互补，不设固定的全局优先级/s);
  assert.match(readme, /当用户明确要求截图、图像或视觉\s*\n\s*验证时，执行截图而不是用状态查询代替/s);
});

// ── public tool contracts ──

test("public tool guidance does not globally discourage screenshot tools", () => {
  for (const name of ["capture_window", "capture_screen_region"]) {
    const desc = contracts[name]!.description;
    assert.ok(!/only as a last resort/i.test(desc), `${name} must not be a last resort`);
    assert.ok(!/prefer (other tools|state checks).*instead of (capture|screenshots)/i.test(desc), `${name} must not direct away from capture`);
    assert.ok(!/screenshots are SLOW/i.test(desc), `${name} must not claim fixed slowness`);
    assert.ok(!/\(1-5s?\)/i.test(desc), `${name} must not cite a fixed latency range`);
  }
});

test("capture tools are described by their visual-content role", () => {
  const capture = contracts.capture_window!.description;
  const region = contracts.capture_screen_region!.description;
  for (const keyword of ["visual", "image"]) {
    assert.match(capture, new RegExp(keyword, "i"), `capture_window should mention ${keyword}`);
    assert.match(region, new RegExp(keyword, "i"), `capture_screen_region should mention ${keyword}`);
  }
  for (const keyword of ["screenshot", "layout", "rendering"]) {
    assert.match(capture, new RegExp(keyword, "i"), `capture_window should mention ${keyword}`);
  }
  // The user's explicit screenshot request must be honored, not replaced.
  assert.match(capture, /user explicitly asks for a screenshot/i);
  assert.match(region, /user explicitly asks for a screenshot/i);
});

test("state tools keep their structured-state descriptions (no reverse bias)", () => {
  // These must stay STATE-role descriptions; the guidance must not push
  // state tools as universal substitutes for visual evidence.
  assert.match(contracts.ui_get!.description, /structured state|state/i);
  assert.match(contracts.ui_query!.description, /SCOPED UI SEARCH/i);
  assert.match(contracts.get_window_state!.description, /minimized|maximized|visibility|foreground/i);
});
