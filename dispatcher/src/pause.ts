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

import * as fs from "fs";
import * as path from "path";
import { config } from "./config";

// Sits next to the turn traces: /var/log/claude-code-vm-job-dispatcher/pause.json
const PAUSE_FILE = path.join(path.dirname(config.logDir), "pause.json");

export interface PauseState {
  until: string;
  reason: string;
  setAt: string;
  inProgressIssue?: string | null;
  rawError?: string;
}

/** Does the session error look like a subscription usage-limit hit? */
export function isLimitError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /hit your limit|usage limit|resets?\s+\d|rate.?limit|too many requests|\b429\b/i.test(msg);
}

/**
 * Parse "...resets 4:30pm (UTC)" → next UTC Date for that wall-clock time.
 * Returns null if no parseable reset time is present.
 */
export function parseResetTime(msg: string, now: Date): Date | null {
  const m = msg.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(UTC\))?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0));
  // If that wall-clock time already passed today, it's tomorrow's reset.
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  // Small buffer so we resume just *after* the window actually clears.
  reset.setUTCMinutes(reset.getUTCMinutes() + 2);
  return reset;
}

/** Write the pause state (work memory) to disk. */
export function setPause(s: PauseState): void {
  try {
    fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
    fs.writeFileSync(PAUSE_FILE, JSON.stringify(s, null, 2));
    console.log(`[pause] Paused until ${s.until} — ${s.reason}`);
  } catch (err) {
    console.error("[pause] Failed to write pause state:", err);
  }
}

/** Current pause state if one exists on disk, else null. */
export function readPause(): PauseState | null {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return null;
    return JSON.parse(fs.readFileSync(PAUSE_FILE, "utf-8")) as PauseState;
  } catch {
    return null;
  }
}

export function clearPause(): void {
  try {
    if (fs.existsSync(PAUSE_FILE)) fs.unlinkSync(PAUSE_FILE);
    console.log("[pause] Cleared — resuming normal polling.");
  } catch (err) {
    console.error("[pause] Failed to clear pause state:", err);
  }
}

/** ms remaining until the pause lifts; 0 if not paused / already elapsed. */
export function pauseRemainingMs(now: Date = new Date()): number {
  const p = readPause();
  if (!p) return 0;
  const rem = new Date(p.until).getTime() - now.getTime();
  return rem > 0 ? rem : 0;
}

/**
 * Derive and persist a pause from a limit error. Returns the pause state.
 * Falls back to a 60-min pause if the reset time can't be parsed.
 */
export function pauseFromLimitError(rawError: string, inProgressIssue: string | null): PauseState {
  const now = new Date();
  const reset = parseResetTime(rawError, now) || new Date(now.getTime() + 60 * 60 * 1000);
  const s: PauseState = {
    until: reset.toISOString(),
    reason: `subscription limit hit; auto-resume at reset`,
    setAt: now.toISOString(),
    inProgressIssue: inProgressIssue ?? null,
    rawError: rawError.slice(0, 300),
  };
  setPause(s);
  return s;
}
