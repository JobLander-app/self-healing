"use strict";
/**
 * POST /trigger
 *
 * Force a poll tick now, without waiting for the next cron beat. This is an
 * operator convenience (and a hook for an external nudger), NOT the primary
 * trigger — the daemon is self-polling. The work is idempotent: a trigger
 * just means "wake up and look at Linear," exactly like a cron tick.
 *
 * If a dispatch session is already running, we ack without starting a second
 * one (single concurrency is enforced in the poller/session).
 *
 * Auth: X-Dispatch-Token header (or ?token=) must match config.triggerToken.
 * Empty triggerToken ⇒ all triggers rejected (fail closed).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.triggerRouter = void 0;
const express_1 = require("express");
const config_1 = require("../config");
const session_1 = require("../session");
const poller_1 = require("../poller");
const router = (0, express_1.Router)();
exports.triggerRouter = router;
router.post("/", (req, res) => {
    const headerToken = req.header("X-Dispatch-Token") ?? "";
    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    const presented = headerToken || queryToken;
    if (!config_1.config.triggerToken || presented !== config_1.config.triggerToken) {
        res.status(401).json({ error: "invalid dispatch token" });
        return;
    }
    if ((0, session_1.isBusy)()) {
        res.status(200).json({ accepted: true, deduped: true, note: "dispatch already running" });
        return;
    }
    // Fire and forget — don't hold the HTTP request open for a multi-minute
    // agent session.
    (0, poller_1.pollOnce)("trigger").catch((err) => console.error("[trigger] poll error:", err));
    res.status(202).json({ accepted: true, note: "dispatch tick started" });
});
//# sourceMappingURL=trigger.js.map