'use strict';
//
// Pure decision logic for the off-box watchdog. No I/O — everything it needs
// is an argument, so the whole policy is unit-testable (watchdog/test/).
//
// The rules, in the order they are evaluated:
//
//   1. Instance not RUNNING            -> start it, page.
//   2. Watcher heartbeat older than
//      WATCHER_RESET_SEC               -> reset the VM, page.
//   3. Watcher heartbeat older than
//      WATCHER_PAGE_SEC                -> page.
//   4. Dispatcher heartbeat older than
//      DISPATCHER_RESET_SEC            -> reset the VM, page.
//      (Only reachable when the watcher IS fresh: the box is alive and the
//      fixer inside it is not. `Restart=always` has had an hour to work.)
//   5. Dispatcher heartbeat older than
//      DISPATCHER_PAGE_SEC             -> page.
//   6. The daily canary's proof of
//      delivery is stale               -> page. Never a reset: the VM is fine,
//                                         it is the ALERT PATH that is broken,
//                                         and rebooting a healthy box does not
//                                         fix a dead relay.
//   7. Otherwise                       -> ok (and a RECOVERED page if the
//                                         previous run was not ok).
//
// Heartbeat ages in rules 2–5 count from no earlier than the instance's last
// start, so a VM that was stopped for days is not reset minutes after it boots.
// Until every stream has reported since the boot (and none is past a
// threshold) the verdict is `booting`: no page, no RECOVERED, and the previous
// condition is kept for the first real verdict.
//
// TWO INVARIANTS THAT MATTER MORE THAN THE THRESHOLDS
//
// a) Never reset on a signal that has never been seen. If no heartbeat has
//    EVER been observed for a stream, the likeliest explanation is a
//    misconfigured log id, not a dead VM — and a watchdog that power-cycles a
//    healthy production box every 30 minutes because of a Terraform typo is a
//    worse outage than the one it was built for. Page instead, and say so.
//
// b) A reset is rate-limited and budgeted. Past the budget the watchdog stops
//    resetting and escalates that it has stopped. Turning one bug into a
//    reboot loop is the classic failure of automatic recovery.

const OK = 'ok';
const BOOTING = 'booting';

/**
 * @param {object} input
 * @param {number} input.nowMs
 * @param {number|null} input.watcherAgeSec    null = no entry found in lookback
 * @param {number|null} input.dispatcherAgeSec null = no entry found in lookback
 * @param {number|null} [input.canaryAgeSec]     null = no canary delivery found
 * @param {number|null} [input.sinceStartSec]    seconds since the instance last started; null = unknown
 * @param {string} input.instanceStatus        RUNNING | TERMINATED | ...
 * @param {object} input.state                 persisted watchdog state
 * @param {object} input.cfg
 */
