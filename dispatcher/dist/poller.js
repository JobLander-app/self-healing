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
exports.getLastPrecheck = getLastPrecheck;
exports.pollOnce = pollOnce;
exports.startPollCron = startPollCron;
exports.stopPollCron = stopPollCron;
exports.startResumeWatcher = startResumeWatcher;
const cron = __importStar(require("node-cron"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const config_1 = require("./config");
const session_1 = require("./session");
const pause_1 = require("./pause");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let task = null;
let lastPrecheck = null;
function getLastPrecheck() {
    return lastPrecheck;
}
// Cached in memory after first resolve — Secret Manager is only hit once per
// process lifetime (env var LINEAR_API_KEY short-circuits it entirely).
let cachedLinearKey = "";
async function resolveLinearApiKey() {
    if (cachedLinearKey)
        return cachedLinearKey;
    if (process.env.LINEAR_API_KEY) {
        cachedLinearKey = process.env.LINEAR_API_KEY;
        return cachedLinearKey;
    }
    const { stdout } = await execFileAsync("gcloud", ["secrets", "versions", "access", "latest", "--secret=linear-api-key", `--project=${config_1.config.gcpProject}`], { timeout: 15_000 });
    const key = stdout.trim();
    if (!key)
        throw new Error("linear-api-key resolved empty from Secret Manager");
    cachedLinearKey = key;
    return key;
}
/**
 * Ask Linear whether ANY candidate ticket exists (team from config, label
 * `monitor`, state To Do / Backlog / In Progress — the states the agent's
 * pickup logic considers, incl. stale-claim reclaims). `first: 1` — we only
 * need existence, not the list. Never throws; errors map to "error" (fail open).
 */
async function precheckCandidates() {
    try {
        const key = await resolveLinearApiKey();
        // config.linearTeam is configured as a team NAME ("JobLander") but could
        // plausibly be set to the key ("JOB") — match either, so a config style
        // change can't silently turn every pre-check into a false "skip".
        const filter = {
            team: { or: [{ name: { eq: config_1.config.linearTeam } }, { key: { eq: config_1.config.linearTeam } }] },
            labels: { name: { eq: "monitor" } },
            state: { name: { in: ["To Do", "Backlog", "In Progress"] } },
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        let res;
        try {
            res = await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: key },
                body: JSON.stringify({
                    query: "query PollerPrecheck($filter: IssueFilter!) { issues(filter: $filter, first: 1) { nodes { identifier } } }",
                    variables: { filter },
                }),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        if (!res.ok)
            throw new Error(`Linear pre-check HTTP ${res.status}`);
        const body = (await res.json());
        if (body.errors && body.errors.length > 0) {
            throw new Error(`Linear pre-check GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
        }
        const nodes = body.data?.issues?.nodes;
        if (!Array.isArray(nodes))
            throw new Error("Linear pre-check: malformed response shape");
        return nodes.length > 0 ? "run" : "skip";
    }
    catch (err) {
        console.error("[poller] pre-check error (failing OPEN — agent will run):", err instanceof Error ? err.message : err);
        return "error";
    }
}
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
    // Cheap Linear pre-check before spawning the (expensive) agent. Manual
    // /trigger BYPASSES it: a trigger means the watcher just filed a ticket
    // (Linear indexing may lag) and it is also the operator fire-drill path.
    // Cron/startup/limit-reset ticks all pre-check. "error" falls through to a
    // normal run (fail open — see the pre-check block above).
    if (reason !== "trigger") {
        const outcome = await precheckCandidates();
        lastPrecheck = { at: new Date().toISOString(), result: outcome };
        if (outcome === "skip") {
            // Deliberately NOT recordRun — a skipped tick is not a run and must not
            // flood /feed. One concise log line is the whole footprint.
            console.log("[poller] pre-check: no monitor candidates — skipped");
            return { ran: false, note: "precheck-skip" };
        }
        // The pre-check awaited network I/O; a /trigger may have started a run in
        // the meantime. runDispatchSession throws if busy, so re-check here.
        if ((0, session_1.isBusy)()) {
            console.log(`[poller] Skipping tick (reason: ${reason}) — became busy during pre-check`);
            return { ran: false, note: "busy" };
        }
    }
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