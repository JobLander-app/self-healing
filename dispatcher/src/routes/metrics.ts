import { Router, Request, Response } from "express";
import { isBusy } from "../session";
import { getLastRun } from "../trace";
import { getLastHealthcheck } from "../healthcheck";
import { getLastPrecheck } from "../poller";
import { renderMetrics } from "../metrics";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const body = renderMetrics({
    busy: isBusy(),
    lastRun: getLastRun(),
    lastHealthcheck: getLastHealthcheck(),
    lastPrecheck: getLastPrecheck(),
  });
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.status(200).send(body);
});

export { router as metricsRouter };
