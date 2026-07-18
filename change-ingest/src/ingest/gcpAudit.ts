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

/**
 * Pull audit changes since `since` (epoch ms). `--freshness` bounds the scan
 * window (config.auditFreshness); the `timestamp>` clause + idempotent id upsert
 * are the real dedupe, so overlap is harmless.
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
        `--freshness=${config.auditFreshness}`,
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
