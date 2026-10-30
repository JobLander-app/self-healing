#!/usr/bin/env python3
"""Read-only release verification, streamed by CI over SSH; never restarts a service."""
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def snapshot(checkout, user):
    head = run("sudo", "-n", "-u", user, "git", "-C", str(checkout), "rev-parse", "HEAD")
    with urllib.request.urlopen("http://127.0.0.1:4100/health", timeout=5) as response:
        health = json.load(response)
    with urllib.request.urlopen("http://127.0.0.1:4200/healthz", timeout=5) as response:
        ingest = json.load(response)
    active = all(run("systemctl", "is-active", unit) == "active" for unit in (
        "claude-code-vm-job-dispatcher.service", "self-healing-change-ingest.service",
        "self-healing-deploy.timer"))
    selected = str(Path("/etc/self-healing/profile.json").resolve(strict=True))
    loaded = True
    for unit in ("claude-code-vm-job-dispatcher.service", "self-healing-change-ingest.service"):
        pid = run("systemctl", "show", unit, "--property=MainPID", "--value")
        env = dict(part.split("=", 1) for part in Path(f"/proc/{pid}/environ").read_text().split("\0") if "=" in part)
        loaded = loaded and env.get("SELF_HEALING_PROFILE") == selected
    pending = (checkout / ".deploying").exists() or Path("/var/lib/self-healing-deploy/transaction.env").exists()
    return {"head": head, "active": active, "pending": pending, "profileLoaded": loaded, "status": health.get("status"),
            "ready": health.get("ready"), "providers": health.get("providers"),
            "accountingHealthy": health.get("accounting", {}).get("healthy"),
            "changeFeedReadable": isinstance(ingest.get("rowCount"), int)}


def activated(state, expected):
    return (state["head"] == expected and state["active"] and not state["pending"]
            and state["profileLoaded"] and state["status"] == "ok"
            and state["accountingHealthy"] and state["changeFeedReadable"])


def main():
    expected, checkout, user = sys.argv[1:]
    deadline, good = time.monotonic() + 1100, 0
    while time.monotonic() < deadline:
        try:
            state = snapshot(Path(checkout), user)
            print(json.dumps(state), flush=True)
            good = good + 1 if activated(state, expected) else 0
            # Observe a full minute after activation. Provider evidence can be
            # stale without a new paid session: report it, never fabricate it.
            if good >= 5:
                print("Release activated and stable for one minute.")
                return
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            print(f"Waiting for runtime: {type(error).__name__}", flush=True)
            good = 0
        time.sleep(15)
    raise SystemExit("Release did not reach a verified stable runtime before the deadline")


if __name__ == "__main__":
    main()
