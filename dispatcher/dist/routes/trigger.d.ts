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
declare const router: import("express-serve-static-core").Router;
export { router as triggerRouter };
