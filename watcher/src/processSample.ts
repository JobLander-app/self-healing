import { randomUUID } from "node:crypto";
import { decide } from "./decide.js";
import {
  buildPageMessage,
  buildRecoveredMessage,
  buildTicketCreatedMessage,
} from "./messages.js";
import { renderRegions } from "./regions.js";
import type { Decision, Sample, WatchState, WatchIncident, DeliveryAction } from "./types.js";

export interface TickEffects {
  /** Page the owner (Telegram / notify.sh). */
  notifyOwner: (input: { message: string }) => Promise<void>;
  /**
   * File or reconcile the stable incident UUID. Resolves to the created
   * issue identifier (e.g. "JOB-742") on success, or null when the create was
   * skipped (missing key) or the response carried no identifier. Throws on a
   * real create failure.
   */
  createLinearTicket: (input: {
    incidentId: string;
    status: string;
    httpCode: string;
    regions: string;
  }) => Promise<string | null>;
  /** Enqueue a durable dispatcher wakeup (POST /trigger). */
  triggerDispatcher: (input: { incidentId: string }) => Promise<void>;
  /** Atomically persist hysteresis plus delivery outbox. */
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
    pendingActions?: number;
  }) => Promise<void>;
}

/** Durable outbox: retry failed actions across cron runs and process restarts.
 * Telegram is at-least-once: an accepted send whose response was lost may be
 * repeated, always with the same incident ID. Never mark failure as delivered.
 * Linear uses that UUID as issue ID, so ambiguous creates can be reconciled.
 */
export const processSample = async ({ sample, prevState, threshold, url, dryRun, effects, now = Date.now() }: {
  sample: Sample; prevState: WatchState; threshold: number; url: string;
  dryRun: boolean; effects: TickEffects; now?: number;
}): Promise<Decision> => {
  const decision = decide({ prevState, sample, threshold });
  if (dryRun) {
    effects.log({ line: `[DRY] ${JSON.stringify(decision)}` });
    return decision; // Never consume production delivery state from a probe.
  }
  const outbox: WatchIncident[] = structuredClone(prevState.outbox ?? []);
  const state: WatchState = { ...decision.nextState, outbox };
  const newIncident = (): WatchIncident => ({ id: randomUUID(), status: sample.status,
    httpCode: sample.httpCode, regions: renderRegions({ bodyText: sample.bodyText }),
    recovered: false, delivered: {}, attempts: {}, retryAt: {} });
  if (decision.shouldPage) outbox.push(newIncident());
  if (!decision.isBad) {
    // Preserve old COUNT PAGED state during migration: no duplicate incident
    // ticket/page, but retain its recovery even if the recovery send fails.
    if (prevState.paged && !outbox.some(i => !i.recovered)) {
      const legacy = newIncident();
      legacy.delivered.page = true;
      outbox.push(legacy);
    }
    for (const incident of outbox) incident.recovered = true;
  }
  const save = () => effects.saveState({ state });
  await save(); // Persist stable IDs before issuing any external mutation.
  let pagedThisTick = false;
  let recoveredThisTick = false;
  const deliver = async (incident: WatchIncident, action: DeliveryAction, effect: () => Promise<void>) => {
    if (incident.delivered[action] || (incident.retryAt[action] ?? 0) > now) return;
    incident.attempts[action] = (incident.attempts[action] ?? 0) + 1;
    // Persist the retry deadline BEFORE sending, including the ambiguous-crash
    // case. There is no cap on attempts; failed P0s never silently expire.
    incident.retryAt[action] = now + Math.min(300_000, 60_000 * 2 ** Math.min(incident.attempts[action]! - 1, 3));
    await save();
    try {
      await effect();
      incident.delivered[action] = true;
      if (action === "page") pagedThisTick = true;
      if (action === "recovery") recoveredThisTick = true;
    } catch (error) {
      effects.log({ line: `DELIVERY_FAILED ${JSON.stringify({ incident: incident.id, action,
        attempt: incident.attempts[action], retryAt: incident.retryAt[action], error: String(error),
        semantics: action === "page" || action === "announcement" || action === "recovery" ? "at-least-once; ambiguous responses may duplicate" : "idempotent retry" })}` });
    }
    await save(); // A storage failure must abort; never continue without a checkpoint.
  };
  for (const incident of outbox) {
    const notify = (message: string) => effects.notifyOwner({ message: `${message} [incident ${incident.id}]` });
    if (incident.recovered) {
      // Never send a stale P0 or create a stale ticket after recovery. If the
      // page might have arrived (lost response), a recovery is still useful.
      if (incident.delivered.page || incident.attempts.page) {
        await deliver(incident, "recovery", () => notify(buildRecoveredMessage({ status: "pass", httpCode: "200" })));
      } else incident.delivered.recovery = true;
      continue;
    }
    await deliver(incident, "page", () => notify(buildPageMessage({ ...incident, url })));
    await deliver(incident, "ticket", async () => {
      const identifier = await effects.createLinearTicket({ ...incident, incidentId: incident.id });
      if (!identifier) throw new Error("Linear did not confirm an issue identifier");
      incident.ticketIdentifier = identifier;
    });
    if (incident.ticketIdentifier) {
      await deliver(incident, "announcement", () => notify(buildTicketCreatedMessage({ identifier: incident.ticketIdentifier! })));
      await deliver(incident, "trigger", () => effects.triggerDispatcher({ incidentId: incident.id }));
    }
  }
  state.outbox = outbox.filter(i => !i.recovered || !i.delivered.recovery);
  await save();
  const pendingActions = state.outbox.reduce((n, i) => n + (i.recovered ? Number(!i.delivered.recovery) :
    ["page", "ticket", "announcement", "trigger"].filter(a => !i.delivered[a as DeliveryAction]).length), 0);
  effects.log({ line: `WATCHER_HEARTBEAT ${JSON.stringify({ ts: new Date(now).toISOString(),
    status: sample.status, http: sample.httpCode, bad: decision.isBad, count: state.count,
    paged: state.paged, pagedThisTick, recovered: recoveredThisTick, pendingActions, dryRun })}` });
  try { await effects.writeMetrics?.({ detectorOk: !decision.isBad, consecutiveBad: state.count,
    pagedThisTick, recoveredThisTick, pendingActions }); }
  catch (error) { effects.log({ line: `output-watch: metrics write failed: ${String(error)}` }); }
  return { ...decision, nextState: state };
};
