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
import type { PrecheckOutcome, PrecheckState } from "./poller";

// Full outcome set — emitted even at 0 so Grafana always sees every series.
const OUTCOMES: readonly RunOutcome[] = [
  "fixed",
  "not-a-bug",
  "stale",
  "fixed-elsewhere",
  "intentional",
  "backlogged",
  "no-work",
  "error",
  "unknown",
];

// The five dependencies the healthcheck probes (healthcheck.ts PROBES).
const HEALTHCHECK_DEPS = [
  "firebase",
  "sentry",
  "gcp",
  "claude-oauth-token",
  "linear",
] as const;

// The three poller pre-check results (poller.ts PrecheckOutcome).
const PRECHECK_RESULTS: readonly PrecheckOutcome[] = ["skip", "run", "error"];

// ---------------------------------------------------------------------------
// Monotonic counters (process lifetime; best-effort rehydrated on startup).
// ---------------------------------------------------------------------------
const runsByOutcome: Record<RunOutcome, number> = {
  fixed: 0,
  "not-a-bug": 0,
  stale: 0,
  "fixed-elsewhere": 0,
  intentional: 0,
  backlogged: 0,
  "no-work": 0,
  error: 0,
  unknown: 0,
};
let costUsdTotal = 0;

/**
 * Increment the run counters for one completed (or rehydrated) run. Called from
 * trace.recordRun on every live run and from trace.hydrateFromDisk once per
 * on-disk run_summary at startup. An unrecognised outcome buckets to `unknown`
 * so a bad/legacy value can never be dropped silently.
 */
export function incrementRunCounters(input: { outcome: RunOutcome; costUsd: number }): void {
  if (Object.prototype.hasOwnProperty.call(runsByOutcome, input.outcome)) {
    runsByOutcome[input.outcome] += 1;
  } else {
    runsByOutcome.unknown += 1;
  }
  if (Number.isFinite(input.costUsd) && input.costUsd > 0) {
    costUsdTotal += input.costUsd;
  }
}

/** Test-only reset so the module's global counters don't leak across cases. */
export function __resetCountersForTest(): void {
  for (const o of OUTCOMES) runsByOutcome[o] = 0;
  costUsdTotal = 0;
}

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
export function renderMetrics(input: MetricsInput): string {
  const out: string[] = [];

  out.push("# HELP selfheal_dispatcher_up Dispatcher process is up (always 1 while scrapeable).");
  out.push("# TYPE selfheal_dispatcher_up gauge");
  out.push("selfheal_dispatcher_up 1");

  out.push("# HELP selfheal_dispatcher_busy 1 if a dispatch run is currently in flight.");
  out.push("# TYPE selfheal_dispatcher_busy gauge");
  out.push(`selfheal_dispatcher_busy ${input.busy ? 1 : 0}`);

  out.push("# HELP selfheal_dispatcher_runs_total Completed dispatch runs by outcome (monotonic).");
  out.push("# TYPE selfheal_dispatcher_runs_total counter");
  for (const o of OUTCOMES) {
    out.push(`selfheal_dispatcher_runs_total{outcome="${o}"} ${runsByOutcome[o]}`);
  }

  out.push("# HELP selfheal_dispatcher_cost_usd_total Cumulative agent cost in USD (monotonic).");
  out.push("# TYPE selfheal_dispatcher_cost_usd_total counter");
  // Format at render (accumulator stays full-precision & monotonic) to drop
  // float noise like 0.16999999999999998 → 0.17. 6dp = sub-cent resolution.
  out.push(`selfheal_dispatcher_cost_usd_total ${Number(costUsdTotal.toFixed(6))}`);

  out.push(
    "# HELP selfheal_dispatcher_last_run_duration_seconds Duration of the most recent dispatch run.",
  );
  out.push("# TYPE selfheal_dispatcher_last_run_duration_seconds gauge");
  out.push(`selfheal_dispatcher_last_run_duration_seconds ${input.lastRun?.durationSec ?? 0}`);

  // Per-dependency healthcheck. Always emit all five deps; a dep absent from the
  // last snapshot (or no snapshot yet) reads 0 = not-known-healthy.
  out.push(
    "# HELP selfheal_dispatcher_healthcheck_dep Per-dependency healthcheck result (1 healthy, 0 down/unknown).",
  );
  out.push("# TYPE selfheal_dispatcher_healthcheck_dep gauge");
  const byDep = new Map<string, boolean>();
  for (const r of input.lastHealthcheck?.results ?? []) byDep.set(r.dep, r.healthy);
  for (const dep of HEALTHCHECK_DEPS) {
    out.push(`selfheal_dispatcher_healthcheck_dep{dep="${dep}"} ${byDep.get(dep) ? 1 : 0}`);
  }

  out.push(
    "# HELP selfheal_dispatcher_healthcheck_healthy Number of healthy dependencies in the last healthcheck.",
  );
  out.push("# TYPE selfheal_dispatcher_healthcheck_healthy gauge");
  out.push(`selfheal_dispatcher_healthcheck_healthy ${input.lastHealthcheck?.healthy ?? 0}`);

  out.push(
    "# HELP selfheal_dispatcher_healthcheck_total Number of dependencies probed in the last healthcheck.",
  );
  out.push("# TYPE selfheal_dispatcher_healthcheck_total gauge");
  out.push(`selfheal_dispatcher_healthcheck_total ${input.lastHealthcheck?.total ?? 0}`);

  // Last poll pre-check: exactly one result label = 1, the rest 0. All 0 until
  // the first pre-checked tick.
  out.push(
    "# HELP selfheal_dispatcher_last_precheck Most recent poll pre-check result (1 for the active result).",
  );
  out.push("# TYPE selfheal_dispatcher_last_precheck gauge");
  const active = input.lastPrecheck?.result;
  for (const r of PRECHECK_RESULTS) {
    out.push(`selfheal_dispatcher_last_precheck{result="${r}"} ${active === r ? 1 : 0}`);
  }

  return out.join("\n") + "\n";
}
