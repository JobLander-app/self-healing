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
 * Run a single dispatch session. Returns the run summary. Never throws —
 * any failure is captured as an "error" outcome so the cron loop keeps
 * ticking.
 */
export declare function runDispatchSession(reason: string): Promise<RunSummary>;
