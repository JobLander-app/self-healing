/**
 * claude-code-vm-job-dispatcher configuration — fully env-driven.
 *
 * Stateless by design: there is NO database. Durable state lives in three
 * places only:
 *   1. Linear — the `In Progress` status is the concurrency claim, and the
 *      issue's terminal status (Done/Canceled/Backlog) is the outcome.
 *   2. JSONL turn traces on disk (logDir) — one file per dispatch run.
 *   3. Telegram — human-facing one-line summary per run.
 *
 * Port: handy-daemon owns :4000. We default to :4100 to avoid any collision.
 */
export declare const config: {
    readonly httpPort: number;
    readonly claudeModel: string;
    readonly claudeMaxTurns: number;
    readonly maxRunMs: number;
    readonly staleAgeHrs: number;
    readonly freshnessWindowHrs: number;
    readonly pollCron: string;
    readonly tgBotToken: string;
    readonly tgChatId: string;
    readonly linearTeam: string;
    readonly triggerToken: string;
    readonly dryRun: boolean;
    readonly logDir: string;
    readonly gcpProject: string;
    readonly nodeEnv: string;
};
export declare const LINEAR_JOB_TEAM_ID = "b12df7a0-4845-47fd-be59-8f6d03d9ae8d";
export declare const LINEAR_MONITOR_LABEL_ID = "3cf3f731-dccf-43fa-861e-cba73998b183";
export declare const LINEAR_API_KEY_SECRET = "linear-api-key";
export declare const CLAUDE_OAUTH_SECRET = "claude-code-oauth-token";
