#!/usr/bin/env bash
# JOB-670: fast product-output watcher (the event-driven lane for JOB-651).
#
# Runs every minute (VM cron). Polls the codified product-output detector
# /health/output (JOB-668). On fail | degraded | unreachable it, exactly once
# per incident:
#   1. pages the owner (Telegram, P0) — the guaranteed win,
#   2. files a [Monitor] Linear ticket (label monitor + repo:backend),
#   3. POSTs the dispatcher /trigger so the self-healing loop starts NOW
#      (instead of waiting up to its 10-min poll).
# The existing self-heal engine (claude-code-vm-job-dispatcher) is unchanged —
# this only wakes it sooner. Dedup via a state file so we alert on the
# healthy->bad EDGE, not every minute; recovery clears it (+ a recovered ping).
set -uo pipefail

PROJECT="meet-assistant-6d8ad"
URL="https://joblander-audio-engine-p26anqucmq-ew.a.run.app"
# Dispatcher .env TRIGGER_TOKEN — from Secret Manager (JOB-731: no literals in git).
DISPATCH_TOKEN="${DISPATCH_TOKEN:-$(gcloud secrets versions access latest --secret=self-healing-trigger-token --project "$PROJECT" 2>/dev/null)}"
NOTIFY="/home/joblander/joblander/workspace/scripts/notify.sh"
STATE="/home/joblander/.output-watch-state"
JOB_TEAM="b12df7a0-4845-47fd-be59-8f6d03d9ae8d"
LBL_MONITOR="3cf3f731-dccf-43fa-861e-cba73998b183"
LBL_BUG="1d25b456-393f-4567-9980-e1bb98d3b069"
LBL_REPO_BACKEND="636d11e1-7544-4755-bd8d-2446b248a9c6"

KEY="$(gcloud secrets versions access latest --secret=HEALTH_OUTPUT_HMAC_KEY --project "$PROJECT" 2>/dev/null)"
TS="$(date +%s)"
SIG="$(printf 'GET\n/health/output\n%s' "$TS" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $NF}')"
RESP="$(curl -s --max-time 90 -w $'\n%{http_code}' -H "Authorization: HMAC ${TS}:${SIG}" "${URL}/health/output?window_min=30")"
CODE="$(printf '%s' "$RESP" | tail -1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
STATUS="$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","unreachable"))' 2>/dev/null || echo unreachable)"

# Test hooks (never set in cron): FORCE_BAD=1 forces the incident branch;
# DRY_RUN=1 prints the 3 actions instead of paging/filing/triggering.
if [ "${FORCE_BAD:-}" = "1" ]; then STATUS="degraded"; CODE="503"; fi
say() { if [ "${DRY_RUN:-}" = "1" ]; then echo "[DRY] $*"; return 0; fi; return 1; }

is_bad() { [ "$STATUS" = "fail" ] || [ "$STATUS" = "degraded" ] || { [ "$CODE" != "200" ]; }; }

# Hysteresis: require THRESHOLD consecutive bad samples (minutes) before paging.
# A single/flapping bad sample (busy region briefly crossing a freshness line)
# must NOT page — that is what spammed P0→recover. State = "COUNT PAGED COOLDOWN_UNTIL".
THRESHOLD="${WATCH_THRESHOLD:-3}"
# JOB-787: 4-hour post-recovery cooldown prevents re-paging on brief false-positive
# cycles. /health/output is fail-closed: a ~25s audio session (rmsMax>0) within
# freshAudioSec=120s of the last hint gap (>300s) triggers fail_slow even when no
# real interview questions exist. Multiple brief sessions can maintain this condition
# for 3+ consecutive minutes → threshold met → re-page. Cooldown blocks re-paging
# until the new COOLDOWN_UNTIL epoch; a sustained real outage RESETS COOLDOWN_UNTIL
# to 0 once the page fires, so a second outage within the cooldown window WILL page.
COOLDOWN_SEC="${WATCH_COOLDOWN_SEC:-14400}"
read -r PREV_COUNT PREV_PAGED COOLDOWN_UNTIL < <(cat "$STATE" 2>/dev/null); PREV_COUNT="${PREV_COUNT:-0}"; PREV_PAGED="${PREV_PAGED:-0}"; COOLDOWN_UNTIL="${COOLDOWN_UNTIL:-0}"

