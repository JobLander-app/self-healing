/**
 * change-ingest configuration — fully env-driven, mirroring
 * dispatcher/src/config.ts. This is a distinct component from the dispatcher
 * (the dispatcher is stateless; correlation is inherently stateful — it
 * remembers intent over time), so it owns exactly one durable file: the SQLite
 * change store.
 *
 * Secret resolution (LINEAR/GH) mirrors dispatcher/src/poller.ts: env var wins,
 * else `gcloud secrets versions access` once per process, cached in memory.
 * The audit-log poll needs no secret — it rides the VM SA's ambient ADC.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** A GitHub repo we poll for merged PRs. */
export interface TrackedRepo {
  owner: string;
  repo: string;
}

function parseTrackedRepos(raw: string | undefined): TrackedRepo[] {
  const src =
    raw && raw.trim().length > 0
      ? raw
      : // Default: the five JobLander repos the dispatcher already clones.
        [
          "JobLander-app/backend",
          "JobLander-app/joblander.app",
          "JobLander-app/chrome-extension",
          "JobLander-app/email-service",
          "JobLander-app/ai-voice-agent-python",
        ].join(",");
  return src
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((slug) => {
      const [owner, repo] = slug.split("/");
      if (!owner || !repo) throw new Error(`Invalid TRACKED_REPOS entry: "${slug}" (want owner/repo)`);
      return { owner, repo };
    });
}

export const config = {
  // The single durable file this component owns (§5).
  changesDb: process.env.CHANGES_DB || "/var/lib/self-healing/changes.db",

  // Read-only serving API — localhost only, same firewall invariant as the
  // dispatcher's :4100, Prometheus :9090, Grafana :3000 (§6).
  ingestPort: parseInt(process.env.INGEST_PORT || "4200", 10),

  // GCP project — constant across all JobLander infra.
  gcpProject: process.env.GCP_PROJECT || "meet-assistant-6d8ad",

  // Linear team whose issue-close events we ingest as `decision` changes.
  linearTeam: process.env.LINEAR_TEAM || "JobLander",

  // Repos polled for merged PRs (§3.3).
  trackedRepos: parseTrackedRepos(process.env.TRACKED_REPOS),

  // node-cron schedules per source (§3). audit is the au-delete piece → tightest.
  githubCron: process.env.GITHUB_CRON || "*/5 * * * *",
  gcpAuditCron: process.env.GCP_AUDIT_CRON || "*/2 * * * *",
  linearCron: process.env.LINEAR_CRON || "*/5 * * * *",
  pruneCron: process.env.PRUNE_CRON || "0 3 * * *",

  // Retention: daily prune of rows older than this (§5). 90d is generous for
  // hours-scale correlation and keeps the DB tiny.
  retentionDays: parseInt(process.env.RETENTION_DAYS || "90", 10),

  // `gcloud logging read --freshness` window — bounds the query, overlaps the
  // 2-min cron generously so a missed tick self-heals (§9). Cursor + idempotent
  // id upsert are the real dedupe; --freshness is only a scan bound.
  auditFreshness: process.env.AUDIT_FRESHNESS || "15m",

  // Serving default page size (§6).
  defaultLimit: parseInt(process.env.DEFAULT_LIMIT || "200", 10),

  githubApiBase: process.env.GITHUB_API_BASE || "https://api.github.com",
  linearApiUrl: process.env.LINEAR_API_URL || "https://api.linear.app/graphql",

  nodeEnv: process.env.NODE_ENV || "development",
} as const;

// ---------------------------------------------------------------------------
// Secret resolution — mirrors dispatcher/src/poller.ts::resolveLinearApiKey.
// Env var short-circuits Secret Manager; the resolved value is cached for the
// process lifetime so Secret Manager is hit at most once per secret.
// ---------------------------------------------------------------------------

async function resolveSecret({ envVar, secretName }: { envVar: string; secretName: string }): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const { stdout } = await execFileAsync(
    "gcloud",
    ["secrets", "versions", "access", "latest", `--secret=${secretName}`, `--project=${config.gcpProject}`],
    { timeout: 15_000 },
  );
  const value = stdout.trim();
  if (!value) throw new Error(`${secretName} resolved empty from Secret Manager`);
  return value;
}

let cachedLinearKey = "";
export async function resolveLinearApiKey(): Promise<string> {
  if (cachedLinearKey) return cachedLinearKey;
  cachedLinearKey = await resolveSecret({ envVar: "LINEAR_API_KEY", secretName: "linear-api-key" });
  return cachedLinearKey;
}

let cachedGithubToken = "";
export async function resolveGithubToken(): Promise<string> {
  if (cachedGithubToken) return cachedGithubToken;
  cachedGithubToken = await resolveSecret({ envVar: "GH_TOKEN", secretName: "self-healing-gh-token" });
  return cachedGithubToken;
}
