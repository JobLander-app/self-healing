'use strict';
//
// What the alert relay is allowed to put on someone's phone.
//
// WHY THIS EXISTS. Repointing every policy in the project at a channel that
// actually delivers (2026-09-02) turned five silent policies into five loud
// ones overnight, and the owner's verdict on the result was "это было оч плохо".
// A channel nobody reads is worth as little as a channel that never delivers —
// the failure this whole change set started from. So delivery is not the end of
// the job; volume control is part of it.
//
// The rules:
//   * P0 always goes through, open and closed, no cooldown. If we ever suppress
//     a P0 we have rebuilt the original outage.
//   * Everything else is rate-limited per policy. Repeats inside the cooldown
//     are counted, not dropped: the next message that does go out says how many
//     it stands for.
//   * A "closed" for a non-P0 alert is only worth sending if its "open" was
//     sent. An all-clear for an alarm you never heard is pure noise.
//   * A canary is delivered silently (Telegram disable_notification) — it must
//     prove the whole path end to end without buzzing anyone.

const P0 = /\bP0\b/i;

function isP0(policyName) {
  return P0.test(String(policyName || ''));
}

/**
 * @param {object} input
 * @param {string} input.policyName
 * @param {'open'|'closed'} input.state
 * @param {boolean} [input.isCanary]
 * @param {number} input.nowMs
 * @param {object} input.store        persisted { policies: { [name]: {...} } }
 * @param {number} input.cooldownSec
 * @returns {{send:boolean, silent:boolean, suppressedCount:number, reason:string, store:object}}
 */
function decideDelivery({ policyName, state, isCanary = false, nowMs, store, cooldownSec }) {
  const next = { ...store, policies: { ...(store.policies || {}) } };

  if (isCanary) {
    next.lastCanaryAt = nowMs;
    return { send: true, silent: true, suppressedCount: 0, reason: 'canary (silent)', store: next };
  }

  const key = String(policyName || 'unknown');
  const rec = { lastSentAt: 0, lastSentState: null, suppressed: 0, ...(next.policies[key] || {}) };

  if (isP0(key)) {
    next.policies[key] = { ...rec, lastSentAt: nowMs, lastSentState: state, suppressed: 0 };
    return { send: true, silent: false, suppressedCount: rec.suppressed, reason: 'P0 — never rate-limited', store: next };
  }

  if (state === 'closed') {
    if (rec.lastSentState !== 'open') {
      next.policies[key] = { ...rec, suppressed: rec.suppressed + 1 };
      return { send: false, silent: false, suppressedCount: 0, reason: 'all-clear for an alarm that was never sent', store: next };
    }
    next.policies[key] = { ...rec, lastSentAt: nowMs, lastSentState: 'closed', suppressed: 0 };
    return { send: true, silent: false, suppressedCount: 0, reason: 'closing an alert that was sent', store: next };
  }

  const age = nowMs - Number(rec.lastSentAt || 0);
  if (rec.lastSentAt && age < cooldownSec * 1000) {
    next.policies[key] = { ...rec, suppressed: rec.suppressed + 1 };
    return {
      send: false,
      silent: false,
      suppressedCount: rec.suppressed + 1,
      reason: `within ${Math.round(cooldownSec / 60)} min cooldown (${Math.round(age / 60000)} min since last)`,
      store: next,
    };
  }

  next.policies[key] = { ...rec, lastSentAt: nowMs, lastSentState: 'open', suppressed: 0 };
  return { send: true, silent: false, suppressedCount: rec.suppressed, reason: 'first, or cooldown elapsed', store: next };
}

module.exports = { decideDelivery, isP0 };
