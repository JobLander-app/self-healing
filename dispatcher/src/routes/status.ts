import { Router, Request, Response } from "express";
import { isBusy, getCurrentTurnId } from "../session";
import { getRecentRuns, getLastRun } from "../trace";
import { getLastPrecheck } from "../poller";
import { getLastHealthcheck } from "../healthcheck";
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
    // EFFECTIVE run budget — the values this process actually enforces, not the
    // defaults in config.ts. These differ whenever the deployed .env (rendered
    // from Secret Manager) pins a value, and that divergence was invisible:
    // on 2026-07-28 the code default was raised 60 → 120 and verified in
    // dist/config.js, but .env still pinned CLAUDE_MAX_TURNS=60, so a run failed
    // on "maximum number of turns (60)" 16 minutes after the deploy that
    // supposedly fixed it. Surfacing them here makes that class of drift a
    // one-line check instead of a forensic exercise.
    maxTurns: config.claudeMaxTurns,
    maxRunMs: config.maxRunMs,
    recentRuns: recent.length,
    recentCostUsd: Math.round(recentCost * 100) / 100,
    // JOB-731: pre-check observability. null until the first pre-checked tick.
    lastPrecheck: getLastPrecheck(),
    // JOB-731 follow-up: dependency healthcheck. null until the first run.
    lastHealthcheck: getLastHealthcheck(),
  });
});

export { router as statusRouter };