if ! is_bad; then
  # Healthy. Announce recovery only if we had actually paged this incident.
  if [ "$PREV_PAGED" = "1" ]; then
    say "notify RECOVERED ${STATUS}" || bash "$NOTIFY" "RECOVERED: /health/output = ${STATUS} (HTTP ${CODE}). Product output flowing again."
    # Start cooldown to suppress brief re-trips that immediately follow recovery.
    echo "0 0 $(( TS + COOLDOWN_SEC ))" > "$STATE"
  else
    echo "0 0 ${COOLDOWN_UNTIL}" > "$STATE"
  fi
  exit 0
fi

# Bad sample.
COUNT=$((PREV_COUNT + 1))
if [ "$COUNT" -lt "$THRESHOLD" ] || [ "$PREV_PAGED" = "1" ] || [ "$TS" -lt "${COOLDOWN_UNTIL}" ]; then
  # Still building up to the threshold, OR already paged this incident (dedup),
  # OR within the post-recovery cooldown window.
  echo "$COUNT $PREV_PAGED ${COOLDOWN_UNTIL}" > "$STATE"
  exit 0
fi
# Sustained bad for THRESHOLD consecutive samples and not yet paged → PAGE now.
# Clear the cooldown so a second outage after the next recovery will page again.
echo "$COUNT 1 0" > "$STATE"

# JOB-725: no backslash inside f-string expressions — SyntaxError on the VM's
# Python 3.10 made this ALWAYS print "(unreachable)" regardless of the body.
# Include the per-region reason so the page says WHY (e.g. mass suppression).
REGIONS="$(printf '%s' "$BODY" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  parts=[]
  for r,v in d.get("regions",{}).items():
    verdict=str(v.get("verdict"))
    if verdict in ("fail_slow","unknown"):
      parts.append(r+":"+verdict+" ("+str(v.get("reason"))+")")
    else:
      parts.append(r+":"+verdict)
  print(", ".join(parts) if parts else "(no regions)")
except Exception:
  print("(no body)")' 2>/dev/null || echo "(unreachable)")"

# 1. Page owner (P0).
say "notify P0 status=${STATUS} http=${CODE} regions=${REGIONS}" || \
  bash "$NOTIFY" "URGENT P0 [output-watch]: /health/output = ${STATUS} (HTTP ${CODE}). Input alive, output dead/unmeasurable. Regions: ${REGIONS}. ${URL}/health/output"

# 2. File a [Monitor] ticket for the self-heal dispatcher to pick up.
LINEAR_KEY="$(gcloud secrets versions access latest --secret=linear-api-key --project "$PROJECT" 2>/dev/null)"
if say "create [Monitor] ticket status=${STATUS} regions=${REGIONS}"; then :
elif [ -n "${LINEAR_KEY:-}" ]; then
  python3 - "$LINEAR_KEY" "$JOB_TEAM" "$LBL_MONITOR" "$LBL_BUG" "$LBL_REPO_BACKEND" "$STATUS" "$CODE" "$REGIONS" <<'PY'
import sys, json, urllib.request
key, team, l1, l2, l3, status, code, regions = sys.argv[1:9]
title = f"[Monitor] /health/output={status} — product output regression (backend)"
body = (f"Fast output-watch (JOB-670) tripped on the codified product-output invariant (JOB-668).\n\n"
        f"- status: **{status}** (HTTP {code})\n- regions: {regions}\n\n"
        f"Meaning: input is alive but hints/output are not flowing (or the detector could not measure = fail-closed). "
        f"This is the JOB-651 class (errors green, output dead). Investigate the STT->LLM->hint path / recent deploy; "
        f"a rollback may be the fix rather than a code change.")
q = {"query":"mutation($i:IssueCreateInput!){issueCreate(input:$i){success issue{identifier}}}",
     "variables":{"i":{"teamId":team,"title":title,"description":body,"labelIds":[l1,l2,l3],"priority":1}}}
req = urllib.request.Request("https://api.linear.app/graphql", data=json.dumps(q).encode(),
    headers={"Authorization":key,"Content-Type":"application/json"})
try:
    print(json.loads(urllib.request.urlopen(req, timeout=20).read()).get("data"))
except Exception as e:
    print("linear create failed:", e)
PY
fi

# 3. Wake the self-heal dispatcher now (idempotent; dedupes if already running).
say "POST localhost:4100/trigger" || \
  curl -s -m 10 -X POST -H "X-Dispatch-Token: ${DISPATCH_TOKEN}" "http://localhost:4100/trigger" >/dev/null 2>&1 || true
