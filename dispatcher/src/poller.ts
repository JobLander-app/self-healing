/**
 * The self-poll cron. Replaces handy-daemon's webhook trigger.
 *
 * Every POLL_CRON tick (default every 10 min) and once on startup, we fire a
 * dispatch session — but only if one is not already in flight. This is the
 * polling model our own research (docs/tasks/symphony-research/linear-integration.md)
 * concluded is the right pattern: re-poll Linear, rediscover work, no
 * persistent orchestrator state. Linear's `In Progress` status is the durable
 * claim; we keep nothing in memory that we can't rebuild from a re-poll.
 */

import * as cron from "node-cron";
import { execFile } from "child_process";
import { promisify } from "util";
import { config } from "./config";
import { isDeploymentInProgress } from "./deployment";
import { buildQueueFilter, CandidateEligibilityError, type SelectedCandidate } from "./queue";
import { readCandidate } from "./queueClient";
import { isBusy, runDispatchSession } from "./session";
import { accountingStatus } from "./accountingState";
import { hydrateFromDisk } from "./trace";
import { alertAccounting } from "./healthAlerts";
import { providerOrder, availableToAttempt, nextProviderRetry, safeError } from "./providerState";

const execFileAsync = promisify(execFile);

let task: cron.ScheduledTask | null = null;

// ---------------------------------------------------------------------------
// Linear pre-check (JOB-731).
//
// WHY: every poll tick used to spawn a full Claude agent run (5–7 turns,
// ~$0.05–0.11) even when there were ZERO candidate tickets — measured 5
// consecutive no-work runs on the live VM, ~144 ticks/day of pure subscription
// burn. A read-only Linear queue scan selects the exact issue before starting an agent.
//
// FAIL CLOSED: no exact eligible ticket means no inference, including manual
// triggers. Failed reads remain observable and durable wakeups retry later.
// ---------------------------------------------------------------------------

export type PrecheckOutcome = "skip" | "run" | "error";
export interface PrecheckState {
  at: string;
  result: PrecheckOutcome;
  candidate?: string;
  error?: string;
}

let lastPrecheck: PrecheckState | null = null;
export function getLastPrecheck(): PrecheckState | null {
  return lastPrecheck;
}

// Cached in memory after first resolve — Secret Manager is only hit once per
// process lifetime (env var LINEAR_API_KEY short-circuits it entirely).
let cachedLinearKey = "";

async function resolveLinearApiKey(): Promise<string> {
  if (cachedLinearKey) return cachedLinearKey;
  if (process.env.LINEAR_API_KEY) {
    cachedLinearKey = process.env.LINEAR_API_KEY;
    return cachedLinearKey;
  }
  const { stdout } = await execFileAsync(
    "gcloud",
    ["secrets", "versions", "access", "latest", "--secret=linear-api-key", `--project=${config.gcpProject}`],
    { timeout: 15_000 },
  );
  const key = stdout.trim();
  if (!key) throw new Error("linear-api-key resolved empty from Secret Manager");
  cachedLinearKey = key;
  return key;
}

/**
 * Build the Linear GraphQL IssueFilter object that defines "a monitor-origin
 * candidate". Exported so tests can inspect the shape without mocking the
 * network.
 *
 * A ticket qualifies if it satisfies EITHER:
 *   • carries the `monitor` label (normal path: watcher / healthcheck), OR
 *   • title starts with "[Monitor]" (human/tool filed it without the label).
 * Both alternatives are OR-ed inside a top-level `and` alongside the state
 * gate, so the two dimensions are independent. This keeps the pre-check filter
 * in exact sync with the agent constitution's Step-1 pick criteria — a
 * pre-check wider than the agent spawns sessions that return `no-work`,
 * burning subscription quota (2026-07-28: 21 consecutive such runs, ~$14/day).
 * JOB-915: fix for the label-only pre-check that silently dropped tickets
 * filed with the correct prefix but without the label.
 */
export function buildPrecheckFilter(staleClaimBefore: string): object {
  return buildQueueFilter(config.linearTeam, staleClaimBefore);
}

/**
 * Select the exact candidate using the same contract sent to the agent. Drain
 * all pages, then rank eligible recent tickets deterministically. Read failures
 * block inference and remain visible through status and precheck metrics.
 */
