/**
 * claude-code-vm-job-dispatcher configuration — fully env-driven.
 *
 * Stateless by design: there is NO database. Durable state lives in three
 * places only:
 *   1. Linear — the `In Progress` status is the concurrency claim, and the
 *      issue's terminal status (Done/Canceled/Backlog) is the outcome.
 *   2. JSONL turn traces on disk (logDir) — one file per dispatch run.
 *   3. Telegram — human-facing one-line summary per run.
 *
 * Port: handy-daemon owns :4000. We default to :4100 to avoid any collision.
 */

/**
 * Parse a positive-integer knob, or refuse to start.
 *
 * `parseInt` is far too forgiving for values that gate cost and safety: it
 * yields NaN for malformed input and happily accepts negatives, and neither
 * shows up until something downstream misbehaves — quietly. Concretely, for the
 * three knobs below:
 *   - NaN `staleClaimMinutes` → `new Date(Date.now() - NaN)` is an Invalid Date
 *     → `.toISOString()` throws inside the poll pre-check → the pre-check's
 *     catch treats it as an availability failure and fails OPEN → a full agent
 *     session every tick. That is exactly the ~$14/day idle burn this PR fixes,
 *     reinstated by a typo and invisible while it happens.
 *   - Negative `staleClaimMinutes` → live claims read as stale, so the filter
 *     inverts into greenlighting the very tickets it exists to exclude.
 *   - NaN `maxRunMs` → `setTimeout(…, NaN)` fires immediately → every run
 *     aborted at once by the watchdog.
 *
 * Throwing at startup is deliberate, and mirrors `loadSystemPrompt()` refusing
 * to run without CLAUDE.md: a dispatcher that is dead is noticed in minutes
 * (systemd, /health, the CD verify step), whereas one running with a silently
 * disabled safeguard is not noticed at all — that is the failure mode this whole
 * codebase keeps paying for.
 */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export const config = {
  httpPort: parseInt(process.env.HTTP_PORT || "4100", 10),

  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",

  // Turn budget for one investigation. Raised 60 → 120 on 2026-07-28.
  //
  // At 60 the budget was below what a real investigation costs: in the week of
  // 07-21..07-28, three runs died on "Reached maximum number of turns (60)"
  // burning $2.14 + $2.10 + $3.47 = $7.71 for zero outcome — 20% of the week's
  // entire spend — and each left its ticket untouched to be re-filed later.
  // Meanwhile completed runs legitimately reached 95 turns (JOB-844, $3.32,
  // outcome not-a-bug). The cap was cutting off work that was still converging,
  // which is the most expensive way to fail: full cost, no result.
  claudeMaxTurns: positiveInt("CLAUDE_MAX_TURNS", process.env.CLAUDE_MAX_TURNS, 120),

  // Wall-clock ceiling for ONE dispatch run. claudeMaxTurns bounds the turn
  // COUNT but not time; without a wall-clock abort a single hung turn (a stuck
  // `gh pr checks --watch`, a wedged Bash, a network stall) blocks the run
  // forever and leaves the busy lock stuck true — stalling the entire self-poll
  // loop (observed: a run hung ~5 days, 2026-06-22→27, zero tickets picked up).
  // On timeout the session is aborted and busy is released. Default 25 min.
  maxRunMs: positiveInt("MAX_RUN_MS", process.env.MAX_RUN_MS, 1_500_000),

  // Freshness policy. A Monitor ticket is a hypothesis that a bug existed at
  // FILING time, not a fact at FIX time — the codebase ships fast (features +
  // refactors weekly), so by pickup the bug may be already fixed, no longer
  // recurring, or pointing at refactored-away code. The agent must re-confirm
  // the bug is still live before fixing (see CLAUDE.md "Step 3.5 FRESHNESS
  // GATE"). These two knobs are injected into the run prompt so they stay
  // tunable without editing the constitution.
  //   staleAgeHrs       — ticket age (since createdAt) above which the FULL
  //                       freshness gate is MANDATORY (owner's 12h heuristic).
  //   freshnessWindowHrs — recency window used to re-confirm the signature is
  //                       still occurring (e.g. gcloud --freshness).
  staleAgeHrs: parseInt(process.env.STALE_AGE_HRS || "12", 10),
  freshnessWindowHrs: parseInt(process.env.FRESHNESS_WINDOW_HRS || "6", 10),

  // How long an `In Progress` monitor ticket must sit untouched before the
  // poll pre-check treats it as a reclaimable stale claim. Mirrors the "~30 min"
  // in the constitution's Step 1 stale-claim exception — the pre-check must use
  // the SAME threshold as the agent, or it spawns sessions for tickets the agent
  // will immediately decline.
  staleClaimMinutes: positiveInt("STALE_CLAIM_MINUTES", process.env.STALE_CLAIM_MINUTES, 30),

  // node-cron expression for the self-poll tick. Default: every 10 minutes.
  pollCron: process.env.POLL_CRON || "*/10 * * * *",

  tgBotToken: process.env.TG_BOT_TOKEN || "",
  // String, not int — TG chat ids can be negative (groups) and exceed 2^31.
  tgChatId: process.env.TG_CHAT_ID || "101333337",

  // Linear team whose tickets we pick up.
  linearTeam: process.env.LINEAR_TEAM || "JobLander",

  // Shared secret for POST /trigger. Empty ⇒ /trigger rejected (open only
  // to callers that present the secret in X-Dispatch-Token).
  triggerToken: process.env.TRIGGER_TOKEN || "",

  // When true the agent does everything EXCEPT irreversible writes
  // (gh pr merge, Linear mutations, known-errors.json writes). Used for the
  // first safe rollout. Passed through to the agent prompt.
  dryRun: (process.env.DRY_RUN || "false").toLowerCase() === "true",

  // Where per-run JSONL traces are written. Mirrors the prompt's
  // /var/log/claude-code-vm-job-dispatcher/turns/{turn_id}.jsonl convention.
  logDir: process.env.LOG_DIR || "/var/log/claude-code-vm-job-dispatcher/turns",

  // GCP project — constant across all JobLander infra.
  gcpProject: process.env.GCP_PROJECT || "meet-assistant-6d8ad",

  // Change-ingest service base URL — the local (localhost-only) "change feed"
  // the agent's INTENT GATE (CLAUDE.md Step 3.6) queries to learn whether a
  // recent INTENTIONAL prod change explains an anomaly before it fixes. Same
  // firewall invariant as this daemon's own :4100 — never public. Injected into
  // the run prompt as the CHANGE FEED base URL.
  changeFeedUrl: process.env.CHANGE_FEED_URL || "http://127.0.0.1:4200",

  // Intent-gate lookback: how far BACK the agent queries the change feed for an
  // explaining change. A decommission decision can precede its effect by days,
  // so default generous (72h). Injected into the run prompt.
  intentLookbackHrs: parseInt(process.env.INTENT_LOOKBACK_HRS || "72", 10),

  nodeEnv: process.env.NODE_ENV || "development",
} as const;

// ---------------------------------------------------------------------------
// Healthcheck routing (JOB-731 follow-up).
//
// Linear IDs are a MIRROR of watcher/src/config.ts `LINEAR.*` (cross-package
// coupling — keep in sync). Used by healthcheck.ts to create + dedup the
// inward `[SelfHeal]` repair tickets the dispatcher's own poll loop picks up.
// ---------------------------------------------------------------------------
export const LINEAR_JOB_TEAM_ID = "b12df7a0-4845-47fd-be59-8f6d03d9ae8d";
export const LINEAR_MONITOR_LABEL_ID = "3cf3f731-dccf-43fa-861e-cba73998b183";

// Secret Manager secret names probed by the healthcheck.
export const LINEAR_API_KEY_SECRET = "linear-api-key";
export const CLAUDE_OAUTH_SECRET = "claude-code-oauth-token";
export const SENTRY_TOKEN_SECRET = "joblander-sentry-monitor-token";
