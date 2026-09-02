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
CONSOLE_DOMAIN="${console_domain}"
GRAFANA_ADMIN_SECRET="${grafana_admin_secret}"
# -----------------------------------------------------------------------------

# ---- pinned observability tool versions (no official apt repo) --------------
# Prometheus & node_exporter install as pinned release binaries for a
# reproducible build (Grafana & Caddy come from their official apt repos).
# Bump deliberately; checksums are verified against the release sha256sums.txt.
PROMETHEUS_VERSION=2.53.2
NODE_EXPORTER_VERSION=1.8.2
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
log "[1/11] base packages"
apt-get update -qq
apt-get install -y -qq git curl wget unzip jq ca-certificates gnupg \
  python3 python3-venv python3-pip xvfb cron

# ---- 2. node 20 (nodesource) ---------------------------------------------------
log "[2/11] node 20"
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
log "[3/11] gh CLI"
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
log "[4/11] docker, claude, chromium"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code

# ---- 5. observability stack packages -------------------------------------------
# Grafana + Caddy from their OFFICIAL apt repos (reproducible, auto-updated
# via apt). Prometheus + node_exporter have NO official apt repo, so they
# install as version-pinned release binaries with checksum verification
# (the robust/reproducible option). Configs + systemd units + service start
# happen later (step 11), once the repo is cloned. All idempotent.
log "[5/11] observability packages (grafana, caddy, prometheus, node_exporter)"
ARCH=$(dpkg --print-architecture) # amd64 on e2-standard-2

# --- Grafana apt repo ---
if ! command -v grafana-server >/dev/null 2>&1; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
  echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
    > /etc/apt/sources.list.d/grafana.list
fi

# --- Caddy apt repo ---
if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
fi

if ! command -v grafana-server >/dev/null 2>&1 || ! command -v caddy >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq grafana caddy
fi

# --- Prometheus + node_exporter: pinned binaries + checksum verify ---
# System users (nologin) that own the data dirs and run the services.
id -u prometheus    >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin prometheus
id -u node_exporter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin node_exporter

# $1 = github owner/repo, $2 = version, $3 = base name (dir + tarball stem),
# remaining args = binaries to install from the extracted dir into /usr/local/bin.
install_pinned_release() {
  local repo=$1 ver=$2 base=$3
  shift 3
  local tmp url
  tmp=$(mktemp -d)
  url="https://github.com/$repo/releases/download/v$ver"
  curl -fsSL "$url/$base.tar.gz" -o "$tmp/$base.tar.gz"
  curl -fsSL "$url/sha256sums.txt" -o "$tmp/sha256sums.txt"
  # Verify only the file we downloaded (the sums file lists every asset).
  (cd "$tmp" && sha256sum -c --ignore-missing sha256sums.txt)
  tar -xzf "$tmp/$base.tar.gz" -C "$tmp"
  local bin
  for bin in "$@"; do
    install -m 0755 "$tmp/$base/$bin" "/usr/local/bin/$bin"
  done
  rm -rf "$tmp"
}

if ! /usr/local/bin/prometheus --version 2>&1 | grep -q "version $PROMETHEUS_VERSION"; then
  install_pinned_release prometheus/prometheus "$PROMETHEUS_VERSION" \
    "prometheus-$PROMETHEUS_VERSION.linux-$ARCH" prometheus promtool
fi
if ! /usr/local/bin/node_exporter --version 2>&1 | grep -q "version $NODE_EXPORTER_VERSION"; then
  install_pinned_release prometheus/node_exporter "$NODE_EXPORTER_VERSION" \
    "node_exporter-$NODE_EXPORTER_VERSION.linux-$ARCH" node_exporter
fi

# --- Prometheus data dir + install its systemd unit ---
mkdir -p /etc/prometheus /var/lib/prometheus/data
chown -R prometheus:prometheus /var/lib/prometheus

# ---- 6. agent user -------------------------------------------------------------
log "[6/11] user $AGENT_USER"
id -u $AGENT_USER >/dev/null 2>&1 || useradd -m -s /bin/bash $AGENT_USER
usermod -aG docker $AGENT_USER || true

as_agent git config --global user.name "JobLander Self-Healing Agent"
as_agent git config --global user.email "agent@joblander.app"

# ---- 7. gh auth (fail-soft) -----------------------------------------------------
log "[7/11] gh auth from Secret Manager ($GH_TOKEN_SECRET)"
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

# ---- 8. clone/update repos -------------------------------------------------------
log "[8/11] repos"
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

