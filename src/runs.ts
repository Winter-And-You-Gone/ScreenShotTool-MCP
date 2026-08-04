// Run store for runId / continue_run.
//
// Pipeline executions (run_steps, profile_run_steps, run_workflow) register a
// run snapshot here so a failed pipeline can be continued with continue_run.
// Snapshots are in-memory only, expire after RUN_TTL_MS, and are capped in
// number and size. Everything is cleared on process exit (no persistence).

import { randomUUID } from "node:crypto";

export const RUN_TTL_MS = 10 * 60 * 1000;
export const MAX_RUNS = 20;
export const MAX_RUN_RESULT_BYTES = 2 * 1024 * 1024;

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
  // Per-step resolved args (continue re-uses these instead of re-resolving).
  resolvedArgs: Array<{ tool: string; args: unknown }>;
  // Results of completed steps, keyed by step id / index.
  results: Array<{ id?: string; tool: string; success: boolean; result?: unknown; error?: unknown }>;
  exports: Record<string, unknown>;
  stoppedAtStep: number;
  error?: unknown;
  // Workflow inputs (for input-dependent re-execution).
  inputs?: Record<string, unknown>;
  maxSteps: number;
  totalTimeoutMs: number;
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

export function saveRun(snapshot: RunSnapshot): string {
  pruneExpired();
  // Evict oldest when over the cap.
  if (store.size >= MAX_RUNS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].snapshot.createdAtMs - b[1].snapshot.createdAtMs)[0];
    if (oldest) store.delete(oldest[0]);
  }
  const bytes = estimateBytes(snapshot);
  if (bytes > MAX_RUN_RESULT_BYTES) {
    // Keep a truncated snapshot: drop step results, keep the continuation
    // metadata. The run remains continuable because resolvedArgs are the
    // important part for re-execution.
    snapshot.results = snapshot.results.map((r) => ({ id: r.id, tool: r.tool, success: r.success, error: r.error }));
    snapshot.exports = {};
  }
  store.set(snapshot.runId, { snapshot, bytes });
  return snapshot.runId;
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
