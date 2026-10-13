#!/usr/bin/env bash
# Prints the Caddy vhost for the Chatwoot support app, or nothing when the
# domain is empty.
#
# The one renderer for this block: init.sh appends it on provisioning and
# self-healing-deploy.sh appends it on every release that installs the
# Caddyfile. On 2026-10-13 a release installed the console-only template,
# because only init.sh knew about this vhost, and chat.joblander.app (loaded
# as a script on every joblander.app page) was down for an hour.
#
#   render-chatwoot-vhost.sh <domain> [port]
set -euo pipefail

domain="${1:-}"
port="${2:-3100}"
[ -n "$domain" ] || exit 0
[[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "render-chatwoot-vhost: invalid domain" >&2; exit 1; }
[[ "$port" =~ ^[0-9]+$ ]] || { echo "render-chatwoot-vhost: invalid port" >&2; exit 1; }

cat <<CADDY

# Chatwoot support app (docker compose stack at /opt/chatwoot). TLS is issued
# and renewed automatically by Caddy over ACME HTTP-01, which works because
# $domain resolves to this VM.
$domain {
	reverse_proxy localhost:$port
}
CADDY
