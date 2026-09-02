'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decideDelivery, isP0 } = require('../relay-policy');

const NOW = Date.parse('2026-09-02T12:00:00Z');
const COOLDOWN = 3600;
const base = { nowMs: NOW, store: {}, cooldownSec: COOLDOWN };

test('a P0 always goes through, and is never rate-limited', () => {
  let store = {};
  for (let i = 0; i < 5; i++) {
    const r = decideDelivery({ ...base, policyName: 'P0: No meetings saved for 4h', state: 'open', nowMs: NOW + i * 1000, store });
    assert.equal(r.send, true, 'suppressing a P0 rebuilds the outage this repo exists to prevent');
    store = r.store;
  }
});

test('a noisy non-P0 policy is sent once per cooldown, repeats are counted', () => {
  let r = decideDelivery({ ...base, policyName: 'LiveKit Voice Agent Errors', state: 'open' });
  assert.equal(r.send, true);

  let store = r.store;
  for (let i = 1; i <= 9; i++) {
    r = decideDelivery({ ...base, policyName: 'LiveKit Voice Agent Errors', state: 'open', nowMs: NOW + i * 60_000, store });
    assert.equal(r.send, false, `repeat ${i} must be suppressed`);
    store = r.store;
  }
  // Past the cooldown the next one goes out and reports what it stands for.
  r = decideDelivery({ ...base, policyName: 'LiveKit Voice Agent Errors', state: 'open', nowMs: NOW + 3601_000, store });
  assert.equal(r.send, true);
  assert.equal(r.suppressedCount, 9, 'the message must say how many it stands for');
});

test('an all-clear is dropped when its alarm was never sent', () => {
  const r = decideDelivery({ ...base, policyName: 'Voice Agent JOB_SHUTDOWN Alert', state: 'closed' });
  assert.equal(r.send, false);
  assert.match(r.reason, /never sent/);
});

test('an all-clear is sent when its alarm was sent', () => {
  const opened = decideDelivery({ ...base, policyName: 'JobLander Cloud Run 5xx Alert', state: 'open' });
  const closed = decideDelivery({ ...base, policyName: 'JobLander Cloud Run 5xx Alert', state: 'closed', nowMs: NOW + 120_000, store: opened.store });
  assert.equal(closed.send, true);
});

test('a P0 all-clear is always sent, even with no prior open in this state', () => {
  const r = decideDelivery({ ...base, policyName: 'P0: self-healing watcher heartbeat absent', state: 'closed' });
  assert.equal(r.send, true);
});

test('the canary is delivered silently and does not disturb per-policy state', () => {
  const r = decideDelivery({ ...base, policyName: 'canary', state: 'open', isCanary: true });
  assert.equal(r.send, true);
  assert.equal(r.silent, true, 'the canary must prove the path without buzzing a phone');
  assert.equal(r.store.lastCanaryAt, NOW);
  assert.deepEqual(r.store.policies, {});
});

test('P0 detection matches how this project names its policies', () => {
  assert.equal(isP0('P0: No meetings saved for 4h (product-level STT outage) — JOB-651'), true);
  assert.equal(isP0('P1: self-healing WATCHDOG silent 20 min'), false);
  assert.equal(isP0('LiveKit Voice Agent Errors'), false);
  assert.equal(isP0(undefined), false);
});

test('two different policies do not share a cooldown', () => {
  const a = decideDelivery({ ...base, policyName: 'A', state: 'open' });
  const b = decideDelivery({ ...base, policyName: 'B', state: 'open', nowMs: NOW + 1000, store: a.store });
  assert.equal(b.send, true);
});
