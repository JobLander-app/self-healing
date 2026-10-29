/** USD per million tokens; unknown models remain unpriced. Estimates are not invoices. */
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
