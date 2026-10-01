/**
 * Explicit Claude price table for runs that end without an SDK `result`.
 *
 * The SDK reports `total_cost_usd` only on its `result` message. A run the
 * watchdog aborts never receives one, so before this table existed its cost
 * was recorded as null with 0 turns although it ran for 40 minutes: 6 of the 8
 * watchdog-aborted runs in the 7 days to 2026-10-01 were recorded that way,
 * and those 8 runs' real spend recomputed from the session transcripts was
 * $31.22 against $8.08 recorded.
 *
 * The rates are USD per million tokens. They reproduce the SDK's own
 * `total_cost_usd` exactly for run dispatch-2026-10-01T12-10-01-204Z-iessyc
 * ($2.8344, see test/pricing.test.ts). Only models verified that way are
 * listed: an unknown model prices to null instead of a guess.
 */
import type { TokenUsage } from "./providerTypes";

interface Rates { input: number; cacheWrite: number; cacheRead: number; output: number }

const PRICES: Readonly<Record<string, Rates>> = {
  "claude-sonnet-4-6": { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
};

/** API model ids may carry a snapshot date suffix (claude-haiku-4-5-20251001). */
export function priceFor(model: string): Rates | null {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")] ?? null;
}

/**
 * Cost of one model's usage. `usage.input` includes cache reads and writes
 * (see TokenUsage), so the uncached part is the remainder. Any unknown field
 * or unknown model yields null.
 */
export function usageCostUsd(model: string, usage: TokenUsage): number | null {
  const rates = priceFor(model);
  if (!rates || usage.input === null || usage.cachedInput === null || usage.cacheWrite === null || usage.output === null) return null;
  const uncached = usage.input - usage.cachedInput - usage.cacheWrite;
  if (uncached < 0) return null;
  return (uncached * rates.input + usage.cacheWrite * rates.cacheWrite + usage.cachedInput * rates.cacheRead + usage.output * rates.output) / 1_000_000;
}

/** Sum over models; null as soon as one model cannot be priced. */
export function modelsCostUsd(models: ReadonlyArray<{ model: string; usage: TokenUsage }>): number | null {
  let total = 0;
  for (const row of models) {
    const cost = usageCostUsd(row.model, row.usage);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}
