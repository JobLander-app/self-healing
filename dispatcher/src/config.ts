/** Validate cost and concurrency limits before starting the daemon. */
function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export const config = {
  autoMerge: process.env.AUTO_MERGE === "true",
  firebaseEnabled: process.env.FIREBASE_ENABLED === "true",
  sentryEnabled: process.env.SENTRY_ENABLED === "true",
  consumerPolicyFile: process.env.CONSUMER_POLICY_FILE || "",
  trackedRepos: (process.env.TRACKED_REPOS || "").split(",").map(s => s.trim()).filter(Boolean),
  httpPort: parseInt(process.env.HTTP_PORT || "4100", 10),

  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  openCodeEnabled: process.env.OPENCODE_ENABLED === "true",
  openCodeBin: process.env.OPENCODE_BIN || "opencode",
  openCodeModel: process.env.OPENCODE_MODEL || "",
  codexEnabled: process.env.CODEX_ENABLED === "true",
  codexBin: process.env.CODEX_BIN || "codex",
  codexModel: process.env.CODEX_MODEL || "",
  ledgerMaxBytes: positiveInt("LEDGER_MAX_BYTES", process.env.LEDGER_MAX_BYTES, 128 * 1024 * 1024),
  providerThrottleRetryMs: positiveInt("PROVIDER_THROTTLE_RETRY_MS", process.env.PROVIDER_THROTTLE_RETRY_MS, 60_000),
  providerRetryMs: positiveInt("PROVIDER_RETRY_MS", process.env.PROVIDER_RETRY_MS, 3_600_000),
  providerEvidenceMaxMs: positiveInt("PROVIDER_EVIDENCE_MAX_MS", process.env.PROVIDER_EVIDENCE_MAX_MS, 86_400_000),

  claudeMaxTurns: positiveInt("CLAUDE_MAX_TURNS", process.env.CLAUDE_MAX_TURNS, 120),

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
  tgChatId: process.env.TG_CHAT_ID || "",

  // Linear team whose tickets we pick up.
  linearTeam: process.env.LINEAR_TEAM || "",

  // Shared secret for POST /trigger. Empty ⇒ /trigger rejected (open only
  // to callers that present the secret in X-Dispatch-Token).
  triggerToken: process.env.TRIGGER_TOKEN || "",

  // When true the agent does everything EXCEPT irreversible writes
  // (gh pr merge, Linear mutations, known-errors.json writes). Used for the
  // first safe rollout. Passed through to the agent prompt.
  dryRun: (process.env.DRY_RUN || "true").toLowerCase() === "true",

  logDir: process.env.LOG_DIR || "/var/log/claude-code-vm-job-dispatcher/turns",

  // GCP project selected by the consumer profile.
  gcpProject: process.env.GCP_PROJECT || "",

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

export const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || "";
export const LINEAR_MONITOR_LABEL_ID = process.env.LINEAR_MONITOR_LABEL_ID || "";

// Label the agent puts on a ticket when it claims one, and removes when it
// reaches a terminal outcome (constitution Step 2). The agent and the Owner
// share a single Linear account, so `assignee` cannot distinguish "my claim"
// from "the Owner is working on this" — the label is the only signal that can.
// Measured cost of not having it: 54 of 138 recorded runs (39%) ended in
// `no-work` reporting a ticket as "assigned to a human", $5.30 of sessions
// spent re-deriving an undecidable fact.
export const LINEAR_AGENT_CLAIMED_LABEL = "agent-claimed";
export const LINEAR_AGENT_CLAIMED_LABEL_ID = process.env.LINEAR_AGENT_CLAIMED_LABEL_ID || "";

// Secret Manager secret names probed by the healthcheck.
export const LINEAR_API_KEY_SECRET = process.env.LINEAR_API_KEY_SECRET || "linear-api-key";
export const CLAUDE_OAUTH_SECRET = "claude-code-oauth-token";
export const SENTRY_TOKEN_SECRET = process.env.SENTRY_TOKEN_SECRET || "sentry-monitor-token";

if (config.codexEnabled && !config.codexModel) throw new Error("CODEX_MODEL must be explicitly verified and set when CODEX_ENABLED=true");

if (config.openCodeEnabled && !/^openrouter\/[^/]+\/.+/.test(config.openCodeModel)) throw new Error("OPENCODE_MODEL must be an explicit openrouter/provider/model when OPENCODE_ENABLED=true");

export function providerModel(provider: "claude" | "codex" | "opencode"): string {
  return provider === "claude" ? config.claudeModel : provider === "codex" ? config.codexModel : config.openCodeModel;
}
