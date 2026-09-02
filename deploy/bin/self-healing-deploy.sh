#!/usr/bin/env bash
#
# Pull-based CD for the self-healing loop.
#
# Runs as root from a systemd timer. Every tick it asks one question: does the
# checkout at $SH_DIR match origin/main? If yes it exits silently. If not it
# pulls, rebuilds only what changed, restarts the affected units, verifies them,
# and rolls back if the verify fails.
#
# WHY PULL AND NOT PUSH. A GitHub-Actions deploy would need an inbound
# credential (WIF or an SA key) whose only purpose is to reach one VM. The VM
# already has a git checkout and a network path out. Pull-based needs no new
# credential, keeps working when GitHub Actions is down, and is the same shape a
# self-hoster inherits. CI stays the gate: main is only ever green code.
#
# WHAT THIS FIXES (2026-07-28 review). Nothing rebuilt or restarted the daemons
# after a merge. dispatcher/dist was built 2026-07-19 13:01 and the process
# started 13:05 with NRestarts=0 — so PR #16, the loop's own healthcheck fix
# merged 2026-07-23, sat on disk for five days having never executed while its
# Linear ticket read Done. The loop could not tell "merged" from "deployed".
set -uo pipefail

SH_DIR="${SH_DIR:-/home/joblander/self-healing}"
AGENT_USER="${AGENT_USER:-joblander}"
LOG_FILE="${DEPLOY_LOG:-/var/log/self-healing-deploy.log}"
NOTIFY="${DEPLOY_NOTIFY_SCRIPT:-/home/joblander/workspace/scripts/notify.sh}"
DISPATCHER_UNIT="claude-code-vm-job-dispatcher.service"
INGEST_UNIT="self-healing-change-ingest.service"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://localhost:4100/health}"
STATUS_URL="${DEPLOY_STATUS_URL:-http://localhost:4100/status}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }
as_agent() { sudo -u "$AGENT_USER" "$@"; }
git_agent() { as_agent git -C "$SH_DIR" "$@"; }

notify() {
  [ -x "$NOTIFY" ] || return 0
  as_agent "$NOTIFY" "$1" >/dev/null 2>&1 || true
}

# Single-flight. A slow npm ci must not overlap the next timer tick.
exec 9>/var/lock/self-healing-deploy.lock
flock -n 9 || exit 0

git_agent fetch --quiet origin main || { log "fetch failed"; exit 1; }

LOCAL="$(git_agent rev-parse HEAD)"
REMOTE="$(git_agent rev-parse origin/main)"

# Set by the re-exec below when this script updated itself. It carries the HEAD
# the run started from, so the second pass still knows what changed instead of
# seeing LOCAL == REMOTE and exiting as a no-op.
FORCE_FROM="${SELF_HEALING_CD_FORCE_FROM:-}"
if [ -n "$FORCE_FROM" ]; then
  LOCAL="$FORCE_FROM"
