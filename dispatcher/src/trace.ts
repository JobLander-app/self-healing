/**
 * Disk-backed run state — the only persistence layer this daemon has.
 *
 * Per the stateless design (see config.ts), we do NOT use a database.
 * Instead, every dispatch run appends newline-delimited JSON events to
 * {logDir}/{turn_id}.jsonl, and we keep a small in-memory ring of recent
 * run summaries to serve /status and /feed. On restart the in-memory ring
 * is repopulated by reading the most recent JSONL files off disk, so the
 * HTTP surface survives a daemon bounce without needing a DB. Lifetime usage
 * lives in a separate fsynced ledger that is never rotated with the traces.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "./config";
import { StringDecoder } from "node:string_decoder";
import { accountingFailed, accountingStatus, resetAccountingState, accountForRejectedRecords, ledgerPath } from "./accountingState";
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
const ledger = ledgerPath;
const recorded = new Set<string>();
function appendLedger(kind: "run" | "attempt" | "attempt_started", id: string, data: RunSummary | ProviderAttempt): boolean {
  const key = `${kind}:${id}`;
  if (recorded.has(key)) return false;
  const status = accountingStatus();
  if (!status.healthy) throw new Error(status.error ?? "Accounting unavailable");
  const serialized = JSON.stringify({ kind, id, data }) + "\n";
  if (status.bytes + Buffer.byteLength(serialized) >= config.ledgerMaxBytes) {
    accountingFailed("Ledger size cap reached; preserve ledger and increase capacity before resuming");
    throw new Error(accountingStatus().error!);
  }
  try {
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
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (err: any) { accountingFailed(`Ledger write failed: ${err.code ?? err.message}`); throw err; }
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
  traceEvent(turnId, "attempt_finished", { ...attempt });
  if (appendLedger("attempt", attempt.id, attempt)) incrementAttemptCounters(attempt);
}

function ensureLogDir(): boolean {
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    return true;
  } catch (err) {
    accountingFailed(`Cannot create trace directory: ${err instanceof Error ? err.message : String(err)}`);
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
  try { if (!appendLedger("run", summary.turnId, summary)) return; } catch { /* preserve the feed; readiness exposes failed accounting */ }
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

/** Bounded-line streaming replay avoids loading the complete ledger into RAM. */
function* readLines(file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(64 * 1024);
  let buffered = "";
  try {
    for (;;) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      buffered += decoder.write(chunk.subarray(0, length));
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        if (end > 4_000_000) throw new Error("Journal record exceeded 4 MB");
        yield buffered.slice(0, end); buffered = buffered.slice(end + 1);
      }
      if (buffered.length > 4_000_000) throw new Error("Journal record exceeded 4 MB");
    }
    buffered += decoder.end();
    if (buffered.trim()) yield buffered;
  } finally { fs.closeSync(fd); }
}
export function validRun(value: unknown): value is RunSummary {
  const r = value as Partial<RunSummary> | null;
  return !!r && typeof r === "object" && typeof r.turnId === "string" &&
    typeof r.startedAt === "string" && Number.isFinite(Date.parse(r.startedAt)) &&
    typeof r.outcome === "string";
}
function validUsage(value: unknown): boolean {
  return !!value && typeof value === "object" && ["input", "cachedInput", "cacheWrite", "output"].every(k => {
    const n = (value as any)[k]; return n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  });
}
export function validAttempt(value: unknown): value is ProviderAttempt {
  const a = value as Partial<ProviderAttempt> | null;
  return !!a && typeof a.id === "string" && ["claude", "codex"].includes(a.provider ?? "") &&
    typeof a.model === "string" && typeof a.startedAt === "string" && Number.isFinite(Date.parse(a.startedAt)) &&
    ["completed", "failed"].includes(a.status ?? "") && validUsage(a.usage) &&
    (a.estimatedCostUsd === null || (typeof a.estimatedCostUsd === "number" && Number.isFinite(a.estimatedCostUsd) && a.estimatedCostUsd >= 0)) &&
    (a.models === undefined || (Array.isArray(a.models) && a.models.every(r => r && typeof r.model === "string" && validUsage(r.usage))));
}
function addToRing(summary: RunSummary): void {
  if (ring.some(r => r.turnId === summary.turnId)) return;
  ring.push(summary);
  ring.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (ring.length > RING_SIZE) ring.length = RING_SIZE;
}

/** Liveness survives storage failure; accounting/readiness fail closed until a
 * later poll successfully replays repaired storage. Never truncate the ledger. */
export function hydrateFromDisk(): void {
  resetAccountingState();
  ring.length = 0;
  recorded.clear();
  __resetCountersForTest();
  if (!ensureLogDir()) return;
  const started = new Map<string, ProviderAttempt>();
  let ledgerReadable = true;
  let rejected = 0;
  try {
    const status = accountingStatus();
    if (!status.healthy) throw new Error(status.error!);
    for (const line of readLines(ledger)) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { rejected++; continue; }
      if (typeof ev?.id !== "string" ||
          (ev.kind === "run" ? !validRun(ev.data) : !["attempt", "attempt_started"].includes(ev.kind) || !validAttempt(ev.data))) { rejected++; continue; }
      const key = `${ev.kind}:${ev.id}`;
      if (recorded.has(key)) continue;
      recorded.add(key);
      if (ev.kind === "attempt_started") started.set(ev.id, ev.data);
      else if (ev.kind === "attempt") incrementAttemptCounters(ev.data);
      else { incrementRunCounters(ev.data); addToRing(ev.data); }
    }
    fs.accessSync(ledger, fs.constants.W_OK);
  } catch (err: any) {
    if (err.code !== "ENOENT") { ledgerReadable = false; accountingFailed(`Ledger replay failed: ${err.code ?? err.message}`); }
  }
  accountForRejectedRecords(rejected);
  if (rejected) console.warn(`[accounting] Skipped ${rejected} malformed/partial records; retained all valid records`);
  let files: string[] = [];
  try { files = fs.readdirSync(config.logDir).filter(f => f.endsWith(".jsonl")); }
  catch (err: any) { accountingFailed(`Cannot read trace directory: ${err.code ?? err.message}`); }
  // Legacy traces warm the feed even when the authoritative ledger is
  // unreadable, but must not replace or reset unknown lifetime totals.
  for (const file of files) {
    try {
      for (const line of readLines(path.join(config.logDir, file))) {
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.kind === "run_summary" && validRun(ev.data)) {
          addToRing(ev.data);
          if (ledgerReadable && accountingStatus().healthy && appendLedger("run", ev.data.turnId, ev.data)) incrementRunCounters(ev.data);
        } else if (ev.kind === "attempt_finished" && validAttempt(ev.data) && ledgerReadable && accountingStatus().healthy) {
          if (appendLedger("attempt", ev.data.id, ev.data)) incrementAttemptCounters(ev.data);
        }
      }
    } catch (err: any) { console.warn(`[trace] Legacy replay skipped ${file}: ${err.code ?? err.message}`); }
  }
  if (ledgerReadable && accountingStatus().healthy) {
    for (const attempt of started.values()) {
      try { if (appendLedger("attempt", attempt.id, attempt)) incrementAttemptCounters(attempt); }
      catch { break; }
    }
  }
}
