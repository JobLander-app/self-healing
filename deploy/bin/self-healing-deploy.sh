#!/usr/bin/env bash
# Transactional pull CD: compile a detached snapshot, then activate while idle.
# Restore exact prior runtime artifacts/config on failure; never rebuild rollback
# from the network. Secrets, databases, traces and unrelated host files stay put.
set -Eeuo pipefail

SH_DIR="${SH_DIR:-/home/joblander/self-healing}"
AGENT_USER="${AGENT_USER:-joblander}"
LOG_FILE="${DEPLOY_LOG:-/var/log/self-healing-deploy.log}"
NOTIFY="${DEPLOY_NOTIFY_SCRIPT:-$SH_DIR/deploy/bin/self-healing-notify.py}"
SYSTEM_ROOT="${DEPLOY_SYSTEM_ROOT:-}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/var/lock/self-healing-deploy.lock}"
WATCH_LOCK="${DEPLOY_WATCH_LOCK:-/home/joblander/.output-watch.lock}"
MONITOR_LOCK="${DEPLOY_MONITOR_LOCK:-/tmp/joblander-Monitor.lock}"
TRANSACTION_FILE="${DEPLOY_TRANSACTION_FILE:-/var/lib/self-healing-deploy/transaction.env}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://localhost:4100/health}"
STATUS_URL="${DEPLOY_STATUS_URL:-http://localhost:4100/status}"
INGEST_HEALTH_URL="${DEPLOY_INGEST_HEALTH_URL:-http://localhost:4200/healthz}"
DISPATCHER_UNIT="claude-code-vm-job-dispatcher.service"
INGEST_UNIT="self-healing-change-ingest.service"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"; }
as_agent() { sudo -u "$AGENT_USER" "$@"; }
git_agent() { as_agent git -C "$SH_DIR" "$@"; }
notify() { if [ -x "$NOTIFY" ]; then as_agent "$NOTIFY" "$1" >/dev/null 2>&1 || true; fi; }
# Re-exec inherits the SAME open file description, with no unlock/relock gap.
if [ "${SELF_HEALING_CD_LOCKED:-}" != 1 ]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || exit 0
fi

