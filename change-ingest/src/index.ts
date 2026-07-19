/**
 * change-ingest boot (§3, §6). Opens the store, serves the read API on
 * 127.0.0.1:INGEST_PORT, and schedules the three fail-isolated node-cron
 * pollers (github 5min, gcpAudit 2min, linear 5min) + a daily 90-day prune.
 *
 * Discipline mirrors the dispatcher: single process owns all writes (single
 * writer); each poller is fail-isolated (a throw in one never stalls the
 * others — same as `runSafely` in the watcher); cursors persist after every
 * successful pull; the ingest service must never block a consumer.
 */

import * as cron from "node-cron";
import { config } from "./config";
import { ChangeStore } from "./store";
import { createApp, HealthSnapshot } from "./routes";
import { ExtractedChange } from "./model";
import { pull as pullGithub } from "./ingest/github";
import { pull as pullGcpAudit } from "./ingest/gcpAudit";
import { pull as pullLinear } from "./ingest/linear";

const DAY_MS = 24 * 60 * 60 * 1000;
// First run (no cursor yet) backfills this far. MUST cover the dispatcher's
// INTENT-GATE lookback (config.initialBackfillHrs >= dispatcher intentLookbackHrs)
// so the advertised /changes window is actually populated on a fresh VM / a
// recreated changes.db — else an explained anomaly reads as unexplained during
// the rollout window (Codex P2, PR #13). Bounded by the sources' own retention.
const INITIAL_BACKFILL_MS = config.initialBackfillHrs * 60 * 60 * 1000;

/**
 * A source poll. Returns the changes to ingest AND the timestamp the cursor
 * should advance to — each source owns its own cursor semantics, because they
 * drain differently: audit/linear go oldest-first (advance to the newest seen),
 * while GitHub pages newest-first from `now` (no server-side since-filter), so a
 * capped backfill must advance only to the OLDEST fully-scanned point, never past
 * unscanned older merges (Codex P2, PR #13). `nextCursor` must never exceed a
 * point below which coverage is complete.
 */
type PullResult = { changes: ExtractedChange[]; nextCursor: number };
type Puller = (args: { since: number }) => Promise<PullResult>;

interface PollState {
  at: string;
  ok: boolean;
  count: number;
}

const lastPollBySource: Record<string, PollState | null> = {
  github: null,
  gcp_audit: null,
  linear: null,
};

const inFlight = new Set<string>();

function makeHealth(store: ChangeStore): () => HealthSnapshot {
  return () => {
    const polls = Object.values(lastPollBySource).filter((p): p is PollState => p !== null);
    const ok = polls.length === 0 || polls.every((p) => p.ok);
    return { ok, lastPollBySource: { ...lastPollBySource }, rowCount: store.rowCount() };
  };
}

/**
 * One poll for one source. Single-flight (a slow tick never overlaps itself),
 * fail-isolated (never throws — a poller returning [] on error is the norm, but
 * we guard the store writes too). Advances the cursor to the max ingested ts.
 */
async function runPoll({ source, puller, store }: { source: string; puller: Puller; store: ChangeStore }): Promise<void> {
  if (inFlight.has(source)) {
    console.log(`[change-ingest] ${source} poll already in flight — skipping tick`);
    return;
  }
  inFlight.add(source);
  try {
    const cursorRaw = store.getCursor(source);
    const parsed = cursorRaw ? parseInt(cursorRaw, 10) : NaN;
    const since = Number.isFinite(parsed) ? parsed : Date.now() - INITIAL_BACKFILL_MS;

    const { changes, nextCursor } = await puller({ since });
    for (const change of changes) store.upsert(change);
    // Advance only forward — never let a source's cursor regress (a fail-open
    // empty pull returns nextCursor === since; a partial/capped pull returns a
    // point below which coverage is complete). Persist even when 0 changes so a
    // fully-drained window records progress.
    if (nextCursor > since) store.setCursor(source, String(nextCursor));

    lastPollBySource[source] = { at: new Date().toISOString(), ok: true, count: changes.length };
    if (changes.length > 0) console.log(`[change-ingest] ${source}: ingested ${changes.length} change(s), cursor → ${nextCursor}`);
  } catch (err) {
    lastPollBySource[source] = { at: new Date().toISOString(), ok: false, count: 0 };
    console.error(`[change-ingest] ${source} poll error (isolated):`, err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(source);
  }
}

/** Wrap a poll so a rejected promise can never escape into node-cron. */
function schedule({ expr, source, puller, store }: { expr: string; source: string; puller: Puller; store: ChangeStore }): void {
  if (!cron.validate(expr)) throw new Error(`Invalid cron for ${source}: "${expr}"`);
  cron.schedule(expr, () => {
    void runPoll({ source, puller, store }).catch((err) =>
      console.error(`[change-ingest] ${source} tick error:`, err),
    );
  });
  console.log(`[change-ingest] ${source} poller scheduled: "${expr}"`);
}

async function main(): Promise<void> {
  console.log("[change-ingest] Starting...");
  const store = new ChangeStore(config.changesDb);
  console.log(`[change-ingest] Store open at ${config.changesDb} (${store.rowCount()} rows)`);

  const app = createApp({ store, health: makeHealth(store) });

  // Initial backfill BEFORE serving. On a fresh VM / recreated changes.db the
  // feed must NOT answer `200 []` while the 72h window is still loading — the
  // dispatcher's intent gate reads an empty-but-successful response as
  // "unexplained" (not "feed unavailable") and would fix an intentional change
  // during the exact rollout window this service protects (Codex P2, PR #13).
  // Each runPoll is fail-isolated and self-bounded by its own subprocess/fetch
  // timeouts, so this await cannot hang the boot indefinitely.
  console.log("[change-ingest] Running initial backfill before serving...");
  await Promise.allSettled([
    runPoll({ source: "github", puller: pullGithub, store }),
    runPoll({ source: "gcp_audit", puller: pullGcpAudit, store }),
    runPoll({ source: "linear", puller: pullLinear, store }),
  ]);
  console.log(`[change-ingest] Initial backfill done (${store.rowCount()} rows).`);

  // Serving API — localhost only. Only now, with the feed warm.
  app.listen(config.ingestPort, "127.0.0.1", () => {
    console.log(`[change-ingest] Serving /changes + /healthz on 127.0.0.1:${config.ingestPort}`);
  });

  // Schedule the three source pollers, each fail-isolated.
  schedule({ expr: config.githubCron, source: "github", puller: pullGithub, store });
  schedule({ expr: config.gcpAuditCron, source: "gcp_audit", puller: pullGcpAudit, store });
  schedule({ expr: config.linearCron, source: "linear", puller: pullLinear, store });

  // Daily retention prune.
  if (!cron.validate(config.pruneCron)) throw new Error(`Invalid PRUNE_CRON: "${config.pruneCron}"`);
  cron.schedule(config.pruneCron, () => {
    try {
      const removed = store.prune(config.retentionDays * DAY_MS);
      if (removed > 0) console.log(`[change-ingest] prune: removed ${removed} row(s) older than ${config.retentionDays}d`);
    } catch (err) {
      console.error("[change-ingest] prune error:", err instanceof Error ? err.message : err);
    }
  });
  console.log(`[change-ingest] Prune scheduled: "${config.pruneCron}" (retention ${config.retentionDays}d)`);
  // (The initial poll of each source already ran, awaited, before serving above.)

  console.log("[change-ingest] Ready.");

  const shutdown = (signal: string) => {
    console.log(`[change-ingest] ${signal} received, closing store...`);
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[change-ingest] Fatal error:", err);
  process.exit(1);
});
