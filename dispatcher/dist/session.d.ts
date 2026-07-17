/**
 * The dispatch session — mirrors handy-daemon's executeTask/query() loop.
 *
 * A single run spawns ONE Claude Agent SDK session whose system prompt is the
 * local CLAUDE.md constitution. The agent does the whole loop autonomously:
 * pick one Linear ticket → claim it (In Progress) → investigate → reach a
 * terminal outcome (fix+merge, prove-it's-noise, or — only for genuine
 * dead-ends — return to Backlog). There is exactly one in-flight session at a
 * time, guarded by the module-level `busy` lock.
 */
import { type RunSummary } from "./trace";
export declare function isBusy(): boolean;
export declare function getCurrentTurnId(): string | null;
/**
 * Build the lifecycle-observability Telegram for a completed run (JOB-731).
 * Returns null when the run should stay silent:
 *   - "no-work" ticks (a message every ~10 min would be spam; the poller
 *     pre-check already suppresses most of these before they even run), and
 *   - runs that never picked a ticket (no issueId) — e.g. a startup error —
 *     which would otherwise spam ⚠️ on every tick.
 *
 * Three visible outcomes, keyed off the structured RunSummary fields only
 * (no free-text parsing beyond what the run already structured):
 *   🚀 in prod   — fixed+merged (auto-merge → Cloud Build deploys main).
 *   ✅ investigated — closed without a prod code change (not-a-bug/stale/
 *                    fixed-elsewhere).
 *   ⚠️ needs eyes — dead-end (backlogged) / error / timeout / unknown.
 * DRY_RUN runs are prefixed with "[DRY_RUN] ".
 */
export declare function buildRunNotification(s: RunSummary): string | null;
/**
 * Run a single dispatch session. Returns the run summary. Never throws —
 * any failure is captured as an "error" outcome so the cron loop keeps
 * ticking.
 */
export declare function runDispatchSession(reason: string): Promise<RunSummary>;
