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
import { incrementRunCounters } from "./metrics";

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
  costUsd: number;
  numTurns: number;
  dryRun: boolean;
  summary: string;
}

const RING_SIZE = 50;
const ring: RunSummary[] = [];

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
  traceEvent(summary.turnId, "run_summary", { ...summary });
  ring.unshift(summary);
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
  // JOB-731: feed the monotonic Prometheus run counters (runs_total, cost_usd).
  incrementRunCounters({ outcome: summary.outcome, costUsd: summary.costUsd });
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
 * RING_SIZE trace files and extracts their `run_summary` event if present.
 */
export function hydrateFromDisk(): void {
  if (!ensureLogDir()) return;
  let files: string[];
  try {
    files = fs
      .readdirSync(config.logDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: fs.statSync(path.join(config.logDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, RING_SIZE)
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
        const ev = JSON.parse(line);
        if (ev.kind === "run_summary" && ev.data) {
          ring.unshift(ev.data);
          if (ring.length > RING_SIZE) ring.length = RING_SIZE;
          // JOB-731: best-effort rehydrate the monotonic run counters so a
          // daemon bounce doesn't zero recent history. hydrateFromDisk is not
          // routed through recordRun, so increment here directly (no double
          // count). An unrecognised outcome buckets to `unknown`.
          incrementRunCounters({
            outcome: ev.data.outcome,
            costUsd: typeof ev.data.costUsd === "number" ? ev.data.costUsd : 0,
          });
        }
      }
    } catch {
      // Skip malformed/partial trace files.
    }
  }
}
