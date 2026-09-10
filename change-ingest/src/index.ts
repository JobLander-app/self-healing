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
import { createApp } from "./routes";
import { PollController, Puller } from "./poll";
import { pull as pullGithub } from "./ingest/github";
import { pull as pullGcpAudit } from "./ingest/gcpAudit";
import { pull as pullLinear } from "./ingest/linear";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Wrap a poll so a rejected promise can never escape into node-cron. */
function schedule({ expr, source, puller, polls }: { expr: string; source: string; puller: Puller; polls: PollController }): void {
  if (!cron.validate(expr)) throw new Error(`Invalid cron for ${source}: "${expr}"`);
  cron.schedule(expr, () => {
    void polls.run({ source, puller }).catch((err) =>
      console.error(`[change-ingest] ${source} tick error:`, err),
    );
  });
  console.log(`[change-ingest] ${source} poller scheduled: "${expr}"`);
}

async function main(): Promise<void> {
  console.log("[change-ingest] Starting...");
  const store = new ChangeStore(config.changesDb);
  console.log(`[change-ingest] Store open at ${config.changesDb} (${store.rowCount()} rows)`);

  const polls = new PollController(store);
  const app = createApp({ store, health: polls.health });

  // Serving API — localhost only. Only now, with the feed warm.
  app.listen(config.ingestPort, "127.0.0.1", () => {
    console.log(`[change-ingest] Serving /changes + /healthz on 127.0.0.1:${config.ingestPort}`);
  });

  // Initial backfill BEFORE serving. On a fresh VM / recreated changes.db the
  // feed must NOT answer `200 []` while the 72h window is still loading — the
  // dispatcher's intent gate reads an empty-but-successful response as
  // "unexplained" (not "feed unavailable") and would fix an intentional change
  // during the exact rollout window this service protects (Codex P2, PR #13).
  // Each runPoll is fail-isolated and self-bounded by its own subprocess/fetch
  // timeouts, so this await cannot hang the boot indefinitely.
  console.log("[change-ingest] Running initial backfill before serving...");
  await Promise.allSettled([
    polls.run({ source: "github", puller: pullGithub }),
    polls.run({ source: "gcp_audit", puller: pullGcpAudit }),
    polls.run({ source: "linear", puller: pullLinear }),
  ]);
  console.log(`[change-ingest] Initial backfill done (${store.rowCount()} rows).`);

  // Schedule the three source pollers, each fail-isolated.
  schedule({ expr: config.githubCron, source: "github", puller: pullGithub, polls });
  schedule({ expr: config.gcpAuditCron, source: "gcp_audit", puller: pullGcpAudit, polls });
  schedule({ expr: config.linearCron, source: "linear", puller: pullLinear, polls });

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
