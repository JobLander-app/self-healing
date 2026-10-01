export type Provider = "claude" | "codex";
export type FailureKind = "quota" | "throttle" | "auth" | "unavailable" | "task" | "timeout";

/** input includes cache reads/writes; cachedInput is a subset, not additive. */
export interface TokenUsage {
  input: number | null;
  cachedInput: number | null;
  cacheWrite: number | null;
  output: number | null;
}
export const unknownUsage = (): TokenUsage => ({ input: null, cachedInput: null, cacheWrite: null, output: null });
export interface ProviderAttempt {
  id: string;
  provider: Provider;
  model: string;
  sessionId?: string;
  credentialFingerprint?: string;
  providerSkipped?: boolean;
  startedAt: string;
  finishedAt: string;
  status: "completed" | "failed";
  failureKind?: FailureKind;
  error?: string;
  usage: TokenUsage;
  rawUsage?: Record<string, number>;
  models?: Array<{ model: string; usage: TokenUsage }>;
  estimatedCostUsd: number | null;
  /**
   * claude-sdk-estimate: the SDK's `result` total_cost_usd.
   * transcript-estimate: no `result` arrived (e.g. watchdog abort); priced from
   *   streamed per-message usage with src/pricing.ts.
   * claude-sdk-plus-transcript-estimate: the SDK total plus usage streamed
   *   after the last `result`, priced the same way.
   */
  costSource: "claude-sdk-estimate" | "transcript-estimate" | "claude-sdk-plus-transcript-estimate" | "unavailable";
  turns: number;
}
export interface AttemptResult {
  attempt: ProviderAttempt;
  output: string;
  // Mutation targets observed in structured MCP calls, never an inferred claim.
  issueIds: string[];
  toolsUsed: boolean;
}
