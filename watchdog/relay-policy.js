'use strict';

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
