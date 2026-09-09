/**
 * Disk-backed run state — the only persistence layer this daemon has.
 *
 * Per the stateless design (see config.ts), we do NOT use a database.
 * Instead, every dispatch run appends newline-delimited JSON events to
 * {logDir}/{turn_id}.jsonl, and we keep a small in-memory ring of recent
 * run summaries to serve /status and /feed. On restart the in-memory ring
 * is repopulated by reading the most recent JSONL files off disk, so the
 * HTTP surface survives a daemon bounce without needing a DB.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { incrementRunCounters, incrementAttemptCounters, __resetCountersForTest } from "./metrics";
import { unknownUsage, type Provider, type ProviderAttempt } from "./providerTypes";

export type RunOutcome =
  | "fixed"
  | "not-a-bug"
  | "stale"
  | "fixed-elsewhere"
  | "intentional"
  | "backlogged"
  | "no-work"
  | "error"
  | "unknown";

export interface RunSummary {
  turnId: string;
  startedAt: string;
  finishedAt: string;
  durationSec: number;
  outcome: RunOutcome;
  issueId?: string;
  repo?: string;
  prUrl?: string;
  costUsd: number | null;
  costIsEstimate?: boolean;
  attempts?: ProviderAttempt[];
  numTurns: number;
  dryRun: boolean;
  summary: string;
}

const RING_SIZE = 50;
const ring: RunSummary[] = [];
// Separate from the rotating trace directory. Every completed attempt is
// appended immediately, even when a later attempt/run crashes. Never truncate.
const ledger = path.join(path.dirname(config.logDir), "usage-ledger.jsonl");
const recorded = new Set<string>();
function appendLedger(kind: "run" | "attempt" | "attempt_started", id: string, data: RunSummary | ProviderAttempt): boolean {
  const key = `${kind}:${id}`;
  if (recorded.has(key)) return false;
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  // If a crash left a partial final record, separate it from the next valid
  // record. Recovery skips that one line without poisoning future appends.
  if (fs.existsSync(ledger)) {
    const read = fs.openSync(ledger, "r");
    try {
      const size = fs.fstatSync(read).size;
      const tail = Buffer.alloc(1);
      if (size > 0) { fs.readSync(read, tail, 0, 1, size - 1); if (tail[0] !== 10) fs.appendFileSync(ledger, "\n"); }
    } finally { fs.closeSync(read); }
  }
  const fd = fs.openSync(ledger, "a", 0o600);
  try { fs.writeSync(fd, JSON.stringify({ kind, id, data }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  recorded.add(key);
  return true;
}
export function recordAttemptStarted(turnId: string, provider: Provider, model: string): void {
  const now = new Date().toISOString();
  appendLedger("attempt_started", `${turnId}-${provider}`, {
    id: `${turnId}-${provider}`, provider, model, startedAt: now, finishedAt: now,
    status: "failed", failureKind: "timeout", error: "Daemon interrupted before a terminal attempt record; usage unknown",
    usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0,
  });
}
export function recordAttempt(turnId: string, attempt: ProviderAttempt): void {
  if (appendLedger("attempt", attempt.id, attempt)) incrementAttemptCounters(attempt);
  traceEvent(turnId, "attempt_finished", { ...attempt });
}

function ensureLogDir(): boolean {
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    return true;
  } catch (err) {
    console.error(`[trace] Cannot create logDir ${config.logDir}:`, err);
    return false;
  }
}

function traceFile(turnId: string): string {
  return path.join(config.logDir, `${turnId}.jsonl`);
}

/** Append one structured event to the run's JSONL trace. Best-effort. */
export function traceEvent(turnId: string, kind: string, data?: Record<string, unknown>): void {
  if (!ensureLogDir()) return;
  const event = { ts: new Date().toISOString(), turnId, kind, data };
  try {
    fs.appendFileSync(traceFile(turnId), JSON.stringify(event) + "\n");
  } catch (err) {
    console.error(`[trace] Failed to append event for ${turnId}:`, err);
  }
}

/** Record a completed run: append a final event and push to the ring. */
export function recordRun(summary: RunSummary): void {
  if (!appendLedger("run", summary.turnId, summary)) return;
  traceEvent(summary.turnId, "run_summary", { ...summary });
  ring.unshift(summary);
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
  // JOB-731: feed the monotonic Prometheus run counters (runs_total, cost_usd).
  incrementRunCounters(summary);
}

export function getRecentRuns(limit = 20): RunSummary[] {
  return ring.slice(0, limit);
}

export function getLastRun(): RunSummary | null {
  return ring[0] ?? null;
}

/**
 * Repopulate the in-memory ring from disk on startup, so /status and /feed
 * are meaningful immediately after a restart. Reads the most recent
 * trace files once into the durable ledger; only the HTTP feed uses RING_SIZE.
 */
export function hydrateFromDisk(): void {
  if (!ensureLogDir()) return;
  ring.length = 0;
  recorded.clear();
  __resetCountersForTest();
  const started = new Map<string, ProviderAttempt>();
  try {
    for (const line of fs.readFileSync(ledger, "utf8").split("\n")) {
      try {
        const ev = JSON.parse(line);
        if (!ev.id || !ev.data || !["run", "attempt", "attempt_started"].includes(ev.kind)) continue;
        const key = `${ev.kind}:${ev.id}`;
        if (recorded.has(key)) continue;
        recorded.add(key);
        if (ev.kind === "attempt_started") started.set(ev.id, ev.data);
        else if (ev.kind === "attempt") incrementAttemptCounters(ev.data);
        else {
          incrementRunCounters(ev.data);
          ring.unshift(ev.data);
          ring.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          if (ring.length > RING_SIZE) ring.length = RING_SIZE;
        }
      } catch { /* tolerate a partial final write; preserve other records */ }
    }
  } catch (err: any) { if (err.code !== "ENOENT") throw err; }
  let files: string[];
  try {
    files = fs
      .readdirSync(config.logDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(config.logDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.f);
  } catch (err) {
    console.error("[trace] hydrateFromDisk readdir failed:", err);
    return;
  }

  // Oldest-first so the ring ends up newest-first after unshift.
  for (const file of files.reverse()) {
    try {
      const lines = fs.readFileSync(path.join(config.logDir, file), "utf-8").trim().split("\n");
      for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.kind === "attempt_finished" && ev.data?.id && appendLedger("attempt", ev.data.id, ev.data)) incrementAttemptCounters(ev.data);
        if (ev.kind === "run_summary" && ev.data) {
          if (!appendLedger("run", ev.data.turnId, ev.data)) continue;
          ring.unshift(ev.data);
          ring.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
          if (ring.length > RING_SIZE) ring.length = RING_SIZE;
          // JOB-731: best-effort rehydrate the monotonic run counters so a
          // daemon bounce doesn't zero recent history. hydrateFromDisk is not
          // routed through recordRun, so increment here directly (no double
          // count). An unrecognised outcome buckets to `unknown`.
          incrementRunCounters(ev.data);
        }
      }
    } catch {
      // Skip malformed/partial trace files.
    }
  }
  ring.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const attempt of started.values()) {
    if (appendLedger("attempt", attempt.id, attempt)) incrementAttemptCounters(attempt);
  }
}
