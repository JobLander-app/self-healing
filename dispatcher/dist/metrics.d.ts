/**
 * Prometheus metrics for the dispatcher (JOB-731 → free-core observability v1).
 *
 * Hand-rolled text exposition (Prometheus 0.0.4 text format). The metric set is
 * small and fixed and the dispatcher is not yet wired into CI, so a full
 * prom-client dependency buys nothing here — a few string builders are cleaner
 * and dependency-free. All names are namespaced `selfheal_dispatcher_`.
 *
 * Run counters (`runs_total{outcome}`, `cost_usd_total`) are MONOTONIC in-memory
 * counters incremented from trace.recordRun. They also rehydrate best-effort
 * from the on-disk JSONL ring on startup (trace.hydrateFromDisk reads the most
 * recent ~50 runs), so a daemon bounce doesn't zero them for recent history —
 * survives-restart is best-effort, not a guarantee. Everything else is a
 * point-in-time gauge read from the live status sources at scrape time.
 */
import type { RunOutcome, RunSummary } from "./trace";
import type { HealthcheckSnapshot } from "./healthcheck";
import type { PrecheckState } from "./poller";
/**
 * Increment the run counters for one completed (or rehydrated) run. Called from
 * trace.recordRun on every live run and from trace.hydrateFromDisk once per
 * on-disk run_summary at startup. An unrecognised outcome buckets to `unknown`
 * so a bad/legacy value can never be dropped silently.
 */
export declare function incrementRunCounters(input: {
    outcome: RunOutcome;
    costUsd: number;
}): void;
/** Test-only reset so the module's global counters don't leak across cases. */
export declare function __resetCountersForTest(): void;
export interface MetricsInput {
    busy: boolean;
    lastRun: RunSummary | null;
    lastHealthcheck: HealthcheckSnapshot | null;
    lastPrecheck: PrecheckState | null;
}
/**
 * Render the full Prometheus text exposition for the dispatcher. Pure: all
 * live state is passed in, so this is trivially unit-testable.
 */
export declare function renderMetrics(input: MetricsInput): string;
