'use strict';
//
// Off-box watchdog + alert relay for the self-healing loop.
//
// WHY IT LIVES OUTSIDE THE VM (incident 2026-08-26).
// Everything that was supposed to notice the VM was dead ran ON the VM, or
// depended on the VM's network to report:
//   - the watcher's heartbeat was shipped with `gcloud logging write`, which
//     needs the network that had died;
//   - the Cloud Monitoring dead-man alert on that heartbeat fired into an
//     email channel that has never delivered a message, and its Telegram
//     sibling posts Monitoring's incident JSON straight at api.telegram.org,
//     which answers 400 every time;
//   - and nothing at all could ACT. Recovery was a human noticing.
// The result was six days of silence with prod unmonitored.
//
// This function is the layer with none of those dependencies: it runs on Cloud
// Run (Functions gen2), reads the heartbeat from Cloud Logging, and can reset
// the instance itself. It is fully deterministic — no model, no judgment, per
// the single-provider rule in CLAUDE.md.
//
// Entry points:
//   watchdog   — HTTP, invoked by Cloud Scheduler every 5 min (OIDC-authenticated).
//   alertRelay — Pub/Sub, turns a Cloud Monitoring incident into a Telegram message.

const functions = require('@google-cloud/functions-framework');
const { loadConfig } = require('./config');
const { decide, OK } = require('./decide');
const { decideDelivery } = require('./relay-policy');
const gcp = require('./gcp');

const HEARTBEAT_TEXT = 'WATCHDOG_HEARTBEAT';

function ageSec(ms, nowMs) {
  return ms === null ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
}

function formatPage(cfg, verdict, ages, actionsTaken) {
  const lines = [];
  if (verdict.recovered) {
    lines.push(`✅ RECOVERED — self-healing loop (${cfg.instance})`);
    lines.push(`Previous state: ${verdict.previousCondition}`);
  } else {
    lines.push(`🚨 P0 self-healing loop — ${verdict.condition} (${cfg.instance})`);
    if (verdict.detail) lines.push(verdict.detail);
  }
  lines.push('');
  lines.push(`watcher heartbeat:    ${ages.watcher === null ? 'none in lookback' : ages.watcher + 's old'}`);
  lines.push(`dispatcher heartbeat: ${ages.dispatcher === null ? 'none in lookback' : ages.dispatcher + 's old'}`);
  lines.push(`alert-path canary:    ${ages.canary === null ? 'none in lookback' : Math.round(ages.canary / 3600) + 'h old'}`);
  if (actionsTaken.length) lines.push('', `Action taken: ${actionsTaken.join(', ')}`);
  for (const r of verdict.reasons) lines.push(`• ${r}`);
  return lines.join('\n');
}

async function runWatchdog() {
  const cfg = loadConfig();
  const nowMs = Date.now();

  const [watcherMs, dispatcherMs, canaryMs, instanceStatus, rawState] = await Promise.all([
    gcp.latestEntryMs({ projectId: cfg.projectId, logId: cfg.watcherLogId, lookbackSec: cfg.lookbackSec, contains: 'WATCHER_HEARTBEAT' }),
    gcp.latestEntryMs({ projectId: cfg.projectId, logId: cfg.dispatcherLogId, lookbackSec: cfg.lookbackSec, contains: 'DISPATCHER_HEARTBEAT' }),
    gcp.latestEntryMs({ projectId: cfg.projectId, logId: cfg.relayLogId, lookbackSec: cfg.lookbackSec, contains: 'RELAY_DELIVERED' }),
    gcp.getInstanceStatus({ projectId: cfg.projectId, zone: cfg.zone, instance: cfg.instance }),
    gcp.readState({ bucket: cfg.stateBucket, object: cfg.stateObject }),
  ]);

  const state = {
    condition: OK,
    resets: [],
    everSeenWatcher: false,
    everSeenDispatcher: false,
    lastPageAt: 0,
    ...rawState,
  };

  const ages = {
    watcher: ageSec(watcherMs, nowMs),
    dispatcher: ageSec(dispatcherMs, nowMs),
    canary: ageSec(canaryMs, nowMs),
  };

  // "Ever seen" is sticky and is what licenses a reset (decide.js invariant a).
  if (ages.watcher !== null && ages.watcher <= cfg.watcherPageSec) state.everSeenWatcher = true;
  if (ages.dispatcher !== null && ages.dispatcher <= cfg.dispatcherPageSec) state.everSeenDispatcher = true;
  if (ages.canary !== null && ages.canary <= cfg.canaryStaleSec) state.everSeenCanary = true;

  const verdict = decide({
    nowMs,
    watcherAgeSec: ages.watcher,
    dispatcherAgeSec: ages.dispatcher,
    canaryAgeSec: ages.canary,
    instanceStatus,
    state,
    cfg,
  });

  const actionsTaken = [];
  const failures = [];

  if (verdict.start) {
    try {
      await gcp.instanceAction({ projectId: cfg.projectId, zone: cfg.zone, instance: cfg.instance, action: 'start' });
      actionsTaken.push('instance start issued');
    } catch (err) {
      failures.push(`start failed: ${err.message}`);
    }
  }

  if (verdict.reset) {
    try {
      await gcp.instanceAction({ projectId: cfg.projectId, zone: cfg.zone, instance: cfg.instance, action: 'reset' });
      actionsTaken.push('instance RESET issued');
      state.resets = [...(state.resets || []), nowMs].filter((t) => nowMs - t < cfg.resetWindowSec * 1000);
    } catch (err) {
      failures.push(`reset failed: ${err.message}`);
    }
  }

  if (verdict.page || failures.length) {
    const text = formatPage(cfg, verdict, ages, actionsTaken) +
      (failures.length ? `\n\n⚠️ watchdog action failures:\n${failures.map((f) => '• ' + f).join('\n')}` : '');
    try {
      await gcp.sendTelegram({ token: cfg.telegramToken, chatId: cfg.telegramChatId, text });
      state.lastPageAt = nowMs;
    } catch (err) {
      failures.push(`telegram failed: ${err.message}`);
    }
  }

  state.condition = verdict.condition;
  state.updatedAt = new Date(nowMs).toISOString();
  await gcp.writeState({ bucket: cfg.stateBucket, object: cfg.stateObject, state });

  // The watchdog's own liveness. A watchdog nobody watches is the same trap
  // one level up — this line is what a "watchdog silent" alert keys on.
  await gcp.writeLogEntry({
    projectId: cfg.projectId,
    logId: cfg.watchdogLogId,
    text: `${HEARTBEAT_TEXT} condition=${verdict.condition} watcher_age=${ages.watcher} dispatcher_age=${ages.dispatcher} canary_age=${ages.canary} instance=${instanceStatus} actions=${actionsTaken.join('|') || 'none'}`,
    severity: verdict.condition === OK ? 'INFO' : 'ERROR',
  });

  return { condition: verdict.condition, ages, instanceStatus, actionsTaken, failures, reasons: verdict.reasons };
}

