#!/usr/bin/env bash
# =============================================================================
# self-healing VM init (JOB-731 Phase 2)
#
# Rendered by Terraform templatefile() and attached as the GCE
# metadata startup-script (infra/terraform/modules/self-healing-vm/main.tf).
# Replaces init/legacy-startup-script.sh (kept for reference).
#
# IDEMPOTENT: safe to re-run any number of times —
#   sudo google_metadata_script_runner startup
#
# TEMPLATEFILE RULES: this file is a Terraform template. Only the injected
# template variables may use the bare "dollar-brace" form; every BASH
# expansion must either be brace-less ($VAR) or double-dollar ($${VAR}).
#
# One-time steps init CANNOT do are collected into
# /home/joblander/POST-INIT-TODO.md and printed at the end.
# =============================================================================
set -euo pipefail

# ---- values injected by Terraform -------------------------------------------
PROJECT_ID="${project_id}"
SELF_HEALING_REPO_URL="${self_healing_repo_url}"
WORKSPACE_REPO_URL="${workspace_repo_url}"
REPO_BRANCH="${repo_branch}"
DISPATCHER_ENV_SECRET="${dispatcher_env_secret}"
GH_TOKEN_SECRET="${gh_token_secret}"
# -----------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
LOG_FILE=/var/log/self-healing-init.log
exec > >(tee -a "$LOG_FILE") 2>&1

AGENT_USER=joblander
AGENT_HOME=/home/$AGENT_USER
TODO_FILE=$AGENT_HOME/POST-INIT-TODO.md
TODO_TMP=$(mktemp)

