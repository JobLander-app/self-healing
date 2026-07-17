"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusRouter = void 0;
const express_1 = require("express");
const session_1 = require("../session");
const trace_1 = require("../trace");
const poller_1 = require("../poller");
const healthcheck_1 = require("../healthcheck");
const config_1 = require("../config");
const router = (0, express_1.Router)();
exports.statusRouter = router;
const startedAt = new Date();
// GET /health — liveness. Always 200 while the process is up; reports busy.
router.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
        busy: (0, session_1.isBusy)(),
    });
});
// GET /status — busy flag + last run + recent cost.
router.get("/status", (_req, res) => {
    const recent = (0, trace_1.getRecentRuns)(10);
    const recentCost = recent.reduce((sum, r) => sum + (r.costUsd || 0), 0);
    res.json({
        busy: (0, session_1.isBusy)(),
        currentTurnId: (0, session_1.getCurrentTurnId)(),
        lastRun: (0, trace_1.getLastRun)(),
        uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
        startedAt: startedAt.toISOString(),
        pollCron: config_1.config.pollCron,
        dryRun: config_1.config.dryRun,
        model: config_1.config.claudeModel,
        linearTeam: config_1.config.linearTeam,
        recentRuns: recent.length,
        recentCostUsd: Math.round(recentCost * 100) / 100,
        // JOB-731: pre-check observability. null until the first pre-checked tick.
        lastPrecheck: (0, poller_1.getLastPrecheck)(),
        // JOB-731 follow-up: dependency healthcheck. null until the first run.
        lastHealthcheck: (0, healthcheck_1.getLastHealthcheck)(),
    });
});
//# sourceMappingURL=status.js.map