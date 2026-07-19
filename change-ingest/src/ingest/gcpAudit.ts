/**
 * GCP Cloud Audit Logs poller (§3.1, §4) — the source that would have caught the
 * au delete. Runs a `gcloud logging read` of the Admin Activity audit log with
 * the EXACT §4.1 filter, using the same execFile subprocess pattern
 * monitor/triage.py already proved under the minimal SA (roles/logging.viewer,
 * no new IAM). Maps each entry via gcpAuditExtract.
 *
 * FAIL OPEN: a gcloud failure / bad JSON yields [] — same `collection_errors`
 * soft-fail discipline as triage.py; the tick logs and retries next beat.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "../config";
import { GcpAuditLogEntry, gcpAuditExtract } from "../extract";
import { ExtractedChange } from "../model";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 60_000;
const LIMIT = 100;

/** The §4.1 change classes: instance delete/create, Cloud Run deploy, IAM set. */
function buildFilter(sinceIso: string): string {
  return (
    `logName="projects/${config.gcpProject}/logs/cloudaudit.googleapis.com%2Factivity" ` +
    `AND (protoPayload.methodName="v1.compute.instances.delete" ` +
    `OR protoPayload.methodName="v1.compute.instances.insert" ` +
    `OR protoPayload.methodName:"run.v2.Services" ` +
    `OR protoPayload.methodName="SetIamPolicy") ` +
    `AND timestamp>"${sinceIso}"`
  );
}

/** Parse a gcloud-style duration ("15m", "2h", "90s", "1d") to whole minutes;
 *  falls back to 15 on anything unexpected. Used only as a floor. */
function durationToMinutes(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return 15;
  const n = parseInt(m[1], 10);
  const perMin = { s: 1 / 60, m: 1, h: 60, d: 1440 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return Math.max(1, Math.ceil(n * perMin));
}

/**
 * `--freshness` must COVER the whole [since, now] scan window, else it silently
 * caps the backfill: on a fresh-VM 72h backfill a static 15m freshness would
 * scan only the last 15 min. Derive it from `since` (+2m overlap buffer), never
 * below the configured floor. The precise lower bound is the `timestamp>` clause.
 */
function freshnessArg(since: number): string {
  const spanMin = Math.ceil((Date.now() - since) / 60_000) + 2;
  const floor = durationToMinutes(config.auditFreshness);
  return `${Math.max(floor, spanMin)}m`;
}

/**
 * Pull audit changes since `since` (epoch ms). Reads **ascending** (oldest
 * first) with a bounded `--limit`: if a startup/outage interval has >LIMIT
 * matching events, this ingests the OLDEST LIMIT, the caller advances the cursor
 * to the max ingested ts, and the next tick drains forward from there — so no
 * older event inside the intent lookback is ever skipped (Codex P2, PR #13). The
 * `timestamp>` clause + idempotent id upsert make overlap harmless.
 */
export async function pull({ since }: { since: number }): Promise<ExtractedChange[]> {
  const sinceIso = new Date(since).toISOString();
  const filter = buildFilter(sinceIso);
  try {
    const { stdout } = await execFileAsync(
      "gcloud",
      [
        "logging",
        "read",
        filter,
        `--project=${config.gcpProject}`,
        `--limit=${LIMIT}`,
        "--order=asc",
        `--freshness=${freshnessArg(since)}`,
        "--format=json",
      ],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const entries = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(entries)) throw new Error("gcloud logging read: non-array JSON");
    return (entries as GcpAuditLogEntry[]).map((entry) => gcpAuditExtract({ entry }));
  } catch (err) {
    console.error("[ingest:gcpAudit] pull failed (fail open):", err instanceof Error ? err.message : err);
    return [];
  }
}
