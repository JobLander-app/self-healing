"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const api_1 = require("./api");
const poller_1 = require("./poller");
const pause_1 = require("./pause");
const trace_1 = require("./trace");
async function main() {
    console.log("[claude-code-vm-job-dispatcher] Starting...");
    console.log(`[claude-code-vm-job-dispatcher] Model: ${config_1.config.claudeModel}, Port: ${config_1.config.httpPort}, ` +
        `Team: ${config_1.config.linearTeam}, DRY_RUN: ${config_1.config.dryRun}`);
    // 1. Rebuild recent-run state from disk so /status and /feed are useful
    //    immediately after a restart (no DB to read from).
    (0, trace_1.hydrateFromDisk)();
    // 2. Start HTTP API.
    await (0, api_1.startApi)();
    console.log(`[claude-code-vm-job-dispatcher] API ready on :${config_1.config.httpPort}`);
    // 3. Start the self-poll cron + the rate-limit resume watcher.
    (0, poller_1.startPollCron)();
    (0, poller_1.startResumeWatcher)();
    // 4. NO Telegram on start/stop/runs — the alerts channel is P0-only.
    //    Status is available via /status and /self-healing-report.
    // 5. Kick one poll immediately on startup (don't wait for the first cron
    //    beat) — unless we're inside a rate-limit pause window that survived a
    //    restart, in which case pollOnce skips and the resume watcher takes over.
    const pausedMs = (0, pause_1.pauseRemainingMs)();
    if (pausedMs > 0) {
        console.log(`[claude-code-vm-job-dispatcher] Rate-limit pause active (~${Math.ceil(pausedMs / 60000)}m left, until ${(0, pause_1.readPause)()?.until}); startup poll deferred.`);
    }
    else {
        console.log("[claude-code-vm-job-dispatcher] Running startup poll...");
    }
    (0, poller_1.pollOnce)("startup").catch((err) => console.error("[claude-code-vm-job-dispatcher] startup poll error:", err));
    console.log("[claude-code-vm-job-dispatcher] Ready. Self-polling...");
    // Graceful shutdown.
    const shutdown = async (signal) => {
        console.log(`[claude-code-vm-job-dispatcher] ${signal} received, shutting down...`);
        (0, poller_1.stopPollCron)();
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
}
main().catch((err) => {
    console.error("[claude-code-vm-job-dispatcher] Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map