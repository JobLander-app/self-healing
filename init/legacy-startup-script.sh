#!/bin/bash
# JobLander Agent VM — Provisioning Script
# Runs as startup-script on first boot or manually: sudo bash setup-vm.sh
#
# Installs: Node.js 20, Claude Code CLI, GitHub CLI, Docker, Chromium, git

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "=== JobLander Agent VM Setup ==="
echo "Started at: $(date)"

# --- System updates ---
echo "[1/8] System update..."
apt-get update -qq
apt-get upgrade -y -qq

# --- Git ---
echo "[2/8] Installing git..."
apt-get install -y -qq git curl wget unzip jq

# --- Node.js 20 (LTS) ---
echo "[3/8] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g yarn

# --- Claude Code CLI ---
echo "[4/8] Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# --- GitHub CLI ---
echo "[5/8] Installing GitHub CLI..."
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null
apt-get update -qq
apt-get install -y -qq gh

# --- Docker ---
echo "[6/8] Installing Docker..."
curl -fsSL https://get.docker.com | sh
usermod -aG docker joblander 2>/dev/null || true

# --- Chromium (headless for Puppeteer) ---
echo "[7/8] Installing Chromium + dependencies..."
apt-get install -y -qq \
  chromium-browser \
  fonts-liberation \
  libappindicator3-1 \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils

# Set Puppeteer to use system Chromium
echo 'export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser' >> /etc/environment
echo 'export PUPPETEER_SKIP_DOWNLOAD=true' >> /etc/environment

# --- Create joblander user ---
echo "[8/8] Setting up joblander user..."
if ! id -u joblander &>/dev/null; then
  useradd -m -s /bin/bash joblander
  usermod -aG docker joblander
fi

# Create project directory
mkdir -p /home/joblander/joblander
chown -R joblander:joblander /home/joblander

echo ""
echo "=== Setup complete at $(date) ==="
echo ""
echo "MANUAL STEPS REQUIRED (run as joblander user):"
echo "  sudo su - joblander"
echo ""
echo "  1. Configure git:"
echo "     git config --global user.name 'JobLander Agent'"
echo "     git config --global user.email 'agent@joblander.app'"
echo ""
echo "  2. Authenticate GitHub CLI:"
echo "     gh auth login"
echo ""
echo "  3. Clone workspace:"
echo "     cd ~ && git clone git@github.com:JobLander-app/joblander.git"
echo ""
echo "  4. Set Anthropic API key:"
echo "     echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.bashrc"
echo ""
echo "  5. Configure Telegram:"
echo "     cp ~/joblander/teams/.env.example ~/joblander/teams/.env"
echo "     nano ~/joblander/teams/.env"
echo ""
echo "  6. Set up cron:"
echo "     crontab -e"
echo "     0 3 * * * /home/joblander/joblander/teams/scripts/run-session.sh"
echo ""
echo "  7. Test:"
echo "     /home/joblander/joblander/teams/scripts/notify.sh 'VM setup complete'"
echo ""