function decide({ nowMs, watcherAgeSec: rawWatcherAgeSec, dispatcherAgeSec: rawDispatcherAgeSec, canaryAgeSec = null, sinceStartSec = null, instanceStatus, state, cfg }) {
  // A heartbeat written before the current boot says nothing about this boot.
  // A VM started after a long stop has stale heartbeats by definition until its
  // crons tick, and judging it by them reset a fresh boot on 2026-10-13 four
  // minutes after it came up. So a stream is aged from the later of its last
  // heartbeat and the instance start: a fresh boot gets its full thresholds,
  // and a stream that never reports after boot still goes dead on uptime.
  // A missing heartbeat only means "none in the lookback", so it is aged from
  // the boot only when the boot is inside the lookback; otherwise it stays
  // null and reads as before.
  const bootInLookback = sinceStartSec !== null && sinceStartSec <= cfg.lookbackSec;
  const sinceBoot = (age) => (sinceStartSec === null ? age
    : age === null ? (bootInLookback ? sinceStartSec : null)
      : Math.min(age, sinceStartSec));
  const predatesBoot = (age) => (age === null ? bootInLookback : sinceStartSec !== null && age > sinceStartSec);
  const ageText = (stream, raw, aged) => (predatesBoot(raw)
    ? `no ${stream} since the instance started ${Math.round(aged / 60)} min ago`
    : `${stream} is ${Math.round(aged / 60)} min old`);
  const watcherAgeSec = sinceBoot(rawWatcherAgeSec);
  const dispatcherAgeSec = sinceBoot(rawDispatcherAgeSec);
  const reasons = [];
  const seenWatcher = Boolean(state.everSeenWatcher);
  const seenDispatcher = Boolean(state.everSeenDispatcher);
  // Same invariant as the reset guard: a signal never observed is a
  // configuration question, not an incident. Do not page about a canary that
  // has not been set up yet.
  const seenCanary = Boolean(state.everSeenCanary);

  let condition = OK;
  let wantReset = false;
  let wantStart = false;
  let detail = '';

  if (instanceStatus !== 'RUNNING') {
    condition = 'instance-not-running';
    wantStart = true;
    detail = `instance ${cfg.instance} is ${instanceStatus}`;
  } else if (watcherAgeSec === null || watcherAgeSec > cfg.watcherResetSec) {
    condition = 'watcher-dead';
    detail = watcherAgeSec === null
      ? `no WATCHER_HEARTBEAT in the last ${Math.round(cfg.lookbackSec / 3600)}h`
      : `${ageText('WATCHER_HEARTBEAT', rawWatcherAgeSec, watcherAgeSec)} (reset threshold ${Math.round(cfg.watcherResetSec / 60)} min)`;
    if (!seenWatcher) {
      reasons.push('not resetting: this watchdog has never observed a watcher heartbeat — suspect configuration, not the VM');
    } else {
      wantReset = true;
    }
  } else if (watcherAgeSec > cfg.watcherPageSec) {
    condition = 'watcher-late';
    detail = `${ageText('WATCHER_HEARTBEAT', rawWatcherAgeSec, watcherAgeSec)} (page threshold ${Math.round(cfg.watcherPageSec / 60)} min)`;
  } else if (dispatcherAgeSec === null || dispatcherAgeSec > cfg.dispatcherResetSec) {
    condition = 'dispatcher-dead';
    detail = dispatcherAgeSec === null
      ? `no DISPATCHER_HEARTBEAT in the last ${Math.round(cfg.lookbackSec / 3600)}h (VM itself is alive)`
      : `${ageText('DISPATCHER_HEARTBEAT', rawDispatcherAgeSec, dispatcherAgeSec)} while the VM is alive (reset threshold ${Math.round(cfg.dispatcherResetSec / 60)} min)`;
    if (!seenDispatcher) {
      reasons.push('not resetting: this watchdog has never observed a dispatcher heartbeat — suspect configuration, not the daemon');
    } else {
      wantReset = true;
    }
  } else if (dispatcherAgeSec > cfg.dispatcherPageSec) {
    condition = 'dispatcher-late';
    detail = `${ageText('DISPATCHER_HEARTBEAT', rawDispatcherAgeSec, dispatcherAgeSec)} (page threshold ${Math.round(cfg.dispatcherPageSec / 60)} min)`;
  } else if (
    seenCanary &&
    (canaryAgeSec === null || canaryAgeSec > cfg.canaryStaleSec)
  ) {
    // The loop is healthy; the way it would TELL you it is not may be dead.
    // Worth a page precisely because it is invisible by construction.
    condition = 'alert-path-unproven';
    detail = canaryAgeSec === null
      ? 'the daily alert-path canary has not been delivered inside the lookback window'
      : `the alert-path canary was last delivered ${Math.round(canaryAgeSec / 3600)}h ago (stale after ${Math.round(cfg.canaryStaleSec / 3600)}h)`;
  }

  // Inside the boot grace a stream that has not reported since the boot is
  // past no threshold, yet it has proven nothing either. That is no verdict
  // yet: not `ok` (a box that proved nothing must not page RECOVERED), not a
  // page, and the previous condition carries over to the first real verdict.
  const booting = condition === OK && (predatesBoot(rawWatcherAgeSec) || predatesBoot(rawDispatcherAgeSec));
  if (booting) {
    condition = BOOTING;
    detail = `waiting for the first heartbeat since the instance started ${Math.round(sinceStartSec / 60)} min ago`;
  }

  // ---- reset budget --------------------------------------------------------
  let resetAllowed = wantReset;
  if (wantReset) {
    const recent = (state.resets || []).filter((t) => nowMs - t < cfg.resetWindowSec * 1000);
    const last = recent.length ? Math.max(...recent) : 0;
    if (last && nowMs - last < cfg.resetCooldownSec * 1000) {
      resetAllowed = false;
      reasons.push(`reset suppressed: last reset ${Math.round((nowMs - last) / 60000)} min ago, cooldown ${Math.round(cfg.resetCooldownSec / 60)} min`);
    } else if (recent.length >= cfg.resetMaxPerWindow) {
      resetAllowed = false;
      reasons.push(`reset budget exhausted: ${recent.length} resets in the last ${Math.round(cfg.resetWindowSec / 3600)}h (max ${cfg.resetMaxPerWindow}) — resetting again would be a loop, not a repair. HUMAN NEEDED.`);
    }
  }

  // ---- paging cadence ------------------------------------------------------
  // Page on every transition, on every actual reset, and otherwise at most
  // once per cooldown while a condition persists. Silence between repeats is
  // deliberate: an alert that arrives every five minutes stops being read.
  const previous = state.condition || OK;
  const transitioned = previous !== condition;
  const lastPageAt = Number(state.lastPageAt || 0);
  const pageCooldownMs = cfg.resetCooldownSec * 1000;
  const shouldPage =
    booting ? false
      : condition !== OK
        ? transitioned || resetAllowed || wantStart || nowMs - lastPageAt >= pageCooldownMs
        : transitioned && previous !== OK; // RECOVERED notice

  return {
    condition,
    // What to persist as state.condition: a boot grace is not a verdict.
    stateCondition: booting ? previous : condition,
    detail,
    reasons,
    reset: resetAllowed,
    start: wantStart,
    page: shouldPage,
    recovered: condition === OK && transitioned && previous !== OK,
    previousCondition: previous,
  };
}

module.exports = { decide, OK, BOOTING };
