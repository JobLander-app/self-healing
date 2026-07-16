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
MEETING_LAB_REPO_URL="${meeting_lab_repo_url}"
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
log "[1/10] base packages"
apt-get update -qq
apt-get install -y -qq git curl wget unzip jq ca-certificates gnupg \
  python3 python3-venv python3-pip xvfb cron

# ---- 2. node 20 (nodesource) ---------------------------------------------------
log "[2/10] node 20"
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
log "[3/10] gh CLI"
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
log "[4/10] docker, claude, chromium"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code
# meeting-lab README (VM specifics): SNAP chromium ONLY — the apt/google-chrome
# builds do not run MAIN-world content scripts from --load-extension.
if ! snap list chromium >/dev/null 2>&1; then
  snap install chromium || add_todo "snap install chromium failed — meeting-lab browser bots need /snap/bin/chromium"
fi

# ---- 5. agent user -------------------------------------------------------------
log "[5/10] user $AGENT_USER"
id -u $AGENT_USER >/dev/null 2>&1 || useradd -m -s /bin/bash $AGENT_USER
usermod -aG docker $AGENT_USER || true
# linger so the meeting-lab systemd *user* unit starts at boot without a login
loginctl enable-linger $AGENT_USER || true

as_agent git config --global user.name "JobLander Self-Healing Agent"
as_agent git config --global user.email "agent@joblander.app"

# ---- 6. gh auth (fail-soft) -----------------------------------------------------
log "[6/10] gh auth from Secret Manager ($GH_TOKEN_SECRET)"
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
log "[7/10] repos"
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
clone_or_update "$MEETING_LAB_REPO_URL" "$AGENT_HOME/meeting-lab"
clone_or_update "$WORKSPACE_REPO_URL" "$AGENT_HOME/workspace"

SH_DIR=$AGENT_HOME/self-healing
if [ ! -d "$SH_DIR" ]; then
  add_todo "self-healing repo absent — dispatcher/watcher/cron steps were SKIPPED entirely; fix clone and re-run init"
fi

# ---- 8. dispatcher + watcher ------------------------------------------------------
if [ -d "$SH_DIR" ]; then
  log "[8/10] dispatcher .env + builds"

  # dispatcher .env from Secret Manager (never on disk outside this file)
  if gcloud secrets versions access latest \
    --secret="$DISPATCHER_ENV_SECRET" --project="$PROJECT_ID" \
    > "$SH_DIR/dispatcher/.env.tmp" 2>/dev/null; then
    mv "$SH_DIR/dispatcher/.env.tmp" "$SH_DIR/dispatcher/.env"
    # TEST MODE overlay (TEST-PLAN.md, stage 0.1) — until the owner's cutover
    # signal this VM's dispatcher is strictly read-only and never self-polls
    # (manual POST /trigger only). systemd EnvironmentFile: last assignment
    # wins, so appending overrides the secret's values. Removed at cutover
    # (stage 4: DRY_RUN=false + real POLL_CRON).
    {
      echo ""
      echo "# --- JOB-731 TEST MODE (remove at cutover, TEST-PLAN stage 4) ---"
      echo "DRY_RUN=true"
      echo "POLL_CRON=0 0 29 2 *"
    } >> "$SH_DIR/dispatcher/.env"
    chown $AGENT_USER:$AGENT_USER "$SH_DIR/dispatcher/.env"
    chmod 600 "$SH_DIR/dispatcher/.env"
    log "dispatcher/.env rendered from secret '$DISPATCHER_ENV_SECRET' (+ test-mode overlay: DRY_RUN=true, poll off)"
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

  # ---- 9. systemd unit + cron -----------------------------------------------------
  log "[9/10] systemd + cron"
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

# ---- 10. meeting-lab ----------------------------------------------------------------
# Per meeting-lab/deploy/setup-vm.sh (its own deploy doc), adapted from
# rsync-push to on-VM clone: node deps for bots/, python venv for server/,
# data dirs, systemd USER unit. Browser login profiles are interactive-only
# → POST-INIT-TODO.
ML_DIR=$AGENT_HOME/meeting-lab
if [ -d "$ML_DIR" ]; then
  log "[10/10] meeting-lab"
  (cd "$ML_DIR/bots" && as_agent npm install --no-audit --no-fund --loglevel=error) \
    || add_todo "meeting-lab bots npm install failed"
  as_agent python3 -m venv "$AGENT_HOME/meeting-lab-venv" 2>/dev/null || true
  as_agent "$AGENT_HOME/meeting-lab-venv/bin/pip" -q install -r "$ML_DIR/server/requirements.txt" \
    || add_todo "meeting-lab server pip install failed"
  as_agent mkdir -p "$AGENT_HOME/meeting-lab-data/sessions" \
    "$AGENT_HOME/meeting-lab-data/profiles" "$AGENT_HOME/meeting-lab-data/assets"

  as_agent mkdir -p "$AGENT_HOME/.config/systemd/user"
  as_agent cp "$ML_DIR/deploy/meeting-lab.service" "$AGENT_HOME/.config/systemd/user/"
  AGENT_UID=$(id -u $AGENT_USER)
  # user manager needs a moment on the very first boot after enable-linger
  if sudo -u $AGENT_USER XDG_RUNTIME_DIR=/run/user/$AGENT_UID \
    systemctl --user daemon-reload 2>/dev/null; then
    sudo -u $AGENT_USER XDG_RUNTIME_DIR=/run/user/$AGENT_UID \
      systemctl --user enable --now meeting-lab \
      || add_todo "meeting-lab user unit failed to start — systemctl --user status meeting-lab (as $AGENT_USER)"
  else
    add_todo "systemd user manager for $AGENT_USER not up yet — run as $AGENT_USER: systemctl --user daemon-reload && systemctl --user enable --now meeting-lab"
  fi
  add_todo "meeting-lab browser profiles (meetbot/teamsbot/guest) are interactive-only: copy $AGENT_HOME/meeting-lab-data/profiles/ from the old VM (or re-login per meeting-lab README) — bots cannot host Meet/Teams without them"
else
  add_todo "meeting-lab repo absent — its install was skipped; fix clone and re-run init"
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
