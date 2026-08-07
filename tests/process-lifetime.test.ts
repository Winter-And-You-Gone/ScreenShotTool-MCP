// Process lifetime semantics: launch_app/profile_launch defaults, explicit
// managed, the processLifetime metadata shape, and honest reporting when
// independent isolation cannot be proven (never a fake `verified`).
//
// The REAL Win32 breakaway integration (parent exits -> child survives) is
// covered by the conditional integration test in target-lifecycle.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

import { launchAppSchema, profileLaunchSchema, toolZodSchemas, toolInputSchemas } from "../src/schemas.js";
import type { ProcessLifetimeReport } from "../src/windows.js";

test("launch_app defaults lifetime=independent", () => {
  const parsed = launchAppSchema.parse({ exePath: "C:\\app.exe" });
  assert.equal(parsed.lifetime, "independent");
  const json = toolInputSchemas.launch_app.properties.lifetime as { default?: string };
  assert.equal(json.default, "independent");
});

test("profile_launch defaults lifetime=independent (desktop apps must survive the server)", () => {
  const parsed = profileLaunchSchema.parse({ profile: "fixture" });
  assert.equal(parsed.lifetime, "independent");
  const json = toolInputSchemas.profile_launch.properties.lifetime as { default?: string };
  assert.equal(json.default, "independent");
});

test("launch_app accepts explicit managed", () => {
  const parsed = launchAppSchema.parse({ exePath: "C:\\app.exe", lifetime: "managed" });
  assert.equal(parsed.lifetime, "managed");
  const json = toolInputSchemas.launch_app.properties.lifetime as { enum?: string[] };
  assert.deepEqual(json.enum, ["independent", "managed"]);
});

test("profile_launch accepts explicit managed", () => {
  const parsed = profileLaunchSchema.parse({ profile: "fixture", lifetime: "managed" });
  assert.equal(parsed.lifetime, "managed");
});

test("lifetime values are validated (unknown value rejected)", () => {
  const r = launchAppSchema.safeParse({ exePath: "C:\\app.exe", lifetime: "detached" });
  assert.equal(r.success, false);
});

test("toolZodSchemas expose the lifetime param on launch tools", () => {
  assert.ok(toolZodSchemas.launch_app);
  assert.ok(toolZodSchemas.profile_launch);
  const parsed = toolZodSchemas.launch_app!.parse({ exePath: "C:\\app.exe" });
  assert.equal((parsed as { lifetime?: string }).lifetime, "independent");
});

test("processLifetime report shape: verified independent (breakaway)", () => {
  const report: ProcessLifetimeReport = {
    requested: "independent",
    effective: "independent",
    isolationMethod: "windows-breakaway",
    verified: true,
    verificationScope: "job-breakaway",
    outerJobCoupling: "none-observed"
  };
  assert.equal(report.verified, true);
  assert.equal(report.effective, "independent");
  assert.equal(report.isolationMethod, "windows-breakaway");
  assert.equal(report.verificationScope, "job-breakaway");
  assert.equal(report.outerJobCoupling, "none-observed");
});

test("processLifetime report shape: detached-spawn verification is scoped to mcp-server-process-exit", () => {
  const report: ProcessLifetimeReport = {
    requested: "independent",
    effective: "independent",
    isolationMethod: "detached-spawn",
    verified: true,
    // verified=true MUST NOT imply full escape from every outer host job.
    verificationScope: "mcp-server-process-exit",
    outerJobCoupling: "possible"
  };
  assert.equal(report.verified, true);
  assert.equal(report.verificationScope, "mcp-server-process-exit");
  assert.equal(report.outerJobCoupling, "possible");
  // The semantic contract: this is NOT a claim of full job isolation.
  assert.notEqual(report.verificationScope, "job-breakaway");
  assert.notEqual(report.outerJobCoupling, "none-observed");
});

test("processLifetime report shape: best-effort is honest (verified=false, scope none)", () => {
  const report: ProcessLifetimeReport = {
    requested: "independent",
    effective: "best-effort",
    isolationMethod: "detached-spawn",
    verified: false,
    verificationScope: "none",
    outerJobCoupling: "unknown"
  };
  assert.equal(report.verified, false, "never claim verified isolation that was not proven");
  assert.equal(report.effective, "best-effort");
  assert.equal(report.verificationScope, "none");
  assert.equal(report.outerJobCoupling, "unknown");
});

test("processLifetime report shape: managed is explicit and carries no independence verification", () => {
  const report: ProcessLifetimeReport = {
    requested: "managed",
    effective: "managed",
    isolationMethod: "spawn-managed",
    verified: true,
    verificationScope: "none",
    outerJobCoupling: "unknown"
  };
  assert.equal(report.requested, "managed");
  assert.equal(report.effective, "managed");
  // A managed process is deliberately tied to the server lifetime - it must
  // never claim an independence verification scope.
  assert.notEqual(report.verificationScope, "job-breakaway");
  assert.notEqual(report.verificationScope, "mcp-server-process-exit");
});

test("profile_launch outputSchema accepts the processLifetime report", async () => {
  const { contracts } = await import("../src/contracts.js");
  const { validateAgainstSchema } = await import("../src/outputs.js");
  const result = {
    profile: "fixture",
    targetRef: "target_fixture_4242",
    pid: 4242,
    startedByMcp: true,
    reused: false,
    uiaRootAvailable: true,
    interaction: {
      requestedMode: "background",
      effectiveMode: "background",
      foregroundChanged: false,
      targetActivated: false,
      physicalCursorMoved: false
    },
    lifetime: "independent",
    processLifetime: {
      requested: "independent",
      effective: "best-effort",
      isolationMethod: "detached-spawn",
      verified: false,
      verificationScope: "none",
      outerJobCoupling: "unknown"
    }
  };
  const check = validateAgainstSchema(result, contracts.profile_launch!.outputSchema);
  assert.ok(check.ok, `profile_launch result with processLifetime must validate: ${check.ok ? "" : check.reason}`);
});

test("launch_app outputSchema accepts the processLifetime report", async () => {
  const { contracts } = await import("../src/contracts.js");
  const { validateAgainstSchema } = await import("../src/outputs.js");
  const result = {
    pid: 1234,
    window: null,
    processLifetime: {
      requested: "independent",
      effective: "independent",
      isolationMethod: "detached-spawn",
      verified: true,
      verificationScope: "mcp-server-process-exit",
      outerJobCoupling: "possible"
    }
  };
  const check = validateAgainstSchema(result, contracts.launch_app!.outputSchema);
  assert.ok(check.ok, `launch_app result with processLifetime must validate: ${check.ok ? "" : check.reason}`);
});
