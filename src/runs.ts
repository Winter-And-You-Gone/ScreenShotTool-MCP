// Run store for runId / continue_run.
//
// Pipeline executions (run_steps, profile_run_steps, run_workflow) register a
// run snapshot here so a failed pipeline can be continued with continue_run.
// Snapshots are in-memory only, expire after RUN_TTL_MS, and are capped in
// number and size.
//
// CONTINUABILITY: a snapshot is only continuable when it keeps, for every
// completed step, a minimal pipeProjection (the fields later steps actually
// reference, the step's own exports, and the contract's pipe-safe fields)
// plus the process/window state. When the budget cannot hold even that, the
// snapshot is marked continuable=false with a continuationReason - it is
// NEVER presented as resumable with silently dropped state.

import { randomUUID } from "node:crypto";

export const RUN_TTL_MS = 10 * 60 * 1000;
export const MAX_RUNS = 20;
export const MAX_RUN_RESULT_BYTES = 2 * 1024 * 1024;
// Per-step projection budget: enough for pid/hwnd/title + a bounded tree
// projection, far below the raw result cap.
export const MAX_STEP_PROJECTION_BYTES = 256 * 1024;

export type ContinuationReason = "RUN_SNAPSHOT_TRUNCATED" | null;

// Minimal per-step continuation record.
export type StepSnapshot = {
  id?: string;
  index: number;
  tool: string;
  // ONLY the fields later steps reference + pipe-safe fields + this step's
  // exports. Never the full raw result.
  pipeProjection: unknown;
  exports: Record<string, unknown>;
  success: boolean;
  error?: unknown;
};

export type RunSnapshot = {
  runId: string;
  kind: "run_steps" | "profile_run_steps" | "run_workflow";
  createdAtMs: number;
  expiresAtMs: number;
  // Original (unresolved) pipeline input, for re-execution.
  input: unknown;
  // Pack identity when the run came from a pack (workflow / profile steps).
  packId?: string;
  packVersion?: string;
  // Resolved window/process context discovered so far.
  pid?: number;
  hwnd?: string;
  title?: string;
  profile?: string;
  // Per-step minimal snapshots (completed steps only).
  steps: StepSnapshot[];
  // All exported values (merged, bounded).
  exports: Record<string, unknown>;
  stoppedAtStep: number;
  error?: unknown;
  // Workflow inputs (for input-dependent re-execution).
  inputs?: Record<string, unknown>;
  maxSteps: number;
  totalTimeoutMs: number;
  // Continuability: false when the snapshot had to be truncated beyond what
  // can honestly be resumed.
  continuable: boolean;
  continuationReason: ContinuationReason;
};

type RunStoreEntry = {
  snapshot: RunSnapshot;
  bytes: number;
};

const store = new Map<string, RunStoreEntry>();

function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createRunId(): string {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// Save a snapshot. When it exceeds the budget:
//   1. exports are kept, projections are kept (they are already minimal);
//   2. if the minimal snapshot itself exceeds the budget, the run is marked
//      NOT continuable (continuable=false, RUN_SNAPSHOT_TRUNCATED) - exports
//      and metadata are still preserved for reporting, but continue_run will
//      refuse it.
// Returns the saved (possibly re-flagged) snapshot.
export function saveRun(snapshot: RunSnapshot): RunSnapshot {
  pruneExpired();
  if (store.size >= MAX_RUNS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].snapshot.createdAtMs - b[1].snapshot.createdAtMs)[0];
    if (oldest) store.delete(oldest[0]);
  }

  const snapshotWithFlag = finalizeContinuability(snapshot);
  const bytes = estimateBytes(snapshotWithFlag);
  store.set(snapshotWithFlag.runId, { snapshot: snapshotWithFlag, bytes });
  return snapshotWithFlag;
}

// Decide continuability from the actual stored size. An EXPLICIT
// continuable:false (with a reason) is respected; an unset/placeholder value
// is decided by the size budget.
function finalizeContinuability(snapshot: RunSnapshot): RunSnapshot {
  // Drop error details / last observations from step errors that bloat the
  // snapshot (error codes + messages are enough to continue).
  const steps = snapshot.steps.map((s) => ({
    ...s,
    ...(s.error !== undefined
      ? { error: { code: (s.error as { code?: string })?.code, message: (s.error as { message?: string })?.message } }
      : {})
  }));
  const compact: RunSnapshot = { ...snapshot, steps };

  if (snapshot.continuable === false && snapshot.continuationReason !== null) {
    return { ...compact, continuable: false, continuationReason: snapshot.continuationReason };
  }

  const bytes = estimateBytes(compact);
  if (bytes <= MAX_RUN_RESULT_BYTES) {
    return { ...compact, continuable: true, continuationReason: null };
  }
  // The minimal snapshot is already projected; anything beyond the budget
  // cannot be honestly resumed.
  return { ...compact, continuable: false, continuationReason: "RUN_SNAPSHOT_TRUNCATED" };
}

export function getRun(runId: string): RunSnapshot | undefined {
  const entry = store.get(runId);
  if (!entry) return undefined;
  if (entry.snapshot.expiresAtMs < Date.now()) {
    store.delete(runId);
    return undefined;
  }
  return entry.snapshot;
}

export function deleteRun(runId: string): void {
  store.delete(runId);
}

export function pruneExpired(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.snapshot.expiresAtMs < now) store.delete(id);
  }
}

export function clearAllRuns(): void {
  store.clear();
}

export function runCount(): number {
  pruneExpired();
  return store.size;
}

export function runTtlRemainingMs(snapshot: RunSnapshot): number {
  return Math.max(0, snapshot.expiresAtMs - Date.now());
}
