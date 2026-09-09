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
import { buildQueueFilter, type SelectedCandidate } from "./queue";
import { readCandidate } from "./queueClient";
import { isBusy, runDispatchSession } from "./session";
import { readPause, clearPause, pauseRemainingMs } from "./pause";

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
// FAIL OPEN: if the key can't be resolved, the request errors/times out, or
// the response is malformed, we spawn the agent exactly as before. The
// pre-check may only ever SAVE money — it must never make the loop blind to
// real work. A confirmed-empty result ("skip") is the only path that skips.
// ---------------------------------------------------------------------------

export type PrecheckOutcome = "skip" | "run" | "error";
export interface PrecheckState {
  at: string;
  result: PrecheckOutcome;
  candidate?: string;
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
 * all pages, then rank eligible tickets deterministically. Never throws; errors
 * retain the existing fail-open discovery path.
 */
async function precheckCandidates(): Promise<{ outcome: PrecheckOutcome; candidate?: SelectedCandidate }> {
  try {
    const key = await resolveLinearApiKey();
    const staleClaimBefore = new Date(Date.now() - config.staleClaimMinutes * 60_000).toISOString();
    const candidate = await readCandidate({ key, team: config.linearTeam, staleClaimBefore });
    return candidate ? { outcome: "run", candidate } : { outcome: "skip" };
  } catch (err) {
    console.error("[poller] pre-check error (failing OPEN — agent will run):", err instanceof Error ? err.message : err);
    return { outcome: "error" };
  }
}

/**
 * One poll tick. Skips if a dispatch session is already running (single
 * concurrency). Safe to call from cron or from the /trigger endpoint.
 * Never throws.
 */
export async function pollOnce(reason: string): Promise<{ ran: boolean; note: string }> {
  if (isBusy()) {
    console.log(`[poller] Skipping tick (reason: ${reason}) — already busy`);
    return { ran: false, note: "busy" };
  }
  // Respect a subscription rate-limit pause. While paused, every tick would
  // just re-hit the wall, so skip until the reset time. Once elapsed, clear
  // the pause and proceed (the limit window has closed).
  const remaining = pauseRemainingMs();
  if (remaining > 0) {
    const until = readPause()?.until;
    console.log(`[poller] Skipping tick (reason: ${reason}) — rate-limit pause, ~${Math.ceil(remaining / 60000)}m left (until ${until})`);
    return { ran: false, note: `paused ${Math.ceil(remaining / 60000)}m` };
  }
  if (readPause()) clearPause(); // window elapsed → resume normal operation
  // Cheap Linear pre-check before spawning the (expensive) agent. Manual
  // /trigger BYPASSES it: a trigger means the watcher just filed a ticket
  // (Linear indexing may lag) and it is also the operator fire-drill path.
  // Cron/startup/limit-reset ticks all pre-check. "error" falls through to a
  // normal run (fail open — see the pre-check block above).
  let candidate: SelectedCandidate | undefined;
  if (reason !== "trigger") {
    const selection = await precheckCandidates();
    const { outcome } = selection;
    candidate = selection.candidate;
    lastPrecheck = { at: new Date().toISOString(), result: outcome, candidate: candidate?.identifier };
    if (outcome === "skip") {
      // Deliberately NOT recordRun — a skipped tick is not a run and must not
      // flood /feed. One concise log line is the whole footprint.
      console.log("[poller] pre-check: no monitor candidates — skipped");
      return { ran: false, note: "precheck-skip" };
    }
    if (candidate) console.log(`[poller] selected ${candidate.identifier} (reclaim=${candidate.reclaim})`);
    // The pre-check awaited network I/O; a /trigger may have started a run in
    // the meantime. runDispatchSession throws if busy, so re-check here.
    if (isBusy()) {
      console.log(`[poller] Skipping tick (reason: ${reason}) — became busy during pre-check`);
      return { ran: false, note: "busy" };
    }
  }
  try {
    await runDispatchSession(reason, candidate);
    return { ran: true, note: "completed" };
  } catch (err) {
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

/**
 * Watch for a rate-limit pause to expire and resume work *immediately* (within
 * 60s), rather than waiting up to a full POLL_CRON interval. Only acts at the
 * moment a pause elapses; otherwise the normal cron drives polling.
 */
export function startResumeWatcher(): void {
  resumeWatcher = setInterval(() => {
    const p = readPause();
    if (p && pauseRemainingMs() === 0) {
      console.log("[poller] Rate-limit window elapsed → resuming immediately.");
      pollOnce("limit-reset").catch((err) => console.error("[poller] resume error:", err));
    }
  }, 60_000);
  console.log("[poller] Resume watcher armed (60s) for rate-limit windows.");
}
