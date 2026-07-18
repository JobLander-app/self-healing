import { decide } from "./decide.js";
import {
  buildPageMessage,
  buildRecoveredMessage,
  buildTicketCreatedMessage,
} from "./messages.js";
import { renderRegions } from "./regions.js";
import type { Decision, Sample, WatchState } from "./types.js";

export interface TickEffects {
  /** Page the owner (Telegram / notify.sh). */
  notifyOwner: (input: { message: string }) => Promise<void>;
  /**
   * File the [Monitor] Linear ticket. Best-effort. Resolves to the created
   * issue identifier (e.g. "JOB-742") on success, or null when the create was
   * skipped (missing key) or the response carried no identifier. Throws on a
   * real create failure.
   */
  createLinearTicket: (input: {
    status: string;
    httpCode: string;
    regions: string;
  }) => Promise<string | null>;
  /** Wake the self-heal dispatcher (POST /trigger). Best-effort. */
  triggerDispatcher: () => Promise<void>;
  /** Persist the "COUNT PAGED" state file. */
  saveState: (input: { state: WatchState }) => Promise<void>;
  /** Structured stdout line (heartbeat, DRY_RUN echo, error reports). */
  log: (input: { line: string }) => void;
  /**
   * Best-effort Prometheus textfile write (JOB-731 observability). Optional so
   * tests can omit it. Additive and fail-soft — it never throws and runs AFTER
   * the heartbeat, so it can never reorder or block the page-first flow.
   */
  writeMetrics?: (input: {
    detectorOk: boolean;
    consecutiveBad: number;
    pagedThisTick: boolean;
    recoveredThisTick: boolean;
  }) => Promise<void>;
}

const runSafely = async ({
  action,
  label,
  log,
}: {
  action: () => Promise<void>;
  label: string;
  log: TickEffects["log"];
}): Promise<void> => {
  try {
    await action();
  } catch (error) {
    // Best-effort: log, never throw — a Linear/trigger failure must not
    // break the tick (and can never affect the already-sent Telegram page).
    log({ line: `output-watch: ${label} failed: ${String(error)}` });
  }
};

/**
 * One watcher tick over an already-fetched sample. Side-effect ordering is
 * deliberate (page-ordering hardening):
 *   1. state is persisted first (as in bash: a pager crash can suppress a
 *      page, but can never double-page),
 *   2. Telegram page fires FIRST,
 *   3. Linear ticket and dispatcher trigger follow, best-effort — their
 *      failures are logged, never thrown, and cannot block the page.
 * After a SUCCESSFUL Linear create, a second short "🎫 … created" Telegram is
 * sent (lifecycle observability) — it never precedes or blocks the page.
 * Ends with exactly one `WATCHER_HEARTBEAT {json}` stdout line.
 */
export const processSample = async ({
  sample,
  prevState,
  threshold,
  url,
  dryRun,
  effects,
}: {
  sample: Sample;
  prevState: WatchState;
  threshold: number;
  url: string;
  dryRun: boolean;
  effects: TickEffects;
}): Promise<Decision> => {
  const decision = decide({ prevState, sample, threshold });

  if (decision.shouldNotifyRecovered) {
    if (dryRun) {
      effects.log({ line: `[DRY] notify RECOVERED ${sample.status}` });
    } else {
      await runSafely({
        action: () =>
          effects.notifyOwner({
            message: buildRecoveredMessage({
              status: sample.status,
              httpCode: sample.httpCode,
            }),
          }),
        label: "recovered notify",
        log: effects.log,
      });
    }
  }

  await effects.saveState({ state: decision.nextState });

  if (decision.shouldPage) {
    const regions = renderRegions({ bodyText: sample.bodyText });

    // 1. Page owner (P0) — the guaranteed win, always first.
    if (dryRun) {
      effects.log({
        line: `[DRY] notify P0 status=${sample.status} http=${sample.httpCode} regions=${regions}`,
      });
    } else {
      await runSafely({
        action: () =>
          effects.notifyOwner({
            message: buildPageMessage({
              status: sample.status,
              httpCode: sample.httpCode,
              regions,
              url,
            }),
          }),
        label: "P0 notify",
        log: effects.log,
      });
    }

    // 2. File the [Monitor] ticket — best-effort. On a SUCCESSFUL create we
    //    also emit the "ticket created" lifecycle message (JOB-731 lifecycle
    //    observability), a SECOND Telegram via the same direct plain-text path
    //    the page used. A create failure must not affect the already-sent page
    //    and must NOT emit the second message.
    if (dryRun) {
      effects.log({
        line: `[DRY] create [Monitor] ticket status=${sample.status} regions=${regions}`,
      });
      effects.log({ line: "[DRY] notify ticket-created" });
    } else {
      let identifier: string | null = null;
      try {
        identifier = await effects.createLinearTicket({
          status: sample.status,
          httpCode: sample.httpCode,
          regions,
        });
      } catch (error) {
        // Best-effort: log, never throw — same contract as runSafely. The page
        // is already sent; a Linear failure can never block it.
        effects.log({
          line: `output-watch: linear create failed: ${String(error)}`,
        });
      }
      if (identifier !== null) {
        await runSafely({
          action: () =>
            effects.notifyOwner({
              message: buildTicketCreatedMessage({ identifier }),
            }),
          label: "ticket-created notify",
          log: effects.log,
        });
      }
    }

    // 3. Wake the dispatcher now — best-effort.
    if (dryRun) {
      effects.log({ line: "[DRY] POST dispatcher /trigger" });
    } else {
      await runSafely({
        action: () => effects.triggerDispatcher(),
        label: "dispatcher trigger",
        log: effects.log,
      });
    }
  }

  effects.log({
    line: `WATCHER_HEARTBEAT ${JSON.stringify({
      ts: new Date().toISOString(),
      status: sample.status,
      http: sample.httpCode,
      bad: decision.isBad,
      count: decision.nextState.count,
      paged: decision.nextState.paged,
      pagedThisTick: decision.shouldPage,
      recovered: decision.shouldNotifyRecovered,
      dryRun,
    })}`,
  });

  // JOB-731 observability: Prometheus textfile write. Deliberately AFTER the
  // heartbeat and best-effort — additive, fail-soft, never reorders the
  // page-first flow. detectorOk mirrors the detector's own verdict (!isBad).
  if (effects.writeMetrics) {
    await runSafely({
      action: () =>
        effects.writeMetrics!({
          detectorOk: !decision.isBad,
          consecutiveBad: decision.nextState.count,
          pagedThisTick: decision.shouldPage,
          recoveredThisTick: decision.shouldNotifyRecovered,
        }),
      label: "metrics write",
      log: effects.log,
    });
  }

  return decision;
};
