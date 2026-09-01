#!/usr/bin/env bash
#
# Guest-side network self-heal.
#
# WHY THIS EXISTS (incident 2026-08-26). Under memory pressure caused by an
# uncapped dispatcher session, systemd-networkd's DHCPv4 renewal on ens4 timed
# out at 11:09 UTC and the link went Failed. systemd-networkd never retried.
# When the lease expired an hour later the address was removed and the VM lost
# every network path — metadata server, Cloud Logging, SSH — while cron, the
# watcher, the CD timer and every daemon kept running perfectly, blind, for six
# days. The host was healthy the whole time. One `networkctl reconfigure` would
# have fixed it; nothing was watching for it.
#
# This is the layer that fixes that class from inside: probe the metadata
# server (link-local, no DNS, no egress), and escalate if it is unreachable.
#
#   2 consecutive failures (~4 min)   → networkctl reconfigure <iface>
#   3 consecutive failures (~6 min)   → systemctl restart systemd-networkd
#   5 consecutive failures (~10 min)  → reboot (at most once per hour)
#
# The reboot is last and rate-limited: a reboot loop on a VM whose network is
# broken upstream would be worse than a blind VM. The off-box watchdog
# (infra/terraform/modules/self-healing-watchdog) is the backstop for the case
# where even this cannot run.
#
# Runs as root from selfheal-netwatch.timer, every 2 minutes.
set -uo pipefail

METADATA_URL="http://169.254.169.254/computeMetadata/v1/instance/id"
PROBE_TIMEOUT_SEC="${NETWATCH_PROBE_TIMEOUT_SEC:-5}"
STATE_DIR=/run/selfheal-netwatch
FAIL_FILE="$STATE_DIR/consecutive-failures"
# Survives reboots on purpose — it is the reboot rate limiter.
PERSIST_DIR=/var/lib/self-healing
REBOOT_STAMP="$PERSIST_DIR/netwatch-last-reboot"
REBOOT_MIN_INTERVAL_SEC="${NETWATCH_REBOOT_MIN_INTERVAL_SEC:-3600}"

FAILS_RECONFIGURE=2
FAILS_RESTART_NETWORKD=3
FAILS_REBOOT=5

log() { logger -t selfheal-netwatch -p daemon.notice -- "$*"; }
warn() { logger -t selfheal-netwatch -p daemon.warning -- "$*"; }

mkdir -p "$STATE_DIR" "$PERSIST_DIR"

primary_iface() {
  # Default-route interface; falls back to the GCE default name.
  ip -o -4 route show to default 2>/dev/null | awk '{print $5; exit}' \
    || true
}

probe_ok() {
  curl -sf --max-time "$PROBE_TIMEOUT_SEC" \
    -H 'Metadata-Flavor: Google' "$METADATA_URL" >/dev/null 2>&1
}

if probe_ok; then
  # Recovered (or never broken). Announce recovery once, then go quiet.
  if [ -s "$FAIL_FILE" ]; then
    log "metadata server reachable again after $(cat "$FAIL_FILE") failed probe(s)"
  fi
  : >"$FAIL_FILE"
  exit 0
fi

FAILS=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" >"$FAIL_FILE"
IFACE="$(primary_iface)"
[ -n "$IFACE" ] || IFACE=ens4
warn "metadata server unreachable (consecutive failures: $FAILS, iface: $IFACE)"

if [ "$FAILS" -eq "$FAILS_RECONFIGURE" ]; then
  warn "reconfiguring $IFACE (DHCP renew)"
  networkctl reconfigure "$IFACE" 2>&1 | logger -t selfheal-netwatch
  exit 0
fi

if [ "$FAILS" -eq "$FAILS_RESTART_NETWORKD" ]; then
  warn "restarting systemd-networkd"
  systemctl restart systemd-networkd 2>&1 | logger -t selfheal-netwatch
  exit 0
fi

if [ "$FAILS" -ge "$FAILS_REBOOT" ]; then
  NOW=$(date +%s)
  LAST=$(cat "$REBOOT_STAMP" 2>/dev/null || echo 0)
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
  AGE=$(( NOW - LAST ))
  if [ "$AGE" -lt "$REBOOT_MIN_INTERVAL_SEC" ]; then
    warn "network still down after $FAILS probes; NOT rebooting — last netwatch reboot was ${AGE}s ago (< ${REBOOT_MIN_INTERVAL_SEC}s)"
    exit 0
  fi
  echo "$NOW" >"$REBOOT_STAMP"
  warn "network down after $FAILS consecutive probes — rebooting"
  systemctl reboot
fi

exit 0
