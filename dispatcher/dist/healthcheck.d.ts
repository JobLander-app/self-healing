/**
 * Dispatcher dependency healthcheck (JOB-731 follow-up).
 *
 * Ported from the proven handy-daemon pattern
 * (handy-daemon/src/healthcheck.ts) but pointed INWARD: instead of alerting a
 * human to go fix a downed MCP, on failure it files a Linear ticket that the
 * dispatcher's OWN poll loop picks up (`monitor` label) and repairs — the
 * self-healing loop healing its own toolchain.
 *
 * CRITICAL: like handy's, this runs entirely OUTSIDE the agent — plain Node
 * fetch / child_process / stdio JSON-RPC, NEVER via Claude tools. A healthcheck
 * that needed the agent to run couldn't verify the agent's dependencies.
 *
 * The five dependencies the dispatch session actually leans on:
 *   1. firebase MCP  — real Firestore reads during investigation (ADC + datastore.viewer)
 *   2. sentry MCP    — Sentry issue lookups (sentry token)
 *   3. gcp/gcloud    — `gcloud logging read` is the primary investigation channel (SA log access)
 *   4. claude-oauth  — the OAuth token the agent session authenticates with
 *   5. linear        — the work queue + the durable `In Progress` claim
 *
 * Every probe is individually try/caught and time-bounded; the whole run is
 * wrapped so a hang or throw can never wedge the poll loop or crash the daemon.
 */
export interface DepResult {
    dep: string;
    healthy: boolean;
    detail: string;
    latencyMs: number;
}
export interface HealthcheckSnapshot {
    at: string;
    results: DepResult[];
    healthy: number;
    total: number;
}
export declare function getLastHealthcheck(): HealthcheckSnapshot | null;
export declare function runHealthcheck(): Promise<HealthcheckSnapshot>;
export declare function startHealthcheckCron(): void;
