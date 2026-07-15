/**
 * Subscription rate-limit handling.
 *
 * We stay on the Claude subscription (OAuth token), which periodically hits a
 * usage limit ("You've hit your limit · resets 4:30pm (UTC)"). When that
 * happens there is no point hammering the API every 10 min — every tick would
 * just fail. Instead we:
 *   1. record the limit-hit + the in-progress ticket (work memory) to disk,
 *   2. pause polling until the reset time the error message gives us,
 *   3. resume automatically right after the window closes (index.ts watcher).
 *
 * State is a single JSON file so it survives a daemon restart.
 */
export interface PauseState {
    until: string;
    reason: string;
    setAt: string;
    inProgressIssue?: string | null;
    rawError?: string;
}
/** Does the session error look like a subscription usage-limit hit? */
export declare function isLimitError(msg: string | null | undefined): boolean;
/**
 * Parse "...resets 4:30pm (UTC)" → next UTC Date for that wall-clock time.
 * Returns null if no parseable reset time is present.
 */
export declare function parseResetTime(msg: string, now: Date): Date | null;
/** Write the pause state (work memory) to disk. */
export declare function setPause(s: PauseState): void;
/** Current pause state if one exists on disk, else null. */
export declare function readPause(): PauseState | null;
export declare function clearPause(): void;
/** ms remaining until the pause lifts; 0 if not paused / already elapsed. */
export declare function pauseRemainingMs(now?: Date): number;
/**
 * Derive and persist a pause from a limit error. Returns the pause state.
 * Falls back to a 60-min pause if the reset time can't be parsed.
 */
export declare function pauseFromLimitError(rawError: string, inProgressIssue: string | null): PauseState;
