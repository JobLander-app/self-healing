/** Prometheus counters replay the durable usage ledger; the recent-run ring
 * only bounds /feed and never limits lifetime accounting. USD is an SDK
 * estimate, not a subscription bill. Missing token/cost reports stay unknown.
 */
import type { RunOutcome, RunSummary } from "./trace";
import type { ProviderAttempt } from "./providerTypes";
import { accountingStatus } from "./accountingState";
import { providerReadiness } from "./providerState";
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

// The tool dependencies the healthcheck probes (healthcheck.ts PROBES).
const HEALTHCHECK_DEPS = [
  "firebase",
  "sentry",
  "gcp",
  "linear",
] as const;

// The three poller pre-check results (poller.ts PrecheckOutcome).
const PRECHECK_RESULTS: readonly PrecheckOutcome[] = ["skip", "run", "error"];

// ---------------------------------------------------------------------------
// Monotonic counters replayed from the durable ledger on startup.
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
const modelTokens = new Map<string, { provider: string; model: string; input: number; cachedInput: number; cacheWrite: number; output: number }>();
const attemptCounters = new Map<string, { provider: string; model: string; attempts: number; failures: number; input: number; cachedInput: number; cacheWrite: number; output: number; unknown: number; estimatedCost: number }>();
export function incrementAttemptCounters(a: ProviderAttempt): void {
  const key = `${a.provider}:${a.model}`;
  let c = attemptCounters.get(key);
  if (!c) { c = { provider: a.provider, model: a.model, attempts: 0, failures: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, unknown: 0, estimatedCost: 0 }; attemptCounters.set(key, c); }
  c.attempts++;
  if (a.status === "failed") c.failures++;
  if (a.usage.input === null || a.usage.output === null) c.unknown++;
  for (const row of a.models?.length ? a.models : [{ model: a.model, usage: a.usage }]) {
    const modelKey = `${a.provider}:${row.model}`;
    let tokens = modelTokens.get(modelKey);
    if (!tokens) { tokens = { provider: a.provider, model: row.model, input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }; modelTokens.set(modelKey, tokens); }
    for (const k of ["input", "cachedInput", "cacheWrite", "output"] as const) tokens[k] += row.usage[k] ?? 0;
  }
  c.estimatedCost += a.estimatedCostUsd ?? 0;
  costUsdTotal += a.estimatedCostUsd ?? 0;
}

/**
 * Increment the run counters for one completed (or rehydrated) run. Called from
 * trace.recordRun on every live run and from trace.hydrateFromDisk once per
 * on-disk run_summary at startup. An unrecognised outcome buckets to `unknown`
 * so a bad/legacy value can never be dropped silently.
 */
export function incrementRunCounters(input: { outcome: RunOutcome; costUsd: number | null; attempts?: ProviderAttempt[] }): void {
  if (Object.prototype.hasOwnProperty.call(runsByOutcome, input.outcome)) {
    runsByOutcome[input.outcome] += 1;
  } else {
    runsByOutcome.unknown += 1;
  }
  if (!input.attempts && input.costUsd !== null && Number.isFinite(input.costUsd) && input.costUsd > 0) {
    costUsdTotal += input.costUsd;
  }
}

/** Clear accumulators before a complete ledger replay (also used by tests). */
export function __resetCountersForTest(): void {
  for (const o of OUTCOMES) runsByOutcome[o] = 0;
  costUsdTotal = 0;
  attemptCounters.clear();
  modelTokens.clear();
}

export interface MetricsInput {
  busy: boolean;
  lastRun: RunSummary | null;
  lastHealthcheck: HealthcheckSnapshot | null;
  lastPrecheck: PrecheckState | null;
}

/**
 * Render Prometheus exposition with durable counters and live provider state.
 */
