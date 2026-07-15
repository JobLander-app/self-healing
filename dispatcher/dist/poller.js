"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollOnce = pollOnce;
exports.startPollCron = startPollCron;
exports.stopPollCron = stopPollCron;
exports.startResumeWatcher = startResumeWatcher;
const cron = __importStar(require("node-cron"));
const config_1 = require("./config");
const session_1 = require("./session");
const pause_1 = require("./pause");
let task = null;
/**
 * One poll tick. Skips if a dispatch session is already running (single
 * concurrency). Safe to call from cron or from the /trigger endpoint.
 * Never throws.
 */
async function pollOnce(reason) {
    if ((0, session_1.isBusy)()) {
        console.log(`[poller] Skipping tick (reason: ${reason}) — already busy`);
        return { ran: false, note: "busy" };
    }
    // Respect a subscription rate-limit pause. While paused, every tick would
    // just re-hit the wall, so skip until the reset time. Once elapsed, clear
    // the pause and proceed (the limit window has closed).
    const remaining = (0, pause_1.pauseRemainingMs)();
    if (remaining > 0) {
        const until = (0, pause_1.readPause)()?.until;
        console.log(`[poller] Skipping tick (reason: ${reason}) — rate-limit pause, ~${Math.ceil(remaining / 60000)}m left (until ${until})`);
        return { ran: false, note: `paused ${Math.ceil(remaining / 60000)}m` };
    }
    if ((0, pause_1.readPause)())
        (0, pause_1.clearPause)(); // window elapsed → resume normal operation
    try {
        await (0, session_1.runDispatchSession)(reason);
        return { ran: true, note: "completed" };
    }
    catch (err) {
        console.error("[poller] Dispatch session crashed:", err);
        return { ran: false, note: err instanceof Error ? err.message : String(err) };
    }
}
function startPollCron() {
    if (!cron.validate(config_1.config.pollCron)) {
        throw new Error(`Invalid POLL_CRON expression: "${config_1.config.pollCron}"`);
    }
    task = cron.schedule(config_1.config.pollCron, () => {
        pollOnce("cron").catch((err) => console.error("[poller] tick error:", err));
    });
    console.log(`[poller] Self-poll scheduled: "${config_1.config.pollCron}"`);
}
function stopPollCron() {
    if (task) {
        task.stop();
        task = null;
    }
    if (resumeWatcher) {
        clearInterval(resumeWatcher);
        resumeWatcher = null;
    }
}
let resumeWatcher = null;
/**
 * Watch for a rate-limit pause to expire and resume work *immediately* (within
 * 60s), rather than waiting up to a full POLL_CRON interval. Only acts at the
 * moment a pause elapses; otherwise the normal cron drives polling.
 */
function startResumeWatcher() {
    resumeWatcher = setInterval(() => {
        const p = (0, pause_1.readPause)();
        if (p && (0, pause_1.pauseRemainingMs)() === 0) {
            console.log("[poller] Rate-limit window elapsed → resuming immediately.");
            pollOnce("limit-reset").catch((err) => console.error("[poller] resume error:", err));
        }
    }, 60_000);
    console.log("[poller] Resume watcher armed (60s) for rate-limit windows.");
}
//# sourceMappingURL=poller.js.map