async function precheckCandidates(): Promise<{ outcome: PrecheckOutcome; candidate?: SelectedCandidate; error?: string }> {
  try {
    const key = await resolveLinearApiKey();
    const staleClaimBefore = new Date(Date.now() - config.staleClaimMinutes * 60_000).toISOString();
    const candidate = await readCandidate({ key, team: config.linearTeam, staleClaimBefore });
    return candidate ? { outcome: "run", candidate } : { outcome: "skip" };
  } catch (err) {
    const error = safeError(err instanceof Error ? err.message : String(err));
    console.error("[poller] pre-check error (failing CLOSED — no inference):", error);
    return { outcome: "error", error };
  }
}

/**
 * One poll tick. Skips if a dispatch session is already running (single
 * concurrency). Safe to call from cron or from the /trigger endpoint.
 * Never throws.
 */
export async function pollOnce(reason: string): Promise<{ ran: boolean; note: string }> {
  if (isDeploymentInProgress()) return { ran: false, note: "deploying" };
  if (isBusy()) {
    console.log(`[poller] Skipping tick (reason: ${reason}) — already busy`);
    return { ran: false, note: "busy" };
  }
  // Retry storage replay after repair without restarting liveness endpoints.
  if (!accountingStatus().healthy) hydrateFromDisk();
  await alertAccounting().catch(err => console.error("[poller] accounting alert failed:", err));
  if (!accountingStatus().healthy) return { ran: false, note: "accounting unavailable" };
  if (!providerOrder().some(p => availableToAttempt(p))) {
    return { ran: false, note: "all providers cooling down" };
  }
  // Every wakeup uses the same exact-candidate, seven-day, fail-closed gate.
  const selection = await precheckCandidates();
  const { outcome, candidate, error } = selection;
  lastPrecheck = { at: new Date().toISOString(), result: outcome, candidate: candidate?.identifier, error };
  if (outcome === "error") return { ran: false, note: "precheck-error" };
  if (outcome === "skip") {
    console.log("[poller] pre-check: no eligible monitor tickets created within 7 days — skipped");
    return { ran: false, note: "precheck-skip" };
  }
  if (candidate) console.log(`[poller] selected ${candidate.identifier} (createdAt=${candidate.createdAt}, reclaim=${candidate.reclaim})`);
  // Recheck concurrency/deployment after the awaited queue read.
  if (isBusy()) return { ran: false, note: "busy" };
  if (isDeploymentInProgress()) return { ran: false, note: "deploying" };
  try {
    const summary = await runDispatchSession(reason, candidate);
    // A failed attempt must not acknowledge a durable wakeup as completed.
    return summary.outcome === "error"
      ? { ran: false, note: "session-error" }
      : { ran: true, note: "completed" };
  } catch (err) {
    if (err instanceof CandidateEligibilityError) {
      lastPrecheck = { at: new Date().toISOString(), result: "error", candidate: candidate?.identifier, error: err.message };
      console.error("[poller] candidate refused at provider boundary:", err.message);
      return { ran: false, note: "precheck-error" };
    }
    console.error("[poller] Dispatch session crashed:", err);
    return { ran: false, note: err instanceof Error ? err.message : String(err) };
  }
}

export function startPollCron(): void {
  if (!cron.validate(config.pollCron)) {
    throw new Error(`Invalid POLL_CRON expression: "${config.pollCron}"`);
  }
  task = cron.schedule(config.pollCron, () => {
    pollOnce("cron").catch((err) => console.error("[poller] tick error:", err));
  });
  console.log(`[poller] Self-poll scheduled: "${config.pollCron}"`);
}

export function stopPollCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
  if (resumeWatcher) {
    clearInterval(resumeWatcher);
    resumeWatcher = null;
  }
}

let resumeWatcher: NodeJS.Timeout | null = null;

/** Retry each provider deadline once within 60s; normal cron remains active. */
export function startResumeWatcher(): void {
  let lastDeadline = -Infinity;
  resumeWatcher = setInterval(() => {
    const deadline = nextProviderRetry(lastDeadline);
    if (deadline !== null && deadline <= Date.now() && deadline !== lastDeadline) {
      lastDeadline = deadline;
      console.log("[poller] Provider retry window elapsed → checking work.");
      pollOnce("provider-retry").catch(err => console.error("[poller] resume error:", err));
    }
  }, 60_000);
  console.log("[poller] Resume watcher armed (60s) for provider retry windows.");
}
