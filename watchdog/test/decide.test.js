'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decide, OK } = require('../decide');

const cfg = {
  instance: 'self-healing-1',
  watcherPageSec: 600,
  watcherResetSec: 900,
  dispatcherPageSec: 1800,
  dispatcherResetSec: 3600,
  resetCooldownSec: 1800,
  resetMaxPerWindow: 3,
  resetWindowSec: 21600,
  lookbackSec: 172800,
  canaryStaleSec: 108000,
};

const NOW = Date.parse('2026-09-02T12:00:00Z');
const base = {
  nowMs: NOW,
  watcherAgeSec: 60,
  dispatcherAgeSec: 120,
  instanceStatus: 'RUNNING',
  canaryAgeSec: 3600,
  state: {
    condition: OK, resets: [], everSeenWatcher: true, everSeenDispatcher: true,
    everSeenCanary: true, lastPageAt: 0,
  },
  cfg,
};

test('healthy loop: no page, no reset', () => {
  const v = decide(base);
  assert.equal(v.condition, OK);
  assert.equal(v.reset, false);
  assert.equal(v.page, false);
});

test('watcher stale past the reset threshold resets the VM', () => {
  const v = decide({ ...base, watcherAgeSec: 1200 });
  assert.equal(v.condition, 'watcher-dead');
  assert.equal(v.reset, true);
  assert.equal(v.page, true);
});

test('watcher merely late pages but does not reset', () => {
  const v = decide({ ...base, watcherAgeSec: 700 });
  assert.equal(v.condition, 'watcher-late');
  assert.equal(v.reset, false);
  assert.equal(v.page, true);
});

test('the 2026-08-26 outage shape: heartbeat gone for six days -> reset', () => {
  const v = decide({ ...base, watcherAgeSec: 6 * 24 * 3600, dispatcherAgeSec: 6 * 24 * 3600 });
  assert.equal(v.condition, 'watcher-dead');
  assert.equal(v.reset, true);
});

test('never resets on a heartbeat stream it has never seen (misconfiguration guard)', () => {
  const v = decide({
    ...base,
    watcherAgeSec: null,
    state: { ...base.state, everSeenWatcher: false },
  });
  assert.equal(v.condition, 'watcher-dead');
  assert.equal(v.reset, false, 'a log id typo must not power-cycle a healthy VM');
  assert.equal(v.page, true);
  assert.match(v.reasons.join(' '), /never observed a watcher heartbeat/);
});

test('dispatcher dead while the VM is alive resets only after its own threshold', () => {
  const late = decide({ ...base, dispatcherAgeSec: 2000 });
  assert.equal(late.condition, 'dispatcher-late');
  assert.equal(late.reset, false);

  const dead = decide({ ...base, dispatcherAgeSec: 4000 });
  assert.equal(dead.condition, 'dispatcher-dead');
  assert.equal(dead.reset, true);
});

test('a stopped instance is started, not reset', () => {
  const v = decide({ ...base, instanceStatus: 'TERMINATED', watcherAgeSec: null });
  assert.equal(v.condition, 'instance-not-running');
  assert.equal(v.start, true);
  assert.equal(v.reset, false);
});

test('cooldown suppresses a second reset', () => {
  const v = decide({
    ...base,
    watcherAgeSec: 1200,
    state: { ...base.state, condition: 'watcher-dead', resets: [NOW - 600_000] },
  });
  assert.equal(v.reset, false);
  assert.match(v.reasons.join(' '), /cooldown/);
});

test('reset budget stops a reboot loop and says a human is needed', () => {
  const v = decide({
    ...base,
    watcherAgeSec: 1200,
    state: {
      ...base.state,
      condition: 'watcher-dead',
      resets: [NOW - 20_000_000, NOW - 15_000_000, NOW - 10_000_000].map((t) => Math.max(t, NOW - 5_000_000)),
    },
  });
  assert.equal(v.reset, false);
  assert.match(v.reasons.join(' '), /budget exhausted/);
  assert.match(v.reasons.join(' '), /HUMAN NEEDED/);
});

test('recovery pages once', () => {
  const v = decide({ ...base, state: { ...base.state, condition: 'watcher-dead' } });
  assert.equal(v.condition, OK);
  assert.equal(v.recovered, true);
  assert.equal(v.page, true);
});

test('a persisting condition does not page on every tick', () => {
  const v = decide({
    ...base,
    watcherAgeSec: 700,
    state: { ...base.state, condition: 'watcher-late', lastPageAt: NOW - 60_000 },
  });
  assert.equal(v.page, false, 'repeat pages are rate-limited to the cooldown');
});

test('a stale alert-path canary pages but never resets — the VM is not the broken part', () => {
  const v = decide({ ...base, canaryAgeSec: 200000 });
  assert.equal(v.condition, 'alert-path-unproven');
  assert.equal(v.page, true);
  assert.equal(v.reset, false, 'rebooting a healthy box does not repair a dead relay');
});

test('a canary that has never been seen does not page (not yet configured)', () => {
  const v = decide({
    ...base,
    canaryAgeSec: null,
    state: { ...base.state, everSeenCanary: false },
  });
  assert.equal(v.condition, OK);
});

test('the canary check never outranks a dead watcher', () => {
  const v = decide({ ...base, watcherAgeSec: 1200, canaryAgeSec: 200000 });
  assert.equal(v.condition, 'watcher-dead');
  assert.equal(v.reset, true);
});
