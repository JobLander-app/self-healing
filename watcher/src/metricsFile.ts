/**
 * Prometheus textfile-collector output (JOB-731 → free-core observability v1).
 *
 * The watcher is a per-minute CRON that runs and EXITS — it cannot hold an HTTP
 * server. So it uses node_exporter's textfile-collector pattern: each tick
 * writes a `.prom` file that node_exporter exposes on its own /metrics.
 *
 * Contract (all `selfheal_watcher_`):
 *   - last_tick_timestamp_seconds gauge — now; Grafana derives freshness/uptime
 *   - detector_ok gauge — 1 when the last sample was healthy, else 0
 *   - consecutive_bad gauge — current hysteresis count
 *   - pages_total / recoveries_total counters — persisted across ticks by
 *     reading the previous .prom, incrementing this tick, and writing back.
 *
 * FAIL-SOFT: if the target directory does not exist (node_exporter not
 * installed on this host) OR any read/write errors, the write is skipped
 * silently and NEVER throws — a metrics write must never break the sacred
 * page-first tick flow. Writes are atomic: temp file in the same dir + rename.
 */
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface WatcherCounters {
  pages: number;
  recoveries: number;
}

export const COUNTER_NAMES = {
  pages: "selfheal_watcher_pages_total",
  recoveries: "selfheal_watcher_recoveries_total",
} as const;

/**
 * Parse the two persisted counters out of a previously-written .prom file.
 * Missing file / unparseable / commented lines → 0 (fresh start). Never throws.
 */
export const parseCounters = ({ content }: { content: string | null }): WatcherCounters => {
  const read = (metric: string): number => {
    if (content === null) return 0;
    // A non-comment metric line: `<metric> <value>` (int or float). The `m`
    // flag anchors ^/$ per line so a `# HELP <metric> …` comment never matches.
    const re = new RegExp(`^${metric}\\s+([0-9]+(?:\\.[0-9]+)?)\\s*$`, "m");
    const match = content.match(re);
    const raw = match?.[1];
    if (raw === undefined) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    pages: read(COUNTER_NAMES.pages),
    recoveries: read(COUNTER_NAMES.recoveries),
  };
};

/** Render the full `.prom` exposition. Pure — trivially unit-testable. */
export const renderWatcherMetrics = ({
  now,
  detectorOk,
  consecutiveBad,
  counters,
}: {
  now: number; // ms epoch
  detectorOk: boolean;
  consecutiveBad: number;
  counters: WatcherCounters;
}): string => {
  const lines = [
    "# HELP selfheal_watcher_last_tick_timestamp_seconds Unix time of the last watcher tick.",
    "# TYPE selfheal_watcher_last_tick_timestamp_seconds gauge",
    `selfheal_watcher_last_tick_timestamp_seconds ${(now / 1000).toFixed(3)}`,
    "# HELP selfheal_watcher_detector_ok 1 if the last sample was healthy, else 0.",
    "# TYPE selfheal_watcher_detector_ok gauge",
    `selfheal_watcher_detector_ok ${detectorOk ? 1 : 0}`,
    "# HELP selfheal_watcher_consecutive_bad Consecutive bad samples in the current incident.",
    "# TYPE selfheal_watcher_consecutive_bad gauge",
    `selfheal_watcher_consecutive_bad ${consecutiveBad}`,
    "# HELP selfheal_watcher_pages_total Owner pages sent (monotonic).",
    "# TYPE selfheal_watcher_pages_total counter",
    `${COUNTER_NAMES.pages} ${counters.pages}`,
    "# HELP selfheal_watcher_recoveries_total Recovery notifications sent (monotonic).",
    "# TYPE selfheal_watcher_recoveries_total counter",
    `${COUNTER_NAMES.recoveries} ${counters.recoveries}`,
  ];
  return lines.join("\n") + "\n";
};

/**
 * Read the previous counters, increment for this tick's page/recovery, and
 * write the new `.prom` atomically. Fail-soft: returns silently if the target
 * directory is missing or any fs op throws.
 */
export const writeWatcherMetrics = async ({
  path,
  now,
  detectorOk,
  consecutiveBad,
  pagedThisTick,
  recoveredThisTick,
}: {
  path: string;
  now: number;
  detectorOk: boolean;
  consecutiveBad: number;
  pagedThisTick: boolean;
  recoveredThisTick: boolean;
}): Promise<void> => {
  try {
    const dir = dirname(path);
    // Fail-soft: node_exporter not installed here → no textfile dir → skip.
    if (!existsSync(dir)) return;

    let prevContent: string | null = null;
    try {
      prevContent = await readFile(path, "utf8");
    } catch {
      prevContent = null; // first tick / missing file
    }
    const prev = parseCounters({ content: prevContent });
    const counters: WatcherCounters = {
      pages: prev.pages + (pagedThisTick ? 1 : 0),
      recoveries: prev.recoveries + (recoveredThisTick ? 1 : 0),
    };

    const body = renderWatcherMetrics({ now, detectorOk, consecutiveBad, counters });

    // Atomic: write a temp file in the SAME dir (rename is atomic only within a
    // filesystem), then rename over the target. A crash mid-write leaves the
    // previous .prom intact — node_exporter never reads a torn file.
    const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}`);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
  } catch {
    // Never throw — observability must not break the tick.
  }
};
