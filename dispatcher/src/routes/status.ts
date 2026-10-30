import { Router, Request, Response } from "express";
import { isBusy, getCurrentTurnId } from "../session";
import { getRecentRuns, getLastRun, type RunSummary } from "../trace";
import { getLastPrecheck } from "../poller";
import { getLastHealthcheck } from "../healthcheck";
import { config } from "../config";
import { accountingStatus } from "../accountingState";
import { providerReadiness } from "../providerState";

const router = Router();
const startedAt = new Date();

export function readiness() {
  const provider = providerReadiness();
  const deps = getLastHealthcheck();
  const dependenciesReady = !!deps && deps.healthy === deps.total && Date.now() - Date.parse(deps.at) < 7 * 3_600_000;
  const accounting = accountingStatus();
  return { ready: provider.ready && dependenciesReady && accounting.healthy, accounting, providers: provider.providers, dependenciesReady, lastDependencyCheck: deps?.at ?? null };
}
// Backwards-compatible liveness: cron watchdog relies on exact status:"ok".
// Provider quota must NEVER drive a VM reset. Use /ready for capability alerts.
router.get(["/health", "/live"], (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
    busy: isBusy(),
    ...readiness(),
  });
});
router.get("/ready", (_req: Request, res: Response) => {
  const state = readiness();
  res.status(state.ready ? 200 : 503).json({ status: state.ready ? "ok" : "degraded", ...state });
});

export function knownEstimatedCost(run: RunSummary): number {
  return run.attempts?.length
    ? run.attempts.reduce((sum, attempt) => sum + (attempt.estimatedCostUsd ?? 0), 0)
    : run.costUsd ?? 0;
}

// GET /status — busy flag + last run + recent cost.
router.get("/status", (_req: Request, res: Response) => {
  const recent = getRecentRuns(10);
  const recentCost = recent.reduce((sum, r) => sum + (r.costUsd || 0), 0);
  res.json({
    readiness: readiness(),
    providers: { primary: config.claudeModel, fallback: config.codexEnabled ? config.codexModel : null, openCode: config.openCodeEnabled ? config.openCodeModel : null },
    costIsEstimate: true,
    recentUnknownCostRuns: recent.filter(r => r.costUsd === null).length,
    busy: isBusy(),
    currentTurnId: getCurrentTurnId(),
    lastRun: getLastRun(),
    uptime: Math.round((Date.now() - startedAt.getTime()) / 1000),
    startedAt: startedAt.toISOString(),
    pollCron: config.pollCron,
    dryRun: config.dryRun,
    model: config.claudeModel,
    linearTeam: config.linearTeam,
    maxTurns: config.claudeMaxTurns,
    maxRunMs: config.maxRunMs,
    recentRuns: recent.length,
    recentCostUsd: recent.some(r => r.costUsd === null) ? null : Math.round(recentCost * 100) / 100,
    recentKnownEstimatedCostUsd: Math.round(recent.reduce((sum, run) => sum + knownEstimatedCost(run), 0) * 100) / 100,
    lastPrecheck: getLastPrecheck(),
    lastHealthcheck: getLastHealthcheck(),
  });
});

export { router as statusRouter };