functions.http('watchdog', async (req, res) => {
  try {
    const result = await runWatchdog();
    res.status(result.failures.length ? 500 : 200).json(result);
  } catch (err) {
    // A crashed watchdog must be loud. Scheduler retries, and the error lands
    // in the function's logs where the "watchdog silent" alert can see it.
    console.error('watchdog run failed:', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

// ---------------------------------------------------------------------------
// Alert relay: Cloud Monitoring -> Pub/Sub -> Telegram.
//
// Monitoring's webhook channel cannot talk to the Telegram Bot API (it posts
// its own incident JSON; Telegram wants {chat_id,text} and answers 400). The
// project's Telegram channel had been failing that way, so five alert policies
// notified nobody. A Pub/Sub channel plus this relay is the fix, and it keeps
// the alert path free of any public HTTP surface.
//
// Fixing delivery is only half the job. Switching five long-silent policies to
// a channel that works made the phone unusable within a day; a channel nobody
// reads is worth as little as one that never delivers. Volume control lives in
// relay-policy.js — P0 always through, everything else once per policy per
// hour with the repeats counted.
functions.cloudEvent('alertRelay', async (cloudEvent) => {
  const cfg = loadConfig();
  const nowMs = Date.now();
  const raw = cloudEvent?.data?.message?.data
    ? Buffer.from(cloudEvent.data.message.data, 'base64').toString('utf8')
    : '{}';

  let payload = {};
  let parseError = null;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    parseError = err;
  }

  const incident = payload.incident || {};
  const isCanary = Boolean(payload.canary);
  const policyName = isCanary ? 'canary' : incident.policy_name || 'unknown policy';
  const state = String(incident.state || '').toLowerCase() === 'open' ? 'open' : 'closed';

  const store = await gcp.readState({ bucket: cfg.stateBucket, object: cfg.relayStateObject });
  const verdict = decideDelivery({
    policyName,
    state,
    isCanary,
    nowMs,
    store,
    cooldownSec: cfg.relayCooldownSec,
  });

  let text;
  if (isCanary) {
    text = `🐤 alert-path canary — ${new Date(nowMs).toISOString()}\nThis message proves Monitoring → Pub/Sub → relay → Telegram still works. Sent silently, once a day.`;
  } else if (parseError) {
    // Never drop an alert because it did not parse — forward it raw.
    text = `⚠️ Unparseable Cloud Monitoring payload:\n${raw.slice(0, 1500)}`;
  } else {
    const lines = [
      `${state === 'open' ? '🚨' : '✅'} ${state === 'open' ? 'ALERT' : 'CLOSED'} — ${policyName}`,
      incident.condition_name ? `Condition: ${incident.condition_name}` : null,
      incident.resource_name ? `Resource: ${incident.resource_name}` : null,
      incident.summary ? `\n${incident.summary}` : null,
      verdict.suppressedCount
        ? `\n(+${verdict.suppressedCount} more from this policy since the last message)`
        : null,
      incident.url ? `\n${incident.url}` : null,
    ].filter(Boolean);
    text = lines.join('\n');
  }

  // An unparseable payload bypasses the cooldown: we cannot tell what it is,
  // so we must not decide it is unimportant.
  const send = verdict.send || Boolean(parseError);

  if (send) {
    await gcp.sendTelegram({
      token: cfg.telegramToken,
      chatId: cfg.telegramChatId,
      text,
      silent: verdict.silent,
    });
  }

  await gcp.writeState({ bucket: cfg.stateBucket, object: cfg.relayStateObject, state: verdict.store });

  // Attribution. Until now nothing recorded WHICH policy produced a message,
  // so "why is my phone buzzing" could not be answered from the logs at all.
  // The canary's line is also the watchdog's proof that this path still works.
  await gcp.writeLogEntry({
    projectId: cfg.projectId,
    logId: cfg.relayLogId,
    text: isCanary && send
      ? `RELAY_DELIVERED canary ok`
      : `RELAY_INCIDENT policy="${policyName}" state=${state} sent=${send} silent=${verdict.silent} suppressed=${verdict.suppressedCount} reason="${verdict.reason}"`,
    severity: send && !verdict.silent ? 'WARNING' : 'INFO',
  });
});

module.exports = { runWatchdog, formatPage };
