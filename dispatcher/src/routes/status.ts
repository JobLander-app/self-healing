import { Router, Request, Response } from "express";
import { isBusy, getCurrentTurnId } from "../session";
import { getRecentRuns, getLastRun } from "../trace";
import { getLastPrecheck } from "../poller";
import { config } from "../config";

const router = Router();
const startedAt = new Date();

// GET /health — liveness. Always 200 while the process is up; reports busy.
router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
    busy: isBusy(),
  });
});

// GET /status — busy flag + last run + recent cost.
router.get("/status", (_req: Request, res: Response) => {
  const recent = getRecentRuns(10);
  const recentCost = recent.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  res.json({
    busy: isBusy(),
    currentTurnId: getCurrentTurnId(),
    lastRun: getLastRun(),
    uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
    startedAt: startedAt.toISOString(),
    pollCron: config.pollCron,
    dryRun: config.dryRun,
    model: config.claudeModel,
    linearTeam: config.linearTeam,
    recentRuns: recent.length,
    recentCostUsd: Math.round(recentCost * 100) / 100,
    // JOB-731: pre-check observability. null until the first pre-checked tick.
    lastPrecheck: getLastPrecheck(),
  });
});

export { router as statusRouter };