# ---- 9. dispatcher + watcher ------------------------------------------------------
if [ -d "$SH_DIR" ]; then
  log "[9/11] dispatcher .env + builds"

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

  # dispatcher build. dist/ is no longer committed (2026-07-28): a tracked build
  # artifact drifts from src on every VM build, which leaves the checkout
  # permanently dirty and makes the automated `git reset --hard` in
  # deploy/bin/self-healing-deploy.sh unsafe. Built from src here and on every
  # deploy, exactly like watcher and change-ingest.
  if [ -f "$SH_DIR/dispatcher/tsconfig.json" ]; then
    (cd "$SH_DIR/dispatcher" && as_agent npm ci && as_agent npx tsc) \
      || add_todo "dispatcher build failed — check npm/tsc output in $LOG_FILE"
  else
    add_todo "dispatcher/tsconfig.json absent — cannot build dist/index.js; the dispatcher service will not start"
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

  # change-ingest build (Change Context / INTENT GATE feed). Pulls prod changes
  # into a local SQLite change store the dispatcher queries before fixing. v1
  # reuses the SA's logging.viewer + self-healing-gh-token + linear-api-key — no
  # new IAM/secret. better-sqlite3 is a native module; if npm ci fails to build
  # it, the todo flags it and the dispatcher's INTENT GATE simply fails OPEN
  # (feed unreachable → fix flow proceeds as before).
  if [ -f "$SH_DIR/change-ingest/tsconfig.json" ]; then
    (cd "$SH_DIR/change-ingest" && as_agent npm ci && as_agent npx tsc) \
      || add_todo "change-ingest build failed (native better-sqlite3?) — INTENT GATE feed absent; dispatcher fails OPEN. Check $LOG_FILE"
  else
    add_todo "change-ingest absent — dispatcher INTENT GATE has no change feed (fails OPEN); re-run init after it merges"
  fi

  # ---- 10. systemd unit + cron ----------------------------------------------------
  log "[10/11] systemd + cron"
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

  # change-ingest: SQLite data dir + systemd unit (localhost :4200 change feed).
  mkdir -p /var/lib/self-healing
  chown -R $AGENT_USER:$AGENT_USER /var/lib/self-healing
  if [ -f "$SH_DIR/deploy/systemd/self-healing-change-ingest.service" ]; then
    install -m 644 "$SH_DIR/deploy/systemd/self-healing-change-ingest.service" \
      /etc/systemd/system/self-healing-change-ingest.service
    systemctl daemon-reload
    systemctl enable self-healing-change-ingest.service
    if [ -f "$SH_DIR/change-ingest/dist/index.js" ]; then
      systemctl restart self-healing-change-ingest.service \
        || add_todo "change-ingest service failed to start — journalctl -u self-healing-change-ingest"
    else
      add_todo "change-ingest service enabled but NOT started (missing dist/index.js — build failed?)"
    fi
  fi

  # Memory-capping slice + the netwatch timer that repairs a dead DHCP lease.
  # Both exist because of the 2026-08-26 six-day blindness — see
  # docs/POSTMORTEM-2026-08-26-network-blackout.md and deploy/systemd/selfheal.slice.
  install -m 644 "$SH_DIR/deploy/systemd/selfheal.slice" /etc/systemd/system/selfheal.slice
  install -m 644 "$SH_DIR/deploy/systemd/selfheal-netwatch.service" /etc/systemd/system/selfheal-netwatch.service
  install -m 644 "$SH_DIR/deploy/systemd/selfheal-netwatch.timer" /etc/systemd/system/selfheal-netwatch.timer
  install -m 644 "$SH_DIR/deploy/systemd/selfheal-harden.service" /etc/systemd/system/selfheal-harden.service
  install -m 644 "$SH_DIR/deploy/systemd/selfheal-harden.timer" /etc/systemd/system/selfheal-harden.timer
  systemctl daemon-reload

  # Host hardening: KeepConfiguration=dhcp, earlyoom, user-slice cap, timer enable.
  "$SH_DIR/deploy/bin/self-healing-harden.sh" \
    || add_todo "host hardening reported failures — run $SH_DIR/deploy/bin/self-healing-harden.sh by hand and read its output"

  # whole-crontab install: deploy/cron/self-healing.crontab OWNS joblander's crontab
  crontab -u $AGENT_USER "$SH_DIR/deploy/cron/self-healing.crontab"
  log "crontab installed for $AGENT_USER"

  # CD timer. Installed LAST in this block so the units it restarts already
  # exist. From here on a merge to origin/main reaches this VM on its own —
  # before this, nothing rebuilt or restarted anything after a merge, and the
  # dispatcher ran a five-day-old build of its own already-merged fix.
  if [ -f "$SH_DIR/deploy/systemd/self-healing-deploy.service" ]; then
    chmod 755 "$SH_DIR/deploy/bin/self-healing-deploy.sh"
    touch /var/log/self-healing-deploy.log
    chown $AGENT_USER:$AGENT_USER /var/log/self-healing-deploy.log
    install -m 644 "$SH_DIR/deploy/systemd/self-healing-deploy.service" \
      /etc/systemd/system/self-healing-deploy.service
    install -m 644 "$SH_DIR/deploy/systemd/self-healing-deploy.timer" \
      /etc/systemd/system/self-healing-deploy.timer
    systemctl daemon-reload
    systemctl enable --now self-healing-deploy.timer \
      || add_todo "self-healing-deploy.timer failed to enable — merges will NOT reach this VM automatically"
    log "CD timer enabled (pull origin/main every 2 min)"
  else
    add_todo "deploy/systemd/self-healing-deploy.* absent — no CD; merges will not reach this VM"
  fi
