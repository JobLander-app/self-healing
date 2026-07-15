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
export type RunOutcome = "fixed" | "not-a-bug" | "stale" | "fixed-elsewhere" | "backlogged" | "no-work" | "error" | "unknown";
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
/** Append one structured event to the run's JSONL trace. Best-effort. */
export declare function traceEvent(turnId: string, kind: string, data?: Record<string, unknown>): void;
/** Record a completed run: append a final event and push to the ring. */
export declare function recordRun(summary: RunSummary): void;
export declare function getRecentRuns(limit?: number): RunSummary[];
export declare function getLastRun(): RunSummary | null;
/**
 * Repopulate the in-memory ring from disk on startup, so /status and /feed
 * are meaningful immediately after a restart. Reads the most recent
 * RING_SIZE trace files and extracts their `run_summary` event if present.
 */
export declare function hydrateFromDisk(): void;
