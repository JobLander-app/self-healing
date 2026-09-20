#!/usr/bin/env python3
"""Standalone hourly monitor. No workspace launcher, manager context or git pulls."""
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request

PROJECT = "meet-assistant-6d8ad"
MONITOR_DIR = Path(__file__).resolve().parent
ESCALATION_ACTIONS = {"telegram_p0_and_linear", "linear_create_if_no_dup", "linear_ensure_open_issue"}
# These SFU hosts were intentionally retired on 2026-09-19 for LiveKit Cloud.
# Remove their infrastructure and VM log alerts, including pre-migration work.
RETIRED_LK_VMS = {"lk-eu-west4", "lk-us-central1", "lk-asia-south1", "lk-au-southeast1"}
RETIRED_LK_SIGNATURES = {
    signature for vm in RETIRED_LK_VMS
    for signature in (f"lk-server:{vm}:down", f"lk-vm:{vm}:disk-usage-high")
}


def retired_lk_signature(signature):
    return signature in RETIRED_LK_SIGNATURES or any(
        signature.startswith(f"voice-agent:{vm}:") for vm in RETIRED_LK_VMS)


def retired_lk_page(alert):
    return any(alert.startswith((f"URGENT P0: LiveKit server {vm} HTTP ",
                                 f"URGENT P0: voice-agent:{vm}:"))
               for vm in RETIRED_LK_VMS)


def timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path, value):
    path = Path(path)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
            temp = output.name
            json.dump(value, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        # Persist the rename too: an acknowledged outbox update must survive reboot.
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


@dataclass
class Config:
    state_dir: Path
    legacy_dirs: tuple
    # Same as the old launcher: migration waits for an in-flight legacy session.
    lock_file: Path = Path("/tmp/joblander-Monitor.lock")
    provider_log_dir: Path = Path("/var/log/self-healing-monitor/turns")
    metrics_file: Path = Path("/var/lib/node_exporter/textfile/selfheal_monitor.prom")
    max_seconds: int = 1800

    @classmethod
    def from_env(cls):
        home = Path.home()
        return cls(
            state_dir=Path(os.environ.get("MONITOR_STATE_DIR", str(home / ".local/state/self-healing/monitor"))).resolve(),
            legacy_dirs=(home / "workspace/teams/logs/monitoring", home / "joblander/workspace/teams/logs/monitoring"),
            provider_log_dir=Path(os.environ.get("MONITOR_LOG_DIR", "/var/log/self-healing-monitor/turns")),
            metrics_file=Path(os.environ.get("MONITOR_METRICS_FILE", "/var/lib/node_exporter/textfile/selfheal_monitor.prom")),
        )


@contextmanager
def monitor_lock(path):
    with open(path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def migrate_state(config):
    """Copy once under the shared lock; leave the old tree intact for rollback."""
    target = config.state_dir
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    source = next((path for path in config.legacy_dirs if path.is_dir()), None)
    temporary = Path(tempfile.mkdtemp(prefix=".monitor-migration-", dir=target.parent))
    try:
        if source:
            shutil.copytree(source, temporary, dirs_exist_ok=True)
        write_json(temporary / "state-migration.json", {"at": timestamp(), "source": str(source) if source else None})
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def secret(name):
    result = subprocess.run(
        ["gcloud", "secrets", "versions", "access", "latest", f"--secret={name}", f"--project={PROJECT}"],
        capture_output=True, text=True, timeout=20, check=False,
    )
    if result.returncode or not result.stdout.strip():
        raise RuntimeError(f"Secret Manager could not resolve {name}")
    return result.stdout.strip()


def collect(config):
    env = {**os.environ, "MONITOR_STATE_DIR": str(config.state_dir), "PYTHONDONTWRITEBYTECODE": "1"}
    with open(config.state_dir / "last-triage-run.log", "w") as output:
        return subprocess.run(["python3", str(MONITOR_DIR / "triage.py")], cwd=config.state_dir,
                              env=env, stdout=output, stderr=subprocess.STDOUT, timeout=1200, check=False).returncode


def load_triage(config):
    summary = json.loads((config.state_dir / "triage-summary.json").read_text())
    at = datetime.fromisoformat(summary["timestamp"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - at).total_seconds()
    if summary.get("triage_failed") or not -60 <= age <= 900:
        raise RuntimeError("triage failed or its summary is stale")
    if not isinstance(summary.get("escalations"), list) or not isinstance(summary.get("p0_alerts"), list):
        raise RuntimeError("triage summary has invalid actions")
    if any(not isinstance(item, dict) or item.get("action") not in ESCALATION_ACTIONS
           or not isinstance(item.get("signature"), str) or not item["signature"] for item in summary["escalations"]):
        raise RuntimeError("triage contains an unknown escalation action")
    if any(not isinstance(alert, str) or not alert for alert in summary["p0_alerts"]):
        raise RuntimeError("triage contains an invalid P0 alert")
    return summary


def prepare_escalations(config, summary):
    """Keep prepared work across quota failures, including P2 that stops being new."""
    path = config.state_dir / "linear-outbox.json"
    pending = json.loads(path.read_text()) if path.exists() else {}
    for suppressed in summary.get("cooldown_suppressed", []):
        pending.pop(suppressed["signature"], None)
    for item in summary["escalations"]:
        pending[item["signature"]] = {**item, "prepared_at": summary["timestamp"]}
    pending = {signature: item for signature, item in pending.items()
               if not retired_lk_signature(signature)}
    write_json(path, pending)
    batch = {**summary, "escalations": list(pending.values())}
    write_json(config.state_dir / "escalation-batch.json", batch)
    return batch


def acknowledge_escalations(config, batch, actions):
    """A final marker alone is not coverage: acknowledge recorded outcomes only."""
    required = {item["signature"] for item in batch["escalations"]}
    covered = {signature for signature, issue in actions.get("issue_by_signature", {}).items()
               if isinstance(issue, str) and re.fullmatch(r"JOB-[1-9]\d*|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", issue)}
    for duplicate in actions.get("pr_duplicates", []):
        if (isinstance(duplicate, dict) and isinstance(duplicate.get("signature"), str)
                and isinstance(duplicate.get("url"), str)
                and re.fullmatch(r"https://github\.com/JobLander-app/[^/]+/pull/[1-9]\d*", duplicate["url"])):
            covered.add(duplicate["signature"])
    path = config.state_dir / "linear-outbox.json"
    pending = json.loads(path.read_text())
    for signature in required & covered:
        pending.pop(signature, None)
    write_json(path, pending)
    return sorted(required - covered)


def telegram_credentials():
    token, chat = os.environ.get("TG_BOT_TOKEN"), os.environ.get("TG_CHAT_ID")
    if token and chat:
        return token, chat
    # Existing credential retains its historical name; no workspace file needed.
    values = {}
    for line in secret("self-healing-workspace-env").splitlines():
        key, sep, value = line.removeprefix("export ").strip().partition("=")
        if sep and key in {"TG_BOT_TOKEN", "TG_CHAT_ID"}:
            parsed = shlex.split(value, comments=True)
            values[key] = parsed[0] if parsed else ""
    token, chat = token or values.get("TG_BOT_TOKEN"), chat or values.get("TG_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("Telegram credentials unavailable")
    return token, chat


def send_p0(alert):
    token, chat = telegram_credentials()
    request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage",
                                    data=json.dumps({"chat_id": chat, "text": alert}).encode(),
                                    headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if not json.load(response).get("ok"):
                raise RuntimeError("Telegram rejected P0")
    except Exception:
        # Exception URLs can contain the bot token.
        raise RuntimeError("Telegram P0 delivery failed") from None


def deliver_pending(config, alerts, pager):
    """At-least-once delivery; commit the outbox before contacting Telegram."""
    path = config.state_dir / "p0-outbox.json"
    pending = json.loads(path.read_text()) if path.exists() else {}
    for alert in alerts:
        pending.setdefault(hashlib.sha256(alert.encode()).hexdigest(), alert)
    pending = {key: alert for key, alert in pending.items() if not retired_lk_page(alert)}
    write_json(path, pending)
    sent, failures = [], []
    for key, alert in list(pending.items()):
        try:
            pager(alert)
            sent.append(alert)
            del pending[key]
            write_json(path, pending)
        except Exception:
            failures.append("P0 delivery failed; retained for retry")
    return sent, failures


def provider_env(config):
    # Reuse the same rendered SHL credentials and verified provider configuration.
    # Process env wins, then component-specific paths/budgets isolate monitor state.
    values = {}
    env_file = MONITOR_DIR.parent / "dispatcher/.env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.strip().removeprefix("export ").partition("=")
            if sep and key and not key.startswith("#"):
                parsed = shlex.split(value, comments=True)
                values[key] = parsed[0] if parsed else ""
    values.update(os.environ)
    values["LOG_DIR"] = str(config.provider_log_dir)
    values["MAX_RUN_MS"] = str(config.max_seconds * 1000)
    values["CLAUDE_MAX_TURNS"] = values.get("MONITOR_MAX_TURNS", "40")
    if not values.get("CLAUDE_CODE_OAUTH_TOKEN"):
        try:
            values["CLAUDE_CODE_OAUTH_TOKEN"] = secret("claude-code-oauth-token")
        except (RuntimeError, OSError, subprocess.SubprocessError):
            pass  # shared provider runner may still use authenticated Codex
    return values


def stop_session(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def session_error(output):
    marker = output.rfind("[SESSION_END]")
    if marker >= 0:
        try:
            outcome, _ = json.JSONDecoder().raw_decode(output[marker + len("[SESSION_END]"):].strip())
            if outcome.get("type") != "monitor":
                return "monitor escalation returned missing or invalid session type"
            if outcome.get("status") == "success":
                return None
            reason = outcome.get("reason")
            if outcome.get("status") == "failed" and isinstance(reason, str) and reason.strip():
                return "monitor escalation failed: " + reason.strip()[:1000]
        except (ValueError, AttributeError):
            pass
    return "monitor escalation did not report success"


def session_succeeded(output):
    return session_error(output) is None


def parse_provider_result(log_file):
    # The shared adapter emits a final JSON object after its operational logs.
    for line in reversed(log_file.read_text().splitlines()):
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(result, dict) and isinstance(result.get("attempts"), list) and "output" in result:
            return result
    return {"output": "", "error": "provider runner exited without a result", "attempts": []}


def run_session(config):
    runtime = config.state_dir / "runtime"
    runtime.mkdir(exist_ok=True)
    # The agent starts outside every repository and receives only monitor context.
    prepared = config.state_dir / "escalation-batch.json"
    shutil.copy2(prepared if prepared.exists() else config.state_dir / "triage-summary.json", runtime / "triage-summary.json")
    write_json(runtime / "linear-actions.json", {"linear_created": [], "linear_commented": [], "issue_by_signature": {}})
    log_dir = config.state_dir / "sessions"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ") + ".jsonl")
    prompt = (MONITOR_DIR / "prompt.md").read_text() + "\n\nCurrent UTC: " + timestamp()
    failure = None
    with open(log_file, "w") as output:
        process = subprocess.Popen(["node", str(MONITOR_DIR.parent / "dispatcher/dist/providerCli.js")],
                                   cwd=runtime, env=provider_env(config), stdin=subprocess.PIPE,
                                   stdout=output, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        start = time.monotonic()
        try:
            process.stdin.write(prompt)
            process.stdin.close()
            while process.poll() is None:
                if time.monotonic() - start > config.max_seconds + 15:
                    raise RuntimeError("monitor provider runner exceeded its time budget")
                time.sleep(1)
        except (RuntimeError, OSError) as error:
            failure = str(error)
        finally:
            stop_session(process)
    result = parse_provider_result(log_file)
    errors = [error for error in (result.get("error"), failure) if error]
    marker_error = session_error(result["output"])
    # Keep explicit agent diagnostics alongside adapter/launcher failures. An
    # absent marker adds no useful detail to an already-known transport failure.
    if marker_error and (marker_error != "monitor escalation did not report success" or not errors):
        errors.append(marker_error)
    result["error"] = "; ".join(dict.fromkeys(errors)) or (
        "monitor provider exited unsuccessfully" if process.returncode else None)
    actions_path = runtime / "linear-actions.json"
    try:
        shutil.copy2(actions_path, log_file.with_suffix(".actions.json"))
        actions = json.loads(actions_path.read_text())
        if (not isinstance(actions, dict)
                or not all(isinstance(actions.get(key), list) for key in ("linear_created", "linear_commented"))
                or not isinstance(actions.get("issue_by_signature"), dict)):
            raise ValueError("invalid action record")
        result["actions"] = actions
    except (ValueError, OSError):
        result["error"] = result.get("error") or "monitor returned an invalid action record"
    return result


def publish_heartbeat(result):
    if result["status"] != "success":
        return False
    message = "MONITOR_HEARTBEAT success " + json.dumps({
        "triageAt": result["triageAt"], "llmSkipped": result["llmSkipped"], "finishedAt": result["finishedAt"],
    })
    try:
        return subprocess.run(["gcloud", "logging", "write", "self-healing-monitor", message,
                               "--severity=INFO", f"--project={PROJECT}"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def write_metrics(config, result):
    # Rebuild token counters from the shared durable attempt ledger. Null usage
    # stays unknown: publish coverage separately, never invent zero token counts.
    ledger = config.provider_log_dir.parent / "usage-ledger.jsonl"
    attempts = {}
    if ledger.exists():
        for line in ledger.read_text().splitlines():
            try:
                record = json.loads(line)
                if record.get("kind") in {"attempt", "attempt_started"}:
                    old = attempts.get(record["id"])
                    if not old or record["kind"] == "attempt":
                        attempts[record["id"]] = record
            except (ValueError, KeyError):
                continue
    totals, missing = {}, {}
    for record in attempts.values():
        attempt = record["data"]
        # SDK modelUsage identifies the actual billed model(s); don't attribute
        # their aggregate again to the requested model alias.
        models = attempt.get("models") or [{"model": attempt["model"], "usage": attempt.get("usage", {})}]
        for model in models:
            for kind in ("input", "cachedInput", "cacheWrite", "output"):
                key = (attempt["provider"], model["model"], kind)
                value = model.get("usage", {}).get(kind)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                    totals[key] = totals.get(key, 0) + value
                else:
                    missing[key] = missing.get(key, 0) + 1
    lines = [f'selfheal_monitor_last_run_success {int(result["status"] == "success")}',
             f'selfheal_monitor_last_run_llm_skipped {int(result["llmSkipped"])}',
             f'selfheal_monitor_last_run_timestamp_seconds {datetime.fromisoformat(result["finishedAt"].replace("Z", "+00:00")).timestamp()}']
    for name, values in (("tokens_total", totals), ("attempts_missing_usage_total", missing)):
        for (provider, model, kind), value in sorted(values.items()):
            labels = f'provider={json.dumps(provider)},model={json.dumps(model)},kind={json.dumps(kind)}'
            lines.append(f'selfheal_monitor_{name}{{{labels}}} {value}')
    if config.metrics_file.parent.is_dir():
        with tempfile.NamedTemporaryFile(mode="w", dir=config.metrics_file.parent, delete=False) as output:
            output.write("\n".join(lines) + "\n")
            temp = output.name
        os.chmod(temp, 0o644)
        os.replace(temp, config.metrics_file)


def run_once(config, collector=collect, session_runner=run_session, pager=send_p0, publisher=publish_heartbeat):
    result = {"startedAt": timestamp(), "finishedAt": None, "status": "failed", "llmSkipped": True,
              "triageAt": None, "telegramSent": [], "attempts": [], "errors": []}
    try:
        if collector(config) != 0:
            raise RuntimeError("triage collection failed")
        summary = load_triage(config)
        result["triageAt"] = summary["timestamp"]
        batch = prepare_escalations(config, summary)
        sent, failures = deliver_pending(config, summary["p0_alerts"], pager)
        result["telegramSent"].extend(sent)
        result["errors"].extend(failures)
        actions = {"linear_created": [], "linear_commented": [], "issue_by_signature": {}}
        if batch["escalations"]:
            result["llmSkipped"] = False
            provider_result = session_runner(config)
            result["attempts"] = provider_result["attempts"]
            if provider_result.get("error"):
                result["errors"].append(provider_result["error"])
            actions = provider_result.get("actions", actions)
            result["actions"] = actions
            if actions.get("errors"):
                result["errors"].append("monitor action record contains unresolved errors")
        report_path = config.state_dir / "latest-report.json"
        report = json.loads(report_path.read_text())
        report["actions"] = {"telegram_sent": result["telegramSent"],
                             "linear_created": actions["linear_created"], "linear_commented": actions["linear_commented"]}
        for group in report.get("error_groups", []):
            if group["signature"] in actions.get("issue_by_signature", {}):
                group["linear_issue"] = actions["issue_by_signature"][group["signature"]]
        write_json(report_path, report)
        if batch["escalations"]:
            result["pendingSignatures"] = acknowledge_escalations(config, batch, actions)
            if result["pendingSignatures"]:
                result["errors"].append("escalations lack recorded outcomes: " + ", ".join(result["pendingSignatures"]))
        if not result["errors"]:
            result["status"] = "success"
    except Exception as error:
        result["errors"].append(str(error))
        if result["triageAt"] is None:
            try:
                sent, failures = deliver_pending(config, [], pager)
                result["telegramSent"].extend(sent)
                result["errors"].extend(failures)
            except (ValueError, OSError) as outbox_error:
                result["errors"].append(f"P0 outbox retry failed: {outbox_error}")
    result["finishedAt"] = timestamp()
    result["heartbeatPublished"] = publisher(result)
    write_json(config.state_dir / "last-session.json", result)
    try:
        write_metrics(config, result)
    except (OSError, ValueError, KeyError):
        print("Monitor metrics write failed", flush=True)
    print("MONITOR_HEARTBEAT " + json.dumps(result), flush=True)
    print("[SESSION_END] " + json.dumps({"type": "monitor", "timestamp": result["finishedAt"],
                                        "status": result["status"], "llmSkipped": result["llmSkipped"]}), flush=True)
    return 0 if result["status"] == "success" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--migrate-only", action="store_true", help="migrate local state under the shared lock, without collection or inference")
    args = parser.parse_args(argv)
    def interrupted(signum, frame):
        raise InterruptedError("monitor interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    config = Config.from_env()
    with monitor_lock(config.lock_file) as acquired:
        if not acquired:
            print("Monitor already running; skipped", flush=True)
            return 1 if args.migrate_only else 0
        migrate_state(config)
        if args.migrate_only:
            return 0
        print("[SESSION_START] " + json.dumps({"type": "monitor", "timestamp": timestamp()}), flush=True)
        return run_once(config)


if __name__ == "__main__":
    raise SystemExit(main())
