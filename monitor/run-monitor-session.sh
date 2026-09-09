#!/usr/bin/env bash
# Single hourly entrypoint; code and prompts belong to self-healing.
set -euo pipefail
MONITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$MONITOR_DIR/run_monitor.py"
