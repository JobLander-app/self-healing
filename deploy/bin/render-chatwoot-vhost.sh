#!/usr/bin/env bash
# Render an optional extra reverse proxy; default deployments leave it disabled.
set -euo pipefail

domain="${1:-}"
port="${2:-3100}"
[ -n "$domain" ] || exit 0
label='[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?'
[[ "$domain" =~ ^($label\.)+$label$ ]] || { echo "render-chatwoot-vhost: invalid domain" >&2; exit 1; }
if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  echo "render-chatwoot-vhost: invalid port" >&2
  exit 1
fi

cat <<CADDY

# Chatwoot support app (docker compose stack at /opt/chatwoot). TLS is issued
# and renewed automatically by Caddy over ACME HTTP-01, which works because
# $domain resolves to this VM.
$domain {
	reverse_proxy localhost:$port
}
CADDY
