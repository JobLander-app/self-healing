/**
 * The self-poll cron. Replaces handy-daemon's webhook trigger.
 *
 * Every POLL_CRON tick (default every 10 min) and once on startup, we fire a
 * dispatch session — but only if one is not already in flight. This is the
 * polling model our own research (docs/tasks/symphony-research/linear-integration.md)
 * concluded is the right pattern: re-poll Linear, rediscover work, no
 * persistent orchestrator state. Linear's `In Progress` status is the durable
 * claim; we keep nothing in memory that we can't rebuild from a re-poll.
 */
/**
 * One poll tick. Skips if a dispatch session is already running (single
 * concurrency). Safe to call from cron or from the /trigger endpoint.
 * Never throws.
 */
export declare function pollOnce(reason: string): Promise<{
    ran: boolean;
    note: string;
}>;
export declare function startPollCron(): void;
export declare function stopPollCron(): void;
/**
 * Watch for a rate-limit pause to expire and resume work *immediately* (within
 * 60s), rather than waiting up to a full POLL_CRON interval. Only acts at the
 * moment a pause elapses; otherwise the normal cron drives polling.
 */
export declare function startResumeWatcher(): void;
