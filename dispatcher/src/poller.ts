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
import { config } from "./config";
import { isBusy, runDispatchSession } from "./session";
import { readPause, clearPause, pauseRemainingMs } from "./pause";

let task: cron.ScheduledTask | null = null;

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
  try {
    await runDispatchSession(reason);
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
