import { config } from "./config";
import { ExtractedChange } from "./model";
import { ChangeStore } from "./store";

export interface PullResult { changes: ExtractedChange[]; nextCursor: number; error?: string; incomplete?: boolean }
export type Puller = (args: { since: number }) => Promise<PullResult>;
export interface PollState {
  at: string | null; ok: boolean; count: number; lastSuccess: string | null;
  error: string | null; inFlight: boolean;
}
export interface HealthSnapshot {
  ok: boolean;
  lastPollBySource: Record<string, PollState & { stale: boolean; ageMs: number | null }>;
  rowCount: number;
}

/** Freshness is based on successful coverage, never last attempt or process age.
 * A failed source retains its last successful time; startup is unready until
 * EVERY source has supplied a successful poll. Source errors never stop peers.
 */
export class PollController {
  private states: Record<string, PollState> = {};
  constructor(private store: ChangeStore, private now = Date.now, private staleMs = config.sourceStaleMs) {
    for (const source of ["github", "gcp_audit", "linear"]) this.states[source] = {
      at: null, ok: false, count: 0, lastSuccess: null, error: "not polled", inFlight: false,
    };
  }
  health = (): HealthSnapshot => {
    const lastPollBySource: HealthSnapshot["lastPollBySource"] = {};
    for (const [source, state] of Object.entries(this.states)) {
      const ageMs = state.lastSuccess ? Math.max(0, this.now() - Date.parse(state.lastSuccess)) : null;
      lastPollBySource[source] = { ...state, ageMs, stale: ageMs === null || ageMs > this.staleMs };
    }
    return { ok: Object.values(lastPollBySource).every(p => p.ok && !p.stale),
      lastPollBySource, rowCount: this.store.rowCount() };
  };
  async run({ source, puller }: { source: string; puller: Puller }): Promise<void> {
    const state = this.states[source];
    if (!state || state.inFlight) return;
    state.inFlight = true;
    state.at = new Date(this.now()).toISOString();
    try {
      const raw = this.store.getCursor(source);
      const parsed = raw ? Number(raw) : NaN;
      const since = Number.isFinite(parsed) ? parsed : this.now() - config.initialBackfillHrs * 3_600_000;
      const { changes, nextCursor, error, incomplete } = await puller({ since });
      if (!Number.isFinite(nextCursor)) throw new Error("Invalid source cursor");
      for (const change of changes) this.store.upsert(change);
      state.count = changes.length;
      // A partial poll may save useful rows, but cannot claim fresh coverage or
      // move its cursor past anything it failed to read.
      if (error) throw new Error(error);
      if (nextCursor > since) this.store.setCursor(source, String(nextCursor));
      if (incomplete) throw new Error("Source backfill incomplete; continuing next tick");
      state.ok = true;
      state.error = null;
      state.lastSuccess = new Date(this.now()).toISOString();
    } catch (error) {
      state.ok = false;
      state.error = error instanceof Error ? error.message : String(error);
      console.error(`[change-ingest] ${source} poll failed: ${state.error}`);
    } finally {
      state.inFlight = false;
    }
  }
}