log()      { echo "[init $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
add_todo() { echo "- [ ] $*" >> "$TODO_TMP"; log "TODO: $*"; }
as_agent() { sudo -u $AGENT_USER -H "$@"; }

log "=== self-healing init started (project=$PROJECT_ID branch=$REPO_BRANCH) ==="

# ---- 1. base packages --------------------------------------------------------
log "[1/9] base packages"
apt-get update -qq
apt-get install -y -qq git curl wget unzip jq ca-certificates gnupg \
  python3 python3-venv python3-pip xvfb cron

# ---- 2. node 20 (nodesource) ---------------------------------------------------
log "[2/9] node 20"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
log "node: $(node -v)"

# ---- 3. gh CLI ----------------------------------------------------------------
log "[3/9] gh CLI"
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli-stable.list
  apt-get update -qq
  apt-get install -y -qq gh
fi

# ---- 4. docker + Claude Code CLI + chromium ------------------------------------
log "[4/9] docker, claude, chromium"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

# ---- 5. agent user -------------------------------------------------------------
log "[5/9] user $AGENT_USER"
id -u $AGENT_USER >/dev/null 2>&1 || useradd -m -s /bin/bash $AGENT_USER
usermod -aG docker $AGENT_USER || true

as_agent git config --global user.name "JobLander Self-Healing Agent"
as_agent git config --global user.email "agent@joblander.app"

# ---- 6. gh auth (fail-soft) -----------------------------------------------------
log "[6/9] gh auth from Secret Manager ($GH_TOKEN_SECRET)"
GH_TOKEN_VALUE=$(gcloud secrets versions access latest \
  --secret="$GH_TOKEN_SECRET" --project="$PROJECT_ID" 2>/dev/null || true)
if [ -n "$GH_TOKEN_VALUE" ]; then
  if printf '%s' "$GH_TOKEN_VALUE" | as_agent gh auth login --with-token; then
    as_agent gh auth setup-git
    log "gh auth OK"
  else
    add_todo "gh auth login --with-token failed (token in secret '$GH_TOKEN_SECRET' invalid?) — run 'gh auth login' as $AGENT_USER"
  fi
else
  add_todo "Secret '$GH_TOKEN_SECRET' missing/unreadable — create it (GitHub PAT), add it to extra_secret_ids in Terraform, re-run init OR run 'gh auth login && gh auth setup-git' as $AGENT_USER"
fi
unset GH_TOKEN_VALUE

# ---- 7. clone/update repos -------------------------------------------------------
log "[7/9] repos"
clone_or_update() {
  # $1 = url, $2 = target dir
  local url=$1 dir=$2
  if [ -d "$dir/.git" ]; then
    as_agent git -C "$dir" fetch origin "$REPO_BRANCH" \
      && as_agent git -C "$dir" checkout "$REPO_BRANCH" \
      && as_agent git -C "$dir" pull --ff-only origin "$REPO_BRANCH" \
      || add_todo "repo update failed: $dir (dirty tree or diverged?) — resolve manually"
  else
    as_agent git clone --branch "$REPO_BRANCH" "$url" "$dir" \
      || add_todo "clone failed: $url → $dir (private repo + no gh auth?) — fix auth, re-run init"
  fi
}
clone_or_update "$SELF_HEALING_REPO_URL" "$AGENT_HOME/self-healing"
clone_or_update "$WORKSPACE_REPO_URL" "$AGENT_HOME/workspace"

# workspace/.env (TG_BOT_TOKEN/TG_CHAT_ID for scripts/notify.sh — the watcher's
# Telegram pager). Untracked on the legacy VM; snapshotted to Secret Manager
# 2026-07-16. Without it every page dies with "ENV_FILE not found" (found
# during TEST-PLAN stage-2 prep — exactly the gap class the fire drill exists for).
if [ -d "$AGENT_HOME/workspace" ]; then
  if gcloud secrets versions access latest \
    --secret="self-healing-workspace-env" --project="$PROJECT_ID" \
    > "$AGENT_HOME/workspace/.env.tmp" 2>/dev/null; then
    mv "$AGENT_HOME/workspace/.env.tmp" "$AGENT_HOME/workspace/.env"
    chown $AGENT_USER:$AGENT_USER "$AGENT_HOME/workspace/.env"
    chmod 600 "$AGENT_HOME/workspace/.env"
    log "workspace/.env rendered from secret 'self-healing-workspace-env'"
  else
    rm -f "$AGENT_HOME/workspace/.env.tmp"
    add_todo "could not render workspace/.env — notify.sh (Telegram paging) will FAIL"
  fi
fi

SH_DIR=$AGENT_HOME/self-healing
if [ ! -d "$SH_DIR" ]; then
  add_todo "self-healing repo absent — dispatcher/watcher/cron steps were SKIPPED entirely; fix clone and re-run init"
fi

# ---- 8. dispatcher + watcher ------------------------------------------------------
if [ -d "$SH_DIR" ]; then
  log "[8/9] dispatcher .env + builds"

  # dispatcher .env from Secret Manager (never on disk outside this file)
  if gcloud secrets versions access latest \
    --secret="$DISPATCHER_ENV_SECRET" --project="$PROJECT_ID" \
    > "$SH_DIR/dispatcher/.env.tmp" 2>/dev/null; then
    mv "$SH_DIR/dispatcher/.env.tmp" "$SH_DIR/dispatcher/.env"
    chown $AGENT_USER:$AGENT_USER "$SH_DIR/dispatcher/.env"
    chmod 600 "$SH_DIR/dispatcher/.env"
    log "dispatcher/.env rendered from secret '$DISPATCHER_ENV_SECRET' (live mode — stage 4 handover 2026-07-17)"
  else
    rm -f "$SH_DIR/dispatcher/.env.tmp"
    add_todo "could not render dispatcher/.env from secret '$DISPATCHER_ENV_SECRET' — dispatcher will not start"
  fi

  # dispatcher build. Phase 1 (TS reconstruction) ships src/ + tsconfig; until
  # that merges, the repo carries the recovered dist/ — building is optional.
  if [ -f "$SH_DIR/dispatcher/tsconfig.json" ]; then
    (cd "$SH_DIR/dispatcher" && as_agent npm ci && as_agent npx tsc) \
      || add_todo "dispatcher build failed — check npm/tsc output in $LOG_FILE"
  else
    log "dispatcher: no tsconfig.json (Phase 1 not merged yet) — using committed dist/"
  fi

  # watcher build (TS port, Phase 1). Until it merges only output-watch.sh exists.
  if [ -f "$SH_DIR/watcher/package.json" ]; then
    (cd "$SH_DIR/watcher" && as_agent npm ci && as_agent npm run build) \
      || add_todo "watcher build failed — check npm output in $LOG_FILE"
  else
    add_todo "watcher/package.json absent (TS port not merged) — the cron tick 'node dist/tick.js' will fail until it lands; re-run init after merge"
  fi

  # Vendored MCP servers (stdio) the dispatcher session + healthcheck spawn:
  # firebase (Firestore reads via ADC — needs the SA + datastore.viewer) and
  # sentry. `npm ci` only — they run from JS, no build step. Without their
  # node_modules the child procs fail-closed (tools absent; dispatcher still runs).
  for mcp in firebase sentry linear; do
    if [ -f "$SH_DIR/mcp/$mcp/package.json" ]; then
      (cd "$SH_DIR/mcp/$mcp" && as_agent npm ci --omit=dev) \
        || add_todo "mcp/$mcp npm ci failed — the $mcp MCP tools will be absent until fixed; re-run init"
    else
      add_todo "mcp/$mcp absent — dispatcher $mcp MCP tools unavailable; re-run init after it merges"
    fi
  done

  # ---- 9. systemd unit + cron -----------------------------------------------------
  log "[9/9] systemd + cron"
  # Dispatcher trace/turn logs (LOG_DIR in .env). Found during the stage-2 fire
  # drill: without it every traceEvent hits EACCES and per-turn traces are lost
  # (run still works — trace is fail-soft — but /feed history dies on restart).
  mkdir -p /var/log/job-dispatcher/turns
  chown -R $AGENT_USER:$AGENT_USER /var/log/job-dispatcher
  install -m 644 "$SH_DIR/deploy/systemd/claude-code-vm-job-dispatcher.service" \
    /etc/systemd/system/claude-code-vm-job-dispatcher.service
  systemctl daemon-reload
  systemctl enable claude-code-vm-job-dispatcher.service
  if [ -f "$SH_DIR/dispatcher/.env" ] && [ -f "$SH_DIR/dispatcher/dist/index.js" ]; then
    systemctl restart claude-code-vm-job-dispatcher.service \
      || add_todo "dispatcher service failed to start — journalctl -u claude-code-vm-job-dispatcher"
  else
    add_todo "dispatcher service enabled but NOT started (missing .env or dist/index.js)"
  fi

  # whole-crontab install: deploy/cron/self-healing.crontab OWNS joblander's crontab
  crontab -u $AGENT_USER "$SH_DIR/deploy/cron/self-healing.crontab"
  log "crontab installed for $AGENT_USER"
fi

# ---- unavoidable one-time steps ------------------------------------------------------
add_todo "Claude Code OAuth login (subscription auth cannot be scripted): sudo su - $AGENT_USER, then 'claude' and complete the browser login"

# ---- write POST-INIT-TODO.md + final block -------------------------------------------
{
  echo "# POST-INIT TODO ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo
  echo "Generated by init/init.sh. Re-running init regenerates this file."
  echo
  cat "$TODO_TMP"
} > "$TODO_FILE"
chown $AGENT_USER:$AGENT_USER "$TODO_FILE"
rm -f "$TODO_TMP"

echo
echo "================= POST-INIT TODO ================="
cat "$TODO_FILE"
echo "=================================================="
log "=== self-healing init finished ==="
