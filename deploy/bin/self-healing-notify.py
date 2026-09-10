#!/usr/bin/env python3
"""Standalone plain-text deployment notification; no workspace launcher/scripts."""
import json
import os
import subprocess
import sys
import urllib.request


def credentials():
    values = dict(os.environ)
    if not values.get('TG_BOT_TOKEN') or not values.get('TG_CHAT_ID'):
        result = subprocess.run([
            'gcloud', 'secrets', 'versions', 'access', 'latest',
            '--secret=' + os.environ.get('SH_NOTIFY_SECRET', 'self-healing-workspace-env'),
            '--project=' + os.environ.get('GCP_PROJECT', 'meet-assistant-6d8ad'),
        ], capture_output=True, text=True, timeout=15, check=True)
        for line in result.stdout.splitlines():
            key, sep, value = line.strip().removeprefix('export ').partition('=')
            if sep and key.strip() in ('TG_BOT_TOKEN', 'TG_CHAT_ID'):
                if not values.get(key.strip()):
                    values[key.strip()] = value.strip().strip('\'"')
    token, chat = values.get('TG_BOT_TOKEN'), values.get('TG_CHAT_ID')
    if not token or not chat:
        raise ValueError('Telegram credentials unavailable')
    return token, chat


def main():
    token, chat = credentials()
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=json.dumps({'chat_id': chat, 'text': sys.argv[1]}).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        body = json.load(response)
        if body.get('ok') is not True or type(body.get('result', {}).get('message_id')) is not int:
            raise ValueError('Telegram did not confirm delivery')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Network exceptions may contain the token-bearing request URL.
        print('self-healing deployment notification failed', file=sys.stderr)
        sys.exit(1)