elif [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

# NEVER restart the dispatcher mid-investigation. A run holds a Linear ticket
# claimed In Progress; killing it strands that claim until the stale-claim
# reaper picks it up ~30 min later, and burns the tokens already spent. The
# timer fires again in two minutes — deferring costs nothing.
BUSY="$(curl -s --max-time 5 "$STATUS_URL" 2>/dev/null | grep -o '"busy":[a-z]*' | head -1 | cut -d: -f2)"
if [ "$BUSY" = "true" ]; then
  log "deferring ${LOCAL:0:8} → ${REMOTE:0:8}: dispatcher busy mid-run"
  exit 0
fi

log "deploying ${LOCAL:0:8} → ${REMOTE:0:8}"
CHANGED="$(git_agent diff --name-only "$LOCAL" "$REMOTE")"
changed() { grep -q "^$1" <<<"$CHANGED"; }

# Ignored build output (dist/) survives reset --hard, so a failed build below
# leaves the previously working artifacts in place rather than a half-tree.
git_agent reset --quiet --hard origin/main || { log "reset failed"; notify "CD FAILED: git reset to ${REMOTE:0:8} failed"; exit 1; }

# A commit that changes THIS script must be deployed by the new version of it,
# not the old one. Bash executes a script by reading it as it goes, so the run
# that pulls a CD change is still running the pre-pull logic — on 2026-09-02 that
# silently skipped a brand-new host-hardening step and the next tick, finding no
# diff, did nothing. The log said "deployed ok" and the host was unhardened.
# exec keeps the flock on fd 9, so this is still single-flight.
if [ -z "$FORCE_FROM" ] && changed deploy/bin/self-healing-deploy.sh; then
  log "CD script itself changed — re-executing the new version for ${LOCAL:0:8} → ${REMOTE:0:8}"
  SELF_HEALING_CD_FORCE_FROM="$LOCAL" exec "$SH_DIR/deploy/bin/self-healing-deploy.sh"
fi

build() { # build <dir> — npm ci + tsc, non-fatal at call site
  local d="$SH_DIR/$1"
  [ -f "$d/package.json" ] || return 0
  log "building $1"
  ( cd "$d" && as_agent npm ci --silent && as_agent npm run build --silent ) 2>>"$LOG_FILE"
}

FAILED=""
changed dispatcher/    && { build dispatcher    || FAILED="$FAILED dispatcher"; }
changed watcher/       && { build watcher       || FAILED="$FAILED watcher"; }
changed change-ingest/ && { build change-ingest || FAILED="$FAILED change-ingest"; }
for m in firebase sentry linear; do
  changed "mcp/$m/" && { ( cd "$SH_DIR/mcp/$m" && as_agent npm ci --omit=dev --silent ) 2>>"$LOG_FILE" || FAILED="$FAILED mcp/$m"; }
done

rollback() {
  log "ROLLBACK to ${LOCAL:0:8}: $1"
  git_agent reset --quiet --hard "$LOCAL"
  build dispatcher; build change-ingest
  systemctl restart "$DISPATCHER_UNIT" 2>>"$LOG_FILE"
  systemctl restart "$INGEST_UNIT" 2>>"$LOG_FILE"
  notify "CD ROLLED BACK to ${LOCAL:0:8} — $1. Deploy of ${REMOTE:0:8} aborted; see $LOG_FILE"
  exit 1
}

[ -n "$FAILED" ] && rollback "build failed:$FAILED"

# What needs a restart. Tracked as flags rather than restarting inline, because
# a unit-FILE change needs a restart just as much as a code change does:
# `systemctl daemon-reload` re-reads the unit but leaves the running process in
# the cgroup (and therefore under the memory limits) it started with. Installing
# selfheal.slice without restarting would have left the dispatcher uncapped in
# system.slice until some unrelated future restart — the containment would have
# looked deployed and not been. Caught in review of PR #29.
NEED_RESTART_DISPATCHER=0
NEED_RESTART_INGEST=0
changed dispatcher/    && NEED_RESTART_DISPATCHER=1
changed change-ingest/ && NEED_RESTART_INGEST=1

# deploy/ owns the units and the crontab wholesale — reinstall before restarting.
if changed deploy/; then
  install -m 644 "$SH_DIR/deploy/systemd/"*.service "$SH_DIR/deploy/systemd/"*.timer \
    "$SH_DIR/deploy/systemd/"*.slice /etc/systemd/system/ 2>>"$LOG_FILE"
  systemctl daemon-reload
  crontab -u "$AGENT_USER" "$SH_DIR/deploy/cron/self-healing.crontab" 2>>"$LOG_FILE" \
    && log "crontab reinstalled"
  # Host hardening (memory caps, DHCP lease survival, earlyoom, netwatch timer).
  # Idempotent and non-fatal: a hardening failure must not roll back a good
  # code deploy, but it must be loud in the log and in Telegram.
  if [ -x "$SH_DIR/deploy/bin/self-healing-harden.sh" ]; then
    if "$SH_DIR/deploy/bin/self-healing-harden.sh" >>"$LOG_FILE" 2>&1; then
      log "host hardening applied"
    else
      log "WARNING: host hardening reported failures — see $LOG_FILE"
      notify "self-healing CD: host hardening reported failures on $(hostname) — see $LOG_FILE"
    fi
  fi
  # A changed .service/.slice only takes effect on the next start of the unit.
  if changed deploy/systemd/; then
    NEED_RESTART_DISPATCHER=1
    NEED_RESTART_INGEST=1
    log "unit files changed — dispatcher and change-ingest will be restarted to pick up their slice/limits"
  fi
fi

[ "$NEED_RESTART_DISPATCHER" = 1 ] && systemctl restart "$DISPATCHER_UNIT" 2>>"$LOG_FILE"
[ "$NEED_RESTART_INGEST" = 1 ]     && systemctl restart "$INGEST_UNIT" 2>>"$LOG_FILE"

# ---- verify ---------------------------------------------------------------
# systemd reporting "active" only means the process did not exit yet; a
# dispatcher that boots and immediately throws still reads active for a moment.
# Give it a beat, then require the HTTP surface to actually answer.
sleep 5
systemctl is-active --quiet "$DISPATCHER_UNIT" || rollback "$DISPATCHER_UNIT not active after restart"
systemctl is-active --quiet "$INGEST_UNIT"     || rollback "$INGEST_UNIT not active after restart"
curl -sf --max-time 10 "$HEALTH_URL" | grep -q '"status":"ok"' \
  || rollback "dispatcher /health did not return ok after restart"

log "deployed ${REMOTE:0:8} ok"
notify "CD: self-healing deployed ${REMOTE:0:8} — $(git_agent log -1 --pretty=%s)"
