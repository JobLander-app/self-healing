/**
 * Outbound Telegram via the Bot API directly (no MCP hop).
 *
 * Adapted from handy-daemon/src/notify.ts. Two things matter:
 *
 *   1. Unforgeable sender identity prefix `[dispatcher]` on every message —
 *      the Owner shares one TG inbox with Beacon, Symphony, Handy, Monitor,
 *      etc., and the 2026-04 Ghost Orchestrator incident happened precisely
 *      because multiple agents wrote with no visible identity. Do not remove.
 *   2. 4096-char Telegram limit — chunk at paragraph boundaries.
 */
export declare function sendTelegram(message: string): Promise<boolean>;
