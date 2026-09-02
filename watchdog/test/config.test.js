'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadConfig, intFromEnv } = require('../config');

const ENV = {
  PROJECT_ID: 'p', VM_ZONE: 'europe-west1-b', VM_NAME: 'self-healing-1',
  WATCHER_LOG_ID: 'self-healing-watcher', DISPATCHER_LOG_ID: 'self-healing-dispatcher',
  STATE_BUCKET: 'b', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1',
};

test('defaults load', () => {
  const c = loadConfig({ ...ENV });
  assert.equal(c.watcherPageSec, 600);
  assert.equal(c.resetMaxPerWindow, 3);
});

// The repo's own recurring bug (2026-07-28 review): an unvalidated number
// became NaN, every comparison went false, and the check passed silently.
test('a non-numeric threshold throws instead of becoming NaN', () => {
  assert.throws(() => loadConfig({ ...ENV, WATCHER_PAGE_SEC: 'ten minutes' }), /not an integer/);
});

test('an out-of-range threshold throws', () => {
  assert.throws(() => loadConfig({ ...ENV, WATCHER_PAGE_SEC: '5' }), /below minimum/);
});

test('an empty required string throws', () => {
  assert.throws(() => loadConfig({ ...ENV, PROJECT_ID: '  ' }), /PROJECT_ID is required/);
});

test('reset threshold below page threshold is rejected', () => {
  assert.throws(
    () => loadConfig({ ...ENV, WATCHER_PAGE_SEC: '900', WATCHER_RESET_SEC: '600' }),
    /page before you reset/,
  );
});

test('intFromEnv rejects floats and whitespace-only values', () => {
  assert.throws(() => intFromEnv({ X: '1.5' }, 'X'), /not an integer/);
  assert.throws(() => intFromEnv({ X: ' ' }, 'X'), /required/);
  assert.equal(intFromEnv({ X: ' 42 ' }, 'X'), 42);
});
