// Unit tests for the benchmark statistics function (computeBenchmarkStats):
//   - continueRecoverySuccessRate = success / ACTUAL continue attempts
//   - null when no continue was attempted (never 0)
//   - continue successes never affect first-attempt counts
//   - infrastructure failures counted separately
import assert from "node:assert/strict";
import test from "node:test";

import { computeBenchmarkStats, type BenchmarkReport } from "./smoke-first-use-pipeline.js";

type IterationStats = {
  workflowFirstAttempt: boolean;
  workflowEventually: boolean;
  continueRecoverySuccesses: number;
  continueAttempts: number;
  pipelineFirstAttempt: boolean;
  pipelineEventually: boolean;
  validationRejected: boolean;
  cleanup: boolean;
  infrastructureFailure: boolean;
  toolCalls: number;
  pipelineSteps: number;
};

function iter(overrides: Partial<IterationStats> = {}): IterationStats {
  return {
    workflowFirstAttempt: true,
    workflowEventually: true,
    continueRecoverySuccesses: 0,
    continueAttempts: 0,
    pipelineFirstAttempt: true,
    pipelineEventually: true,
    validationRejected: false,
    cleanup: true,
    infrastructureFailure: false,
    toolCalls: 8,
    pipelineSteps: 6,
    ...overrides
  };
}

test("20 iterations, 0 continues -> continueRecoverySuccessRate is null (not 0)", () => {
  const all = Array.from({ length: 20 }, () => iter());
  const report = computeBenchmarkStats(all);
  assert.equal(report.iterations, 20);
  assert.equal(report.continueAttempts, 0);
  assert.equal(report.continueRecoverySuccessCount, 0);
  assert.equal(report.continueRecoverySuccessRate, null);
});

test("20 iterations, 2 continues, 2 successes -> rate 1.0", () => {
  const all = [
    iter({ continueAttempts: 1, continueRecoverySuccesses: 1 }),
    iter({ continueAttempts: 1, continueRecoverySuccesses: 1 }),
    ...Array.from({ length: 18 }, () => iter())
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.continueAttempts, 2);
  assert.equal(report.continueRecoverySuccessCount, 2);
  assert.equal(report.continueRecoverySuccessRate, 1);
});

test("20 iterations, 4 continues, 1 success -> rate 0.25", () => {
  const all = [
    iter({ continueAttempts: 1, continueRecoverySuccesses: 1 }),
    iter({ continueAttempts: 1 }),
    iter({ continueAttempts: 1 }),
    iter({ continueAttempts: 1 }),
    ...Array.from({ length: 16 }, () => iter())
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.continueAttempts, 4);
  assert.equal(report.continueRecoverySuccessCount, 1);
  assert.equal(report.continueRecoverySuccessRate, 0.25);
});

test("a continue success never changes the first-attempt count", () => {
  const all = [
    // First attempt FAILED; continue succeeded. firstAttempt must stay false.
    iter({ workflowFirstAttempt: false, workflowEventually: true, continueAttempts: 1, continueRecoverySuccesses: 1 }),
    iter(),
    iter()
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.workflowFirstAttemptSuccessCount, 2);
  assert.equal(report.workflowEventuallySuccessCount, 3);
  assert.equal(report.continueRecoverySuccessCount, 1);
});

test("failed continues still count as attempts", () => {
  const all = [
    iter({ continueAttempts: 1 }), // continue ran, failed
    iter({ continueAttempts: 1 }), // continue ran, failed
    iter({ continueAttempts: 1, continueRecoverySuccesses: 1 }) // continue ran, succeeded
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.continueAttempts, 3);
  assert.equal(report.continueRecoverySuccessCount, 1);
  assert.equal(report.continueRecoverySuccessRate, +(1 / 3).toFixed(3));
});

test("infrastructure failures are counted separately, not as workflow failures", () => {
  const all = [
    iter({ infrastructureFailure: true, workflowFirstAttempt: false, workflowEventually: false, pipelineFirstAttempt: false, pipelineEventually: false }),
    ...Array.from({ length: 19 }, () => iter())
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.infrastructureFailureCount, 1);
  // The failing iteration still shows in the rates (the report exposes the
  // count separately so consumers can exclude it explicitly).
  assert.equal(report.workflowFirstAttemptSuccessCount, 19);
});

test("cleanupSuccessCount is counted independently", () => {
  const all = [
    iter({ cleanup: false }),
    iter({ cleanup: false }),
    ...Array.from({ length: 18 }, () => iter())
  ];
  const report = computeBenchmarkStats(all);
  assert.equal(report.cleanupSuccessCount, 18);
  assert.equal(report.cleanupSuccessRate, 0.9);
});

test("report shape stays stable (README documents these fields)", () => {
  const report: BenchmarkReport = computeBenchmarkStats([iter()]);
  const keys = Object.keys(report);
  for (const expected of [
    "iterations", "workflowFirstAttemptSuccessCount", "workflowFirstAttemptSuccessRate",
    "workflowEventuallySuccessCount", "workflowEventuallySuccessRate",
    "pipelineFirstAttemptSuccessCount", "pipelineFirstAttemptSuccessRate",
    "pipelineEventuallySuccessCount", "pipelineEventuallySuccessRate",
    "continueAttempts", "continueRecoverySuccessCount", "continueRecoverySuccessRate",
    "cleanupSuccessCount", "cleanupSuccessRate", "validationFailureRate",
    "infrastructureFailureCount", "averageToolCalls", "averagePipelineSteps"
  ]) {
    assert.ok(keys.includes(expected), `missing report field: ${expected}`);
  }
});

test("counts multiple successful continues in ONE iteration (boundary)", () => {
  // A single iteration may run continue_run twice (workflow recovery AND
  // pipeline recovery). Each successful call counts individually - the old
  // boolean could only record one success per iteration.
  const report = computeBenchmarkStats([
    iter({ continueAttempts: 2, continueRecoverySuccesses: 2 })
  ]);
  assert.equal(report.continueAttempts, 2);
  assert.equal(report.continueRecoverySuccessCount, 2);
  assert.equal(report.continueRecoverySuccessRate, 1);
});

test("2 attempts, 1 success -> rate 0.5", () => {
  const report = computeBenchmarkStats([
    iter({ continueAttempts: 2, continueRecoverySuccesses: 1 })
  ]);
  assert.equal(report.continueRecoverySuccessCount, 1);
  assert.equal(report.continueRecoverySuccessRate, 0.5);
});

test("2 attempts, 0 successes -> rate 0 (attempts happened)", () => {
  const report = computeBenchmarkStats([
    iter({ continueAttempts: 2, continueRecoverySuccesses: 0 })
  ]);
  assert.equal(report.continueRecoverySuccessCount, 0);
  assert.equal(report.continueRecoverySuccessRate, 0);
});
