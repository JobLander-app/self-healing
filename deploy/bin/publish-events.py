#!/usr/bin/env python3
"""Publish bounded run telemetry from the durable ledger. At-least-once delivery."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile


def event(record):
    if record.get('kind') != 'run':
        return None
    run = record['data']
    # Never export prompts, issue descriptions, tool output, credentials or error text.
    return {'event': 'run.finished', 'runId': run['turnId'], 'outcome': run['outcome'],
            'durationSec': run['durationSec'], 'dryRun': run['dryRun'],
            'finishedAt': run['finishedAt']}


def publish(payload):
    subprocess.run(['gcloud', 'logging', 'write', 'self-healing-events', json.dumps(payload),
                    '--payload-type=json', '--severity=INFO', '--project=' + os.environ['GCP_PROJECT']],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=20)


def save_cursor(cursor, offset):
    with tempfile.NamedTemporaryFile(mode='w', dir=cursor.parent, delete=False) as output:
        json.dump({'offset': offset}, output)
        output.flush()
        os.fsync(output.fileno())
        temporary = output.name
    os.replace(temporary, cursor)
    directory = os.open(cursor.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def deliver(ledger, cursor, send=publish, limit=100):
    cursor.parent.mkdir(parents=True, exist_ok=True)
    with open(str(cursor) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not cursor.exists():
            # Do not backfill old investigations as new Cloud Logging events.
            save_cursor(cursor, ledger.stat().st_size if ledger.exists() else 0)
            return
        if not ledger.exists():
            return
        saved = json.loads(cursor.read_text())
        if saved['offset'] > ledger.stat().st_size:
            raise RuntimeError('Ledger shrank; preserve it and reconcile telemetry cursor')
        with ledger.open('rb') as source:
            source.seek(saved['offset'])
            for _ in range(limit):
                line = source.readline(4 * 1024 * 1024 + 1)
                if not line or not line.endswith(b'\n'):
                    break
                payload = event(json.loads(line))
                if payload:
                    send(payload)
                # Ack only after the logging service confirms. A crash in this gap
                # can duplicate telemetry; never use these counters for billing.
                save_cursor(cursor, source.tell())


if __name__ == '__main__':
    root = Path(os.environ.get('LOG_DIR', '/var/log/job-dispatcher/turns')).parent
    deliver(root / 'usage-ledger.jsonl', root / 'cloud-events-cursor.json')
