import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COUNTER_NAMES,
  parseCounters,
  renderWatcherMetrics,
  writeWatcherMetrics,
} from "../src/metricsFile.js";

describe("watcher Prometheus textfile writer (JOB-731)", () => {
  it("renders valid Prometheus 0.0.4 text: HELP+TYPE+value per metric", () => {
    const out = renderWatcherMetrics({
      now: 1_700_000_000_000,
      detectorOk: true,
      consecutiveBad: 0,
      counters: { pages: 2, recoveries: 1 },
    });
    // Ends with a trailing newline (exposition format requirement).
    expect(out.endsWith("\n")).toBe(true);
    // Every metric carries HELP + TYPE.
    for (const metric of [
      "selfheal_watcher_last_tick_timestamp_seconds",
      "selfheal_watcher_detector_ok",
      "selfheal_watcher_consecutive_bad",
      COUNTER_NAMES.pages,
      COUNTER_NAMES.recoveries,
    ]) {
      expect(out).toContain(`# HELP ${metric} `);
      expect(out).toContain(`# TYPE ${metric} `);
    }
    // Types are correct.
    expect(out).toContain("# TYPE selfheal_watcher_last_tick_timestamp_seconds gauge");
    expect(out).toContain(`# TYPE ${COUNTER_NAMES.pages} counter`);
    // Values render as expected.
    expect(out).toContain("selfheal_watcher_last_tick_timestamp_seconds 1700000000.000");
    expect(out).toContain("selfheal_watcher_detector_ok 1");
    expect(out).toContain("selfheal_watcher_consecutive_bad 0");
    expect(out).toContain(`${COUNTER_NAMES.pages} 2`);
    expect(out).toContain(`${COUNTER_NAMES.recoveries} 1`);
    // detector_ok false → 0.
    expect(
      renderWatcherMetrics({
        now: 0,
        detectorOk: false,
        consecutiveBad: 3,
        counters: { pages: 0, recoveries: 0 },
      }),
    ).toContain("selfheal_watcher_detector_ok 0");
  });

  it("parses counters out of a rendered file and ignores HELP/HELP-collisions", () => {
    const rendered = renderWatcherMetrics({
      now: 1_700_000_000_000,
      detectorOk: true,
      consecutiveBad: 0,
      counters: { pages: 7, recoveries: 4 },
    });
    expect(parseCounters({ content: rendered })).toEqual({ pages: 7, recoveries: 4 });
    // Missing / garbage → zeros (fresh start).
    expect(parseCounters({ content: null })).toEqual({ pages: 0, recoveries: 0 });
    expect(parseCounters({ content: "garbage\n# HELP x\n" })).toEqual({
      pages: 0,
      recoveries: 0,
    });
  });

  it("writes atomically: target exists with correct content, no leftover temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watcher-metrics-"));
    const path = join(dir, "selfheal_watcher.prom");
    try {
      await writeWatcherMetrics({
        path,
        now: 1_700_000_000_000,
        detectorOk: true,
        consecutiveBad: 0,
        pagedThisTick: false,
        recoveredThisTick: false,
      });
      const body = await readFile(path, "utf8");
      expect(body).toContain("selfheal_watcher_detector_ok 1");
      // No `.tmp-*` sidecar left behind after the rename.
      const entries = await readdir(dir);
      expect(entries.filter((e) => e.includes(".tmp-"))).toHaveLength(0);
      expect(entries).toContain("selfheal_watcher.prom");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is fail-soft when the target directory does not exist (no throw, no file)", async () => {
    const missing = join(tmpdir(), `watcher-metrics-missing-${process.pid}-${Date.now()}`);
    const path = join(missing, "nested", "selfheal_watcher.prom");
    // Must resolve (not reject) and write nothing.
    await expect(
      writeWatcherMetrics({
        path,
        now: Date.now(),
        detectorOk: false,
        consecutiveBad: 5,
        pagedThisTick: true,
        recoveredThisTick: false,
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(path, "utf8")).rejects.toBeTruthy();
  });

  it("persists counters across ticks: increments on page/recovery, holds otherwise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "watcher-metrics-persist-"));
    const path = join(dir, "selfheal_watcher.prom");
    try {
      const tick = async (input: {
        pagedThisTick: boolean;
        recoveredThisTick: boolean;
      }): Promise<{ pages: number; recoveries: number }> => {
        await writeWatcherMetrics({
          path,
          now: Date.now(),
          detectorOk: true,
          consecutiveBad: 0,
          pagedThisTick: input.pagedThisTick,
          recoveredThisTick: input.recoveredThisTick,
        });
        return parseCounters({ content: await readFile(path, "utf8") });
      };

      // Fresh start → 0/0.
      expect(await tick({ pagedThisTick: false, recoveredThisTick: false })).toEqual({
        pages: 0,
        recoveries: 0,
      });
      // A page tick → pages 1.
      expect(await tick({ pagedThisTick: true, recoveredThisTick: false })).toEqual({
        pages: 1,
        recoveries: 0,
      });
      // A quiet tick holds the counter.
      expect(await tick({ pagedThisTick: false, recoveredThisTick: false })).toEqual({
        pages: 1,
        recoveries: 0,
      });
      // A recovery tick → recoveries 1, pages held.
      expect(await tick({ pagedThisTick: false, recoveredThisTick: true })).toEqual({
        pages: 1,
        recoveries: 1,
      });
      // Both in one tick → both increment.
      expect(await tick({ pagedThisTick: true, recoveredThisTick: true })).toEqual({
        pages: 2,
        recoveries: 2,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
