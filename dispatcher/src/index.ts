import { config } from "./config";
import { startApi } from "./api";
import { pollOnce, startPollCron, stopPollCron, startResumeWatcher } from "./poller";
import { pauseRemainingMs, readPause } from "./pause";
import { hydrateFromDisk } from "./trace";
import { runHealthcheck, startHealthcheckCron } from "./healthcheck";

async function main() {
  console.log("[claude-code-vm-job-dispatcher] Starting...");
  console.log(
    `[claude-code-vm-job-dispatcher] Model: ${config.claudeModel}, Port: ${config.httpPort}, ` +
      `Team: ${config.linearTeam}, DRY_RUN: ${config.dryRun}`,
  );
  // EFFECTIVE run budget, logged at startup. config.ts defaults are only the
  // fallback — the deployed .env (rendered from Secret Manager) overrides them,
  // and that override was silent. 2026-07-28: the default was raised 60 → 120
  // and confirmed in dist/config.js, but .env still pinned
  // CLAUDE_MAX_TURNS=60; a run died on "maximum number of turns (60)" 16 min
  // after the deploy meant to prevent exactly that. A process that does not say
  // what limits it is enforcing cannot be debugged from the outside.
  console.log(
    `[claude-code-vm-job-dispatcher] Run budget: maxTurns=${config.claudeMaxTurns}, ` +
      `maxRunMs=${config.maxRunMs} (${Math.round(config.maxRunMs / 60000)}m), ` +
      `poll=${config.pollCron}`,
  );

  // 1. Rebuild recent-run state from disk so /status and /feed are useful
  //    immediately after a restart (no DB to read from).
  hydrateFromDisk();

  // 2. Start HTTP API.
  await startApi();
  console.log(`[claude-code-vm-job-dispatcher] API ready on :${config.httpPort}`);

  // 3. Start the self-poll cron + the rate-limit resume watcher.
  startPollCron();
  startResumeWatcher();

  // 3.5 Dependency healthcheck (JOB-731 follow-up): verify the toolchain the
  //     dispatch session depends on (firebase/sentry MCP, gcloud, Claude OAuth
  //     token, Linear). Runs once now (non-blocking, fail-soft — never crashes
  //     the daemon) + every 6h. On a downed dep it files an inward `monitor`
  //     ticket the poll loop repairs.
  startHealthcheckCron();
  runHealthcheck().catch((err) => console.error("[claude-code-vm-job-dispatcher] startup healthcheck error:", err));

  // 4. NO Telegram on start/stop/runs — the alerts channel is P0-only.
  //    Status is available via /status and /self-healing-report.

  // 5. Kick one poll immediately on startup (don't wait for the first cron
  //    beat) — unless we're inside a rate-limit pause window that survived a
  //    restart, in which case pollOnce skips and the resume watcher takes over.
  const pausedMs = pauseRemainingMs();
  if (pausedMs > 0) {
    console.log(`[claude-code-vm-job-dispatcher] Rate-limit pause active (~${Math.ceil(pausedMs / 60000)}m left, until ${readPause()?.until}); startup poll deferred.`);
  } else {
    console.log("[claude-code-vm-job-dispatcher] Running startup poll...");
  }
  pollOnce("startup").catch((err) => console.error("[claude-code-vm-job-dispatcher] startup poll error:", err));

  console.log("[claude-code-vm-job-dispatcher] Ready. Self-polling...");

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    console.log(`[claude-code-vm-job-dispatcher] ${signal} received, shutting down...`);
    stopPollCron();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[claude-code-vm-job-dispatcher] Fatal error:", err);
  process.exit(1);
});
