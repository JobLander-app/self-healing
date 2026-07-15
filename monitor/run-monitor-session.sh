#!/bin/bash
# Monitor Agent — hourly session
# Cron: 0 * * * * systemd-cat -t joblander-monitor /home/joblander/joblander/workspace/scripts/run-monitor-session.sh

AGENT_NAME="Monitor"
LIVENESS_TIMEOUT=900  # 15 min

source "$(dirname "$0")/lib/agent-launcher.sh"
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
python3 "$(dirname "$0")/monitor/triage.py" > "$TRIAGE_LOG" 2>&1
TRIAGE_EXIT=$?

run_agent_session "Monitor" \
    "Monitor сессия. Текущее время UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ) — используй его в маркерах SESSION_START/SESSION_END, не выдумывай. Сбор и триаж УЖЕ выполнены скриптом scripts/monitor/triage.py (exit code: $TRIAGE_EXIT). Прочитай agents/claude/monitor.md и действуй СТРОГО по шагам A-E. A: SESSION_START. B: прочитай teams/logs/monitoring/triage-summary.json (если exit code != 0 или timestamp в файле старше 15 минут — зафиксируй сбой triage в SESSION_END, БЕЗ Telegram, БЕЗ самостоятельного сбора). C: Linear-дедуп и действия по полю action каждой escalation. D: Telegram ТОЛЬКО строки из p0_alerts, текст БУКВАЛЬНО из alert_text. E: запиши выполненные actions в latest-report.json и SESSION_END. ЗАПРЕЩЕНО: gcloud logging read, sentry-cli, собственные скрипты сбора/триажа, выдумывание severity/count/timestamps, любые пути state кроме teams/logs/monitoring/, брать тикеты в работу, менять статусы feature-тикетов, создавать task-файлы, спавнить developer-агентов — ты ТОЛЬКО эскалация по готовым данным."