idle() {
  local busy snapshot key value load="" active="" sub="" main="" control="" tasks=""
  # A failed read must only defer, including during transaction recovery. Do
  # not inherit the activation ERR/rollback trap into these substitutions.
  snapshot="$(trap - ERR; systemctl show "$DISPATCHER_UNIT" --property=LoadState,ActiveState,SubState,MainPID,ControlPID,TasksCurrent 2>/dev/null)" || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      LoadState) load="$value" ;; ActiveState) active="$value" ;;
      SubState) sub="$value" ;; MainPID) main="$value" ;;
      ControlPID) control="$value" ;; TasksCurrent) tasks="$value" ;;
    esac
  done <<<"$snapshot"
  # Missing units and failed/partial systemd queries prove nothing. A loaded
  # stopped unit (including the no-process wait between automatic restarts)
  # must be able to receive the release that fixes its startup failure.
  [ "$load" = loaded ] || return 1
  case "$active/$sub" in
    inactive/dead|failed/failed|activating/auto-restart)
      if [ "$main" = 0 ] && [ "$control" = 0 ]; then
        case "$tasks" in 0|'[not set]') return 0 ;; esac
      fi
      return 1 ;;
    active/*|reloading/*|activating/*) ;; # A live process needs application evidence.
    *) return 1 ;;
  esac
  busy="$(trap - ERR; curl -fsS --max-time 5 "$STATUS_URL" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print("idle" if d.get("busy") is False else "busy")' 2>/dev/null)" || return 1
  [ "$busy" = idle ]
}
# Recover an interrupted activation BEFORE checking whether HEAD == origin/main.
# This registry is root-only; it never lives in the agent-writable checkout.
RECOVER=0
if [ -f "$TRANSACTION_FILE" ]; then
  RECOVER=1
  LOCAL="unknown"; REMOTE="unknown"; CHANGED=""
else
  # A guard with no durable transaction can only precede the first mutation,
  # or follow a successful commit. It is safe to clear under the CD flock.
  rm -f "$SH_DIR/.deploying"
git_agent fetch --quiet origin main || { log "fetch failed"; exit 1; }
LOCAL="${SELF_HEALING_CD_FORCE_FROM:-$(git_agent rev-parse HEAD)}"
REMOTE="$(git_agent rev-parse origin/main)"
[ "$LOCAL" != "$REMOTE" ] || exit 0
# Even a harmless local edit belongs to its author. --keep below is a second
# protection against a conflict appearing between this check and activation.
if [ -n "$(git_agent status --porcelain --untracked-files=no)" ]; then
  log "deferring: tracked checkout changes need reconciliation"
  exit 0
fi

idle || { log "deferring: dispatcher busy or status unavailable"; exit 0; }
CHANGED="$(git_agent diff --name-only "$LOCAL" "$REMOTE")"
changed() { grep -q "^$1" <<<"$CHANGED"; }

# Run new CD logic from a temporary file BEFORE mutating the live checkout.
if [ -z "${SELF_HEALING_CD_FORCE_FROM:-}" ] && changed deploy/bin/self-healing-deploy.sh; then
  next="$(mktemp)"
  git_agent show "$REMOTE:deploy/bin/self-healing-deploy.sh" >"$next"
  # bash reads the open script even after unlink; the child removes its file.
  SELF_HEALING_CD_FORCE_FROM="$LOCAL" SELF_HEALING_CD_LOCKED=1 SELF_HEALING_CD_SCRIPT="$next" exec bash "$next"
fi
fi
[ -z "${SELF_HEALING_CD_SCRIPT:-}" ] || rm -f "$SELF_HEALING_CD_SCRIPT"
TX="$(mktemp -d "${DEPLOY_TMP_DIR:-/var/tmp}/self-healing-release.XXXXXX")"
chmod 755 "$TX"
mkdir "$TX/stage"
mkdir -m 700 "$TX/backup"
ACTIVATING=0
BACKUP_PATHS=()
ABSENT_PATHS=()
RESTART_UNITS=()
RUNTIME_DIRS=()
CONFIG_SOURCES=()
CONFIG_TARGETS=()
CONFIG_CHANGED=""
cleanup() {
  rm -f "$SH_DIR/.deploying"
  rm -rf "$TX"
}
backup() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    mkdir -p "$TX/backup$(dirname "$path")"
    cp -a "$path" "$TX/backup$path"
    BACKUP_PATHS+=("$path")
  else ABSENT_PATHS+=("$path"); fi
}
restart_units() {
  local unit
  for unit in "${RESTART_UNITS[@]}"; do systemctl restart "$unit" >>"$LOG_FILE" 2>&1 || return 1; done
}
verify_runtime() {
  local unit attempt
  for attempt in 1 2 3 4 5 6; do
    if curl -fsS --max-time 5 "$HEALTH_URL" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("status") in ("ok","alive") else 1)' && \
      curl -sS --max-time 5 "$INGEST_HEALTH_URL" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if isinstance(d.get("rowCount"),int) else 1)'; then
      for unit in "${RESTART_UNITS[@]}"; do systemctl is-active --quiet "$unit" || return 1; done
      return 0
    fi
    log "waiting for runtime verification (attempt $attempt/6)"
    sleep "${DEPLOY_VERIFY_SLEEP:-5}"
  done
  return 1
}
rollback() {
  local reason="$1" failed=0 path
  trap - ERR INT TERM
  set +e
  log "ROLLBACK ${REMOTE:0:8} → ${LOCAL:0:8}: $reason"
  systemctl stop "$DISPATCHER_UNIT" "$INGEST_UNIT" >>"$LOG_FILE" 2>&1
  git_agent reset --quiet --keep "$LOCAL" || failed=1
  for path in "${BACKUP_PATHS[@]}"; do
    rm -rf "$path"
    cp -a "$TX/backup$path" "$path" || failed=1
  done
  for path in "${ABSENT_PATHS[@]}"; do rm -rf "$path" || failed=1; done
  if [ -f "$TX/cron-present" ]; then
    crontab -u "$AGENT_USER" "$TX/crontab" || failed=1
  elif [ -f "$TX/cron-snapshot" ]; then crontab -u "$AGENT_USER" -r || failed=1; fi
  systemctl daemon-reload || failed=1
  restart_units || failed=1
  # Confirm the previous build actually boots, rather than claiming rollback
  # succeeded because a reset command returned zero.
  verify_runtime || failed=1
  if [ "$failed" = 0 ]; then
    notify "CD ROLLED BACK to ${LOCAL:0:8}: $reason"
    rm -f "$TRANSACTION_FILE"
    cleanup
  else
    log "ROLLBACK FAILED: backup retained at $TX; deployment guard retained"
    notify "CD ROLLBACK FAILED: inspect $LOG_FILE; exact backup retained at $TX"
  fi
  exit 1
}
on_error() {
  if [ "$ACTIVATING" = 1 ]; then rollback "activation command failed at line $1"; fi
  # Compatibility with the previous CD script, which reset before re-exec.
  if [ "$(git_agent rev-parse HEAD)" != "$LOCAL" ]; then git_agent reset --quiet --keep "$LOCAL"; fi
  log "staging failed at line $1; running release unchanged"
  notify "CD FAILED staging ${REMOTE:0:8}; running release unchanged"
  cleanup
  exit 1
}
trap 'on_error "$LINENO"' ERR INT TERM
trap 'if [ "$ACTIVATING" = 0 ]; then cleanup; fi' EXIT

if [ "$RECOVER" = 1 ]; then
  rm -rf "$TX"
  # The manifest contains only declare -p output written by root below.
  # shellcheck disable=SC1090
  source "$TRANSACTION_FILE"
  ACTIVATING=1
  # A cron process may have started since the interrupted process lost locks.
  as_agent touch "$WATCH_LOCK" "$MONITOR_LOCK"
  exec 7<"$WATCH_LOCK"
  flock -n 7 || { log "deferring recovery: watcher active"; exit 0; }
  exec 6<"$MONITOR_LOCK"
  flock -n 6 || { log "deferring recovery: monitor active"; exit 0; }
  idle || { log "deferring recovery: dispatcher busy or status unavailable"; exit 0; }
  rollback "recovering interrupted activation"
fi

git_agent archive "$REMOTE" | tar -x -C "$TX/stage"
chown -R "$AGENT_USER" "$TX/stage"
for component in dispatcher watcher change-ingest; do
  if changed "$component/"; then
    log "staging $component"
    if ! (cd "$TX/stage/$component" && as_agent npm ci --silent && as_agent npm run build --silent) >>"$LOG_FILE" 2>&1; then
      on_error "$LINENO"
    fi
    [ -d "$TX/stage/$component/dist" ]
    RUNTIME_DIRS+=("$component/node_modules" "$component/dist")
  fi
done
for mcp in firebase sentry linear; do
  if changed "mcp/$mcp/"; then
    if ! (cd "$TX/stage/mcp/$mcp" && as_agent npm ci --omit=dev --silent) >>"$LOG_FILE" 2>&1; then
      on_error "$LINENO"
    fi
    RUNTIME_DIRS+=("mcp/$mcp/node_modules")
  fi
done

# Every shipped config has an exact target. Build union(old,new) to remove
# deleted managed files and restore absent/present status during rollback.
config_pair() { CONFIG_SOURCES+=("$1"); CONFIG_TARGETS+=("$SYSTEM_ROOT$2"); }
if changed deploy/; then
  while IFS= read -r file; do
    case "$file" in
      deploy/systemd/*) config_pair "$file" "/etc/systemd/system/${file##*/}" ;;
      deploy/prometheus/*) config_pair "$file" "/etc/prometheus/${file#deploy/prometheus/}" ;;
      deploy/grafana/*) config_pair "$file" "/etc/grafana/${file#deploy/grafana/}" ;;
      deploy/caddy/*) config_pair "$file" "/etc/caddy/${file#deploy/caddy/}" ;;
    esac
  done < <({ git_agent ls-tree -r --name-only "$REMOTE" -- deploy/systemd deploy/prometheus deploy/grafana deploy/caddy;
    git_agent diff --name-only --diff-filter=D "$LOCAL" "$REMOTE" -- deploy/systemd deploy/prometheus deploy/grafana deploy/caddy; } | sort -u)
fi
# Render environment-specific templates from the currently installed domain;
# never overwrite a self-hoster's domain with a JobLander default.
for ((i=0; i<${#CONFIG_SOURCES[@]}; i++)); do
  src="$TX/stage/${CONFIG_SOURCES[i]}"
  if [ -f "$src" ] && grep -q '__CONSOLE_DOMAIN__' "$src"; then
    domain="${DEPLOY_CONSOLE_DOMAIN:-}"
    if [ -z "$domain" ]; then
      domain="$(python3 - "$SYSTEM_ROOT/etc/grafana/grafana.ini" <<'PYDOMAIN'
import configparser,sys,urllib.parse
config = configparser.ConfigParser(interpolation=None)
config.read(sys.argv[1])
explicit = config.get('server', 'domain', fallback='').strip()
root_url = config.get('server', 'root_url', fallback='').strip()
print(explicit or urllib.parse.urlsplit(root_url).hostname or '')
PYDOMAIN
)"
    fi
    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]]
    python3 - "$src" "$domain" <<'PYRENDER'
from pathlib import Path
import sys
file = Path(sys.argv[1])
file.write_text(file.read_text().replace('__CONSOLE_DOMAIN__', sys.argv[2]))
PYRENDER
  fi
done
# Converge the full desired config, including drift left by older CD versions
# that reset source without copying dashboards/provisioning to the host.
for ((i=0; i<${#CONFIG_SOURCES[@]}; i++)); do
  src="$TX/stage/${CONFIG_SOURCES[i]}"; target="${CONFIG_TARGETS[i]}"
  if ! cmp -s "$src" "$target"; then CONFIG_CHANGED+="${CONFIG_SOURCES[i]}"$'\n'; fi
done
config_changed() { grep -q "^$1" <<<"$CONFIG_CHANGED"; }
# Validate managed config before activation when its owning binary is present.
if config_changed deploy/prometheus/; then promtool check config "$TX/stage/deploy/prometheus/prometheus.yml" >>"$LOG_FILE" 2>&1; fi
if config_changed deploy/caddy/; then caddy validate --config "$TX/stage/deploy/caddy/Caddyfile" >>"$LOG_FILE" 2>&1; fi

# The poller observes this guard before claiming work. Check busy AGAIN after
# publishing it; staging may have taken minutes while the current release ran.
printf '%s\n' "$REMOTE" >"$SH_DIR/.deploying"
idle || { log "deferring after staging: dispatcher busy"; exit 0; }
as_agent touch "$WATCH_LOCK" "$MONITOR_LOCK"
exec 7<"$WATCH_LOCK"
flock -n 7 || { log "deferring: watcher tick active"; exit 0; }
exec 6<"$MONITOR_LOCK"
flock -n 6 || { log "deferring: monitor active"; exit 0; }
RESTART_UNITS=("$DISPATCHER_UNIT" "$INGEST_UNIT")
for unit in prometheus node_exporter; do
  if config_changed "deploy/$unit/" || config_changed "deploy/systemd/$unit.service"; then RESTART_UNITS+=("$unit.service"); fi
done
config_changed deploy/grafana/ && RESTART_UNITS+=(grafana-server.service)
config_changed deploy/caddy/ && RESTART_UNITS+=(caddy.service)
for path in "${RUNTIME_DIRS[@]}"; do backup "$SH_DIR/$path"; done
for path in "${CONFIG_TARGETS[@]}"; do backup "$path"; done
if changed deploy/cron/self-healing.crontab; then
  if crontab -u "$AGENT_USER" -l >"$TX/crontab"; then touch "$TX/cron-present"; fi
  touch "$TX/cron-snapshot"
fi
# Logs are persistent runtime state, not a monitored-state migration target.
# The monitor creates/migrates its own ~/.local/state subtree on first launch.
if [ -d "$TX/stage/monitor" ]; then
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0750 \
    "$SYSTEM_ROOT/var/log/self-healing-monitor" "$SYSTEM_ROOT/var/log/self-healing-monitor/turns"
fi
# Durable rollback metadata precedes ALL live mutations. A SIGKILL/reboot
# after this point resumes restoration on the next CD timer tick.
ACTIVATING=1
install -d -m 700 "$(dirname "$TRANSACTION_FILE")"
(umask 077; declare -p TX LOCAL REMOTE BACKUP_PATHS ABSENT_PATHS RESTART_UNITS >"$TRANSACTION_FILE.tmp")
python3 - "$TRANSACTION_FILE.tmp" <<'PYFSYNC'
import os,sys
with open(sys.argv[1], 'rb') as f: os.fsync(f.fileno())
PYFSYNC
mv "$TRANSACTION_FILE.tmp" "$TRANSACTION_FILE"
python3 - "$TRANSACTION_FILE" <<'PYFSYNC'
import os,sys
fd=os.open(os.path.dirname(sys.argv[1]),os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
PYFSYNC
log "activating ${LOCAL:0:8} → ${REMOTE:0:8}"
systemctl stop "$DISPATCHER_UNIT" "$INGEST_UNIT"
git_agent reset --quiet --keep "$REMOTE"
for path in "${RUNTIME_DIRS[@]}"; do
  rm -rf "${SH_DIR:?}/$path"
  cp -a "$TX/stage/$path" "$SH_DIR/$path"
  diff -qr "$TX/stage/$path" "$SH_DIR/$path" >/dev/null
done
for ((i=0; i<${#CONFIG_SOURCES[@]}; i++)); do
  src="$TX/stage/${CONFIG_SOURCES[i]}"; target="${CONFIG_TARGETS[i]}"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$target")"
    # Preserve target ownership/mode (notably root:grafana 0640).
    if [ -f "$target" ]; then cat "$src" >"$target"; else install -m 644 "$src" "$target"; fi
    cmp -s "$src" "$target"
  else rm -f "$target"; fi
done
if changed deploy/cron/self-healing.crontab; then
  crontab -u "$AGENT_USER" "$SH_DIR/deploy/cron/self-healing.crontab"
  crontab -u "$AGENT_USER" -l >"$TX/cron-verify"
  cmp -s "$SH_DIR/deploy/cron/self-healing.crontab" "$TX/cron-verify"
fi
# Migration is a deterministic copy under the already-held monitor flock.
# Do it before dispatcher startup can create the new suppression directory and
# accidentally suppress copy-once migration of the legacy monitor history.
if [ -f "$SH_DIR/monitor/run_monitor.py" ]; then
  as_agent env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$SH_DIR/monitor" \
    python3 -c 'from run_monitor import Config, migrate_state; migrate_state(Config.from_env())'
  log "monitor state migration checked before dispatcher restart"
fi
systemctl daemon-reload
restart_units

verify_runtime
[ "$(git_agent rev-parse HEAD)" = "$REMOTE" ]
# Once verification is complete, no post-commit notification/signal may
# reset only the source while retaining the verified new runtime artifacts.
trap - ERR INT TERM
rm -f "$TRANSACTION_FILE"
ACTIVATING=0
log "deployed ${REMOTE:0:8} ok (runtime artifacts + managed config verified)"
notify "CD: self-healing deployed ${REMOTE:0:8} — $(git_agent log -1 --pretty=%s)"
# Host hardening converges through its independent hourly timer. It is never
# partially applied inside a runtime transaction or rerun during rollback.