fi

# ---- 11. observability config + services -----------------------------------------
# Install the repo's prometheus/grafana/caddy configs, seed the Grafana admin
# password from Secret Manager, and start the stack. Configs live in the repo,
# so this is guarded on the clone. Idempotent: install/overwrite + enable are
# safe to re-run. Everything binds to localhost except Caddy (80/443).
if [ -d "$SH_DIR" ]; then
  log "[11/11] observability config + services"

  # node_exporter textfile dir — the watcher cron (runs as $AGENT_USER) writes
  # selfheal_watcher.prom here; node_exporter (its own user) reads it. Owned by
  # the writer, world-readable so the reader picks it up.
  mkdir -p /var/lib/node_exporter/textfile
  chown -R $AGENT_USER:$AGENT_USER /var/lib/node_exporter
  chmod 0755 /var/lib/node_exporter /var/lib/node_exporter/textfile

  # Prometheus + node_exporter systemd units (binaries installed in step 5).
  install -m 0644 "$SH_DIR/deploy/systemd/prometheus.service" \
    /etc/systemd/system/prometheus.service
  install -m 0644 "$SH_DIR/deploy/systemd/node_exporter.service" \
    /etc/systemd/system/node_exporter.service

  # Prometheus scrape config.
  install -m 0644 "$SH_DIR/deploy/prometheus/prometheus.yml" /etc/prometheus/prometheus.yml
  chown prometheus:prometheus /etc/prometheus/prometheus.yml

  # Grafana provisioning (datasources + dashboard provider) + dashboards dir.
  mkdir -p /etc/grafana/provisioning/datasources \
    /etc/grafana/provisioning/dashboards /etc/grafana/dashboards
  install -m 0644 "$SH_DIR/deploy/grafana/provisioning/datasources/prometheus.yml" \
    /etc/grafana/provisioning/datasources/prometheus.yml
  # Linear datasource (Infinity) — powers the Technical dashboard's incident
  # timeline (the real [Monitor] tickets, which live in Linear not Prometheus).
  install -m 0644 "$SH_DIR/deploy/grafana/provisioning/datasources/linear.yml" \
    /etc/grafana/provisioning/datasources/linear.yml
  install -m 0644 "$SH_DIR/deploy/grafana/provisioning/dashboards/dashboards.yml" \
    /etc/grafana/provisioning/dashboards/dashboards.yml
  # Dashboard JSONs (business + technical). Glob may not match; keep going.
  cp -f "$SH_DIR"/deploy/grafana/dashboards/*.json /etc/grafana/dashboards/ 2>/dev/null || true

  # Infinity datasource plugin — the "Linear" datasource above is of this type.
  # Without it the incident timeline panel has no datasource. Idempotent: skip
  # if already present. grafana-cli ships with the grafana package (step 5).
  # --homepath is required or grafana-cli aborts with "Could not find config
  # defaults"; --pluginsDir targets the provisioned plugins path.
  INFINITY_PLUGIN_ID=yesoreyeram-infinity-datasource
  if [ ! -d "/var/lib/grafana/plugins/$INFINITY_PLUGIN_ID" ]; then
    grafana cli --homepath /usr/share/grafana --pluginsDir /var/lib/grafana/plugins \
      plugins install "$INFINITY_PLUGIN_ID" \
      && chown -R grafana:grafana /var/lib/grafana/plugins \
      || add_todo "grafana cli failed to install $INFINITY_PLUGIN_ID — the Linear datasource + incident timeline are unavailable; re-run init or install manually"
  else
    log "grafana plugin $INFINITY_PLUGIN_ID already installed"
  fi

  # Grafana main config: render __CONSOLE_DOMAIN__ then install (root:grafana 0640).
  sed "s/__CONSOLE_DOMAIN__/$CONSOLE_DOMAIN/g" "$SH_DIR/deploy/grafana/grafana.ini" \
    > /etc/grafana/grafana.ini
  chown root:grafana /etc/grafana/grafana.ini
  chmod 0640 /etc/grafana/grafana.ini

  # Caddyfile: render __CONSOLE_DOMAIN__ then install.
  mkdir -p /etc/caddy
  sed "s/__CONSOLE_DOMAIN__/$CONSOLE_DOMAIN/g" "$SH_DIR/deploy/caddy/Caddyfile" \
    > /etc/caddy/Caddyfile

  # Grafana secrets → a root-only systemd EnvironmentFile. Keeps plaintext out
  # of grafana.ini / git. Two secrets live here, both interpolated by Grafana:
  #   GF_SECURITY_ADMIN_PASSWORD — initial admin password (Grafana's FIRST start;
  #                                rotate later via grafana-cli)
  #   LINEAR_API_KEY             — read by the provisioned Linear (Infinity)
  #                                datasource via $LINEAR_API_KEY
  mkdir -p /etc/systemd/system/grafana-server.service.d
  cat > /etc/systemd/system/grafana-server.service.d/10-self-healing.conf <<'DROPIN'
[Service]
EnvironmentFile=/etc/grafana/self-healing-admin.env
DROPIN
  # Start fresh (must exist even if empty, or the unit fails to start).
  GRAFANA_ENV_FILE=/etc/grafana/self-healing-admin.env
  ( umask 077; : > "$GRAFANA_ENV_FILE" )

  GRAFANA_ADMIN_PW=$(gcloud secrets versions access latest \
    --secret="$GRAFANA_ADMIN_SECRET" --project="$PROJECT_ID" 2>/dev/null || true)
  if [ -n "$GRAFANA_ADMIN_PW" ]; then
    ( umask 077; printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$GRAFANA_ADMIN_PW" \
      >> "$GRAFANA_ENV_FILE" )
    log "grafana admin password seeded from secret '$GRAFANA_ADMIN_SECRET'"
  else
    add_todo "Grafana admin password NOT seeded (secret '$GRAFANA_ADMIN_SECRET' missing/unreadable) — admin stays default admin/admin. Create the secret, ensure it is granted to the VM SA (grafana_admin_secret), re-run init."
  fi
  unset GRAFANA_ADMIN_PW

  # Linear API key for the Infinity "Linear" datasource (incident timeline).
  LINEAR_API_KEY_VALUE=$(gcloud secrets versions access latest \
    --secret="linear-api-key" --project="$PROJECT_ID" 2>/dev/null || true)
  if [ -n "$LINEAR_API_KEY_VALUE" ]; then
    ( umask 077; printf 'LINEAR_API_KEY=%s\n' "$LINEAR_API_KEY_VALUE" \
      >> "$GRAFANA_ENV_FILE" )
    log "LINEAR_API_KEY seeded from secret 'linear-api-key' (Infinity/Linear datasource)"
  else
    add_todo "LINEAR_API_KEY NOT seeded (secret 'linear-api-key' missing/unreadable) — the Linear (Infinity) datasource cannot authenticate; the incident timeline will be empty. Ensure the secret exists and is granted to the VM SA (secret_ids), re-run init."
  fi
  unset LINEAR_API_KEY_VALUE

  chown root:grafana "$GRAFANA_ENV_FILE"
  chmod 0640 "$GRAFANA_ENV_FILE"

  # Enable + start. All localhost-bound except Caddy (80/443).
  systemctl daemon-reload
  systemctl enable prometheus node_exporter grafana-server caddy
  systemctl restart prometheus    || add_todo "prometheus failed to start — journalctl -u prometheus"
  systemctl restart node_exporter || add_todo "node_exporter failed to start — journalctl -u node_exporter"
  systemctl restart grafana-server || add_todo "grafana-server failed to start — journalctl -u grafana-server"
  systemctl restart caddy         || add_todo "caddy failed to start — journalctl -u caddy"

  add_todo "Create DNS A record '$CONSOLE_DOMAIN' -> the reserved static IP (Terraform outputs 'console_static_ip' / 'console_dns_record') via the Namecheap API (GET all hosts, append this A record, setHosts). Until it resolves, Caddy cannot issue a TLS cert and the console is unreachable by name."
  add_todo "(optional, v2) Google OAuth client for Grafana SSO: redirect https://$CONSOLE_DOMAIN/login/google, store id/secret in Secret Manager, set grafana_google_oauth_* Terraform vars, uncomment [auth.google] in grafana.ini."
else
  add_todo "self-healing repo absent — observability config (prometheus/grafana/caddy) SKIPPED; fix clone and re-run init"
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
