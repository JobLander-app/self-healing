'use strict';
//
// Configuration parsing for the watchdog.
//
// Every number is validated at the boundary and every failure is LOUD. The
// self-healing repo has been burned three times by the opposite (2026-07-28
// review): an unparsed env var became NaN, every comparison against it was
// false, the check silently passed, and a detector built to catch silent
// failure failed silently itself. A watchdog that no-ops because of a typo in
// a Terraform variable is worse than no watchdog, because it looks alive.

/** @throws if the value is missing, non-numeric, or out of range. */
function intFromEnv(env, name, { min, max, fallback } = {}) {
  // Trim first, then treat whitespace-only exactly like absent — a variable
  // set to " " by a template is a missing value, not a malformed number.
  const raw = env[name] === undefined ? undefined : String(env[name]).trim();
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`config: ${name} is required`);
    return fallback;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`config: ${name}="${raw}" is not an integer`);
  }
  const n = Number.parseInt(raw, 10);
  if (min !== undefined && n < min) throw new Error(`config: ${name}=${n} below minimum ${min}`);
  if (max !== undefined && n > max) throw new Error(`config: ${name}=${n} above maximum ${max}`);
  return n;
}

/** @throws if the value is missing or empty. */
function strFromEnv(env, name, { fallback } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') {
    if (fallback === undefined) throw new Error(`config: ${name} is required`);
    return fallback;
  }
  return String(raw).trim();
}

function loadConfig(env = process.env) {
  const cfg = {
    projectId: strFromEnv(env, 'PROJECT_ID'),
    zone: strFromEnv(env, 'VM_ZONE'),
    instance: strFromEnv(env, 'VM_NAME'),

    // Log ids the VM writes its heartbeats to (see deploy/cron/self-healing.crontab).
    watcherLogId: strFromEnv(env, 'WATCHER_LOG_ID'),
    dispatcherLogId: strFromEnv(env, 'DISPATCHER_LOG_ID'),
    watchdogLogId: strFromEnv(env, 'WATCHDOG_LOG_ID', { fallback: 'self-healing-watchdog' }),

    // The watcher ticks every minute; the dispatcher heartbeat every 5.
    // Page thresholds are deliberately several times the tick interval so a
    // slow minute, a live migration or a Cloud Logging ingest delay cannot
    // page. Reset thresholds are higher still — a reset is destructive to any
    // in-flight investigation, so it must mean "this is not coming back".
    watcherPageSec: intFromEnv(env, 'WATCHER_PAGE_SEC', { min: 120, max: 86400, fallback: 600 }),
    watcherResetSec: intFromEnv(env, 'WATCHER_RESET_SEC', { min: 300, max: 86400, fallback: 900 }),
    dispatcherPageSec: intFromEnv(env, 'DISPATCHER_PAGE_SEC', { min: 300, max: 86400, fallback: 1800 }),
    dispatcherResetSec: intFromEnv(env, 'DISPATCHER_RESET_SEC', { min: 600, max: 86400, fallback: 3600 }),

    // Reset budget. A watchdog that can reset without limit is a machine for
    // turning one bug into a reboot loop.
    resetCooldownSec: intFromEnv(env, 'RESET_COOLDOWN_SEC', { min: 300, max: 86400, fallback: 1800 }),
    resetMaxPerWindow: intFromEnv(env, 'RESET_MAX_PER_WINDOW', { min: 1, max: 20, fallback: 3 }),
    resetWindowSec: intFromEnv(env, 'RESET_WINDOW_SEC', { min: 3600, max: 604800, fallback: 21600 }),

    stateBucket: strFromEnv(env, 'STATE_BUCKET'),
    stateObject: strFromEnv(env, 'STATE_OBJECT', { fallback: 'watchdog-state.json' }),

    telegramToken: strFromEnv(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: strFromEnv(env, 'TELEGRAM_CHAT_ID'),

    // How far back to look for the newest heartbeat. Bounds the Logging query.
    lookbackSec: intFromEnv(env, 'LOOKBACK_SEC', { min: 3600, max: 604800, fallback: 172800 }),

    // Relay volume control. One message per policy per hour by default; P0 is
    // exempt. See watchdog/relay-policy.js for why this is not optional.
    relayCooldownSec: intFromEnv(env, 'RELAY_COOLDOWN_SEC', { min: 60, max: 86400, fallback: 3600 }),
    relayStateObject: strFromEnv(env, 'RELAY_STATE_OBJECT', { fallback: 'relay-state.json' }),
    relayLogId: strFromEnv(env, 'RELAY_LOG_ID', { fallback: 'self-healing-relay' }),

    // How stale the canary's proof of delivery may get before the watchdog
    // pages. The canary runs daily; 30h tolerates one missed run plus slack.
    canaryStaleSec: intFromEnv(env, 'CANARY_STALE_SEC', { min: 3600, max: 604800, fallback: 108000 }),
  };

  if (cfg.watcherResetSec < cfg.watcherPageSec) {
    throw new Error('config: WATCHER_RESET_SEC must be >= WATCHER_PAGE_SEC (page before you reset)');
  }
  if (cfg.dispatcherResetSec < cfg.dispatcherPageSec) {
    throw new Error('config: DISPATCHER_RESET_SEC must be >= DISPATCHER_PAGE_SEC');
  }
  return cfg;
}

module.exports = { loadConfig, intFromEnv, strFromEnv };
