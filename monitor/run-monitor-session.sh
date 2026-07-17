#!/bin/bash
# Monitor Agent — hourly session. HOME = the self-healing repo (JOB-731 3M).
# Cron (new VM): 0 * * * * systemd-cat -t joblander-monitor /home/joblander/self-healing/monitor/run-monitor-session.sh
#
# The launcher lib + agent prompt + state dir still live in the WORKSPACE
# checkout (the launcher `git stash`es dirty workspace state on start — so
# NOTHING may be overlaid into workspace by hand; found when a stash silently
# reverted a synced triage.py and the session ran the stale ssh collector).
# triage.py itself runs FROM THIS repo — the single source of truth.

AGENT_NAME="Monitor"
LIVENESS_TIMEOUT=900  # 15 min
SELF_HEALING_MONITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_DIR="${WORKSPACE_DIR:-/home/joblander/workspace}"
[ -d "$WORKSPACE_DIR" ] || WORKSPACE_DIR=/home/joblander/joblander/workspace  # legacy VM layout
cd "$WORKSPACE_DIR" || exit 1

source "$WORKSPACE_DIR/scripts/lib/agent-launcher.sh"
init_launcher 203

# Pre-inject the Sentry token from Secret Manager so the agent never types a
# secret name itself. It has repeatedly freelanced wrong names
# (e.g. "sentry-auth-token" → NOT_FOUND), breaking Sentry monitoring. The
# launcher resolves the correct secret; the agent just reads $SENTRY_TOKEN.
export SENTRY_TOKEN="$(gcloud secrets versions access latest --secret=joblander-sentry-monitor-token --project=meet-assistant-6d8ad 2>/dev/null || echo '')"

# JOB-558: deterministic collection + triage runs BEFORE the LLM session.
# The script produces teams/logs/monitoring/triage-summary.json with real
# counts/timestamps, rule-based severities and verbatim P0 alert texts.
# The LLM session must NOT collect or classify anything itself.
TRIAGE_LOG="teams/logs/monitoring/last-triage-run.log"
mkdir -p teams/logs/monitoring
python3 "$SELF_HEALING_MONITOR_DIR/triage.py" > "$TRIAGE_LOG" 2>&1
TRIAGE_EXIT=$?

run_agent_session "Monitor" \
    "Monitor сессия. Текущее время UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ) — используй его в маркерах SESSION_START/SESSION_END, не выдумывай. Сбор и триаж УЖЕ выполнены скриптом scripts/monitor/triage.py (exit code: $TRIAGE_EXIT). Прочитай agents/claude/monitor.md и действуй СТРОГО по шагам A-E. A: SESSION_START. B: прочитай teams/logs/monitoring/triage-summary.json (если exit code != 0 или timestamp в файле старше 15 минут — зафиксируй сбой triage в SESSION_END, БЕЗ Telegram, БЕЗ самостоятельного сбора). C: Linear-дедуп и действия по полю action каждой escalation. D: Telegram ТОЛЬКО строки из p0_alerts, текст БУКВАЛЬНО из alert_text. E: запиши выполненные actions в latest-report.json и SESSION_END. ЗАПРЕЩЕНО: gcloud logging read, sentry-cli, собственные скрипты сбора/триажа, выдумывание severity/count/timestamps, любые пути state кроме teams/logs/monitoring/, брать тикеты в работу, менять статусы feature-тикетов, создавать task-файлы, спавнить developer-агентов — ты ТОЛЬКО эскалация по готовым данным."
