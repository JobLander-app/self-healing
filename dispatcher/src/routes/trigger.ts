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

import * as path from "node:path";
import { TriggerReceipts } from "../triggerReceipts";
import { Router, Request, Response } from "express";
import { config } from "../config";
import { isBusy } from "../session";
import { pollOnce } from "../poller";

const router = Router();
const receipts = new TriggerReceipts(
  process.env.TRIGGER_RECEIPTS_FILE || path.resolve(config.logDir, "..", "trigger-receipts.json"),
  () => pollOnce("trigger"),
);
const drain = () => { void receipts.drain().catch(error => console.error("[trigger] receipt drain failed:", error)); };
const retryTimer = setInterval(drain, 60_000);
retryTimer.unref();
setImmediate(drain); // Resume durable accepted work after a daemon restart.


router.post("/", (req: Request, res: Response) => {
  const headerToken = req.header("X-Dispatch-Token") ?? "";
  const queryToken = typeof req.query.token === "string" ? req.query.token : "";
  const presented = headerToken || queryToken;
  if (!config.triggerToken || presented !== config.triggerToken) {
    res.status(401).json({ error: "invalid dispatch token" });
    return;
  }

  const key = req.header("Idempotency-Key");
  if (key !== undefined) {
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(key)) {
      res.status(400).json({ error: "invalid idempotency key" });
      return;
    }
    try {
      const created = receipts.accept(key);
      res.status(created ? 202 : 200).json({ accepted: true, deduped: !created, note: "durable wakeup queued" });
      setImmediate(drain);
    } catch (error) {
      console.error("[trigger] unable to persist wakeup:", error);
      res.status(503).json({ error: "unable to persist wakeup; retry with same key" });
    }
    return;
  }

  if (isBusy()) {
    res.status(200).json({ accepted: true, deduped: true, note: "dispatch already running" });
    return;
  }

  // Fire and forget — don't hold the HTTP request open for a multi-minute
  // agent session.
  pollOnce("trigger").catch((err) => console.error("[trigger] poll error:", err));

  res.status(202).json({ accepted: true, note: "dispatch tick started" });
});

export { router as triggerRouter };