export function renderMetrics(input: MetricsInput): string {
  const out: string[] = [];

  out.push("# HELP selfheal_dispatcher_up Dispatcher process is up (always 1 while scrapeable).");
  out.push("# TYPE selfheal_dispatcher_up gauge");
  out.push("selfheal_dispatcher_up 1");

  out.push("# HELP selfheal_dispatcher_busy 1 if a dispatch run is currently in flight.");
  out.push("# TYPE selfheal_dispatcher_busy gauge");
  out.push(`selfheal_dispatcher_busy ${input.busy ? 1 : 0}`);

  const accounting = accountingStatus();
  if (accounting.healthy) {
    out.push("# HELP selfheal_dispatcher_runs_total Completed dispatch runs by outcome (monotonic).");
    out.push("# TYPE selfheal_dispatcher_runs_total counter");
    for (const o of OUTCOMES) {
      out.push(`selfheal_dispatcher_runs_total{outcome="${o}"} ${runsByOutcome[o]}`);
    }

    out.push("# HELP selfheal_dispatcher_cost_usd_total Cumulative estimated agent cost in USD, not billed cost; unknown estimates excluded.");
    out.push("# TYPE selfheal_dispatcher_cost_usd_total counter");
    // Format at render (accumulator stays full-precision & monotonic) to drop
    // float noise like 0.16999999999999998 → 0.17. 6dp = sub-cent resolution.
    out.push(`selfheal_dispatcher_cost_usd_total ${Number(costUsdTotal.toFixed(6))}`);

  }
  for (const [name, value] of Object.entries({ healthy: Number(accounting.healthy), warning: Number(accounting.warning), bytes: accounting.bytes, max_bytes: accounting.maxBytes, rejected_records: accounting.rejectedRecords })) {
    out.push(`# HELP selfheal_dispatcher_accounting_${name} Durable accounting storage ${name}.`, `# TYPE selfheal_dispatcher_accounting_${name} gauge`, `selfheal_dispatcher_accounting_${name} ${value}`);
  }
  const readiness = providerReadiness();
  out.push("# HELP selfheal_dispatcher_provider_ready Actual successful provider evidence still fresh, blocked or unknown is 0.", "# TYPE selfheal_dispatcher_provider_ready gauge");
  for (const p of readiness.providers) out.push(`selfheal_dispatcher_provider_ready{provider="${p.provider}"} ${p.ready ? 1 : 0}`);
  out.push("# HELP selfheal_dispatcher_ready Provider capability, fresh dependency probes and accounting storage are healthy.", "# TYPE selfheal_dispatcher_ready gauge");
  const deps = input.lastHealthcheck;
  const depsReady = !!deps && deps.healthy === deps.total && Date.now() - Date.parse(deps.at) < 7 * 3_600_000;
  out.push(`selfheal_dispatcher_ready ${readiness.ready && depsReady && accounting.healthy ? 1 : 0}`);
  // Unknown totals are absent while storage is unreadable, never fake zero.
  if (accounting.healthy) {
    const families = [
      ["attempts", "attempts", "Provider attempts"],
      ["failures", "failures", "Failed provider attempts"],
      ["usage_unknown", "unknown", "Attempts without complete usage reports"],
      ["estimated_cost_usd", "estimatedCost", "Known estimated cost in USD, not billed cost"],
    ] as const;
    for (const [name, key, help] of families) {
      const metric = `selfheal_dispatcher_provider_${name}_total`;
      out.push(`# HELP ${metric} ${help}.`, `# TYPE ${metric} counter`);
      for (const c of attemptCounters.values()) {
        const labels = `provider=${JSON.stringify(c.provider)},model=${JSON.stringify(c.model)}`;
        out.push(`${metric}{${labels}} ${Number(c[key].toFixed(6))}`);
      }
    }
    out.push("# HELP selfheal_dispatcher_provider_tokens_total Actual reported tokens; cached input and writes are subsets of input.", "# TYPE selfheal_dispatcher_provider_tokens_total counter");
    for (const c of modelTokens.values()) {
      const labels = `provider=${JSON.stringify(c.provider)},model=${JSON.stringify(c.model)}`;
      for (const kind of ["input", "cachedInput", "cacheWrite", "output"] as const) out.push(`selfheal_dispatcher_provider_tokens_total{${labels},kind="${kind}"} ${c[kind]}`);
    }
  }

  out.push(
    "# HELP selfheal_dispatcher_last_run_duration_seconds Duration of the most recent dispatch run.",
  );
  out.push("# TYPE selfheal_dispatcher_last_run_duration_seconds gauge");
  out.push(`selfheal_dispatcher_last_run_duration_seconds ${input.lastRun?.durationSec ?? 0}`);

  // Per-dependency healthcheck. Always emit all tool deps; a dep absent from the
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
