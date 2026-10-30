"""Consumer configuration shared by every launcher. No network or secret reads."""
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

DEFAULT_PROFILE = "/etc/self-healing/profile.json"


def load_profile(filename=None, environ=None, allow_example=False):
    inherited = dict(os.environ if environ is None else environ)
    path = Path(filename or inherited.get("SELF_HEALING_PROFILE", DEFAULT_PROFILE)).resolve()
    value = json.loads(path.read_text())
    if value.get("version") != 1 or not isinstance(value.get("env"), dict):
        raise ValueError("profile must have version=1 and an env object")
    if not all(re.fullmatch(r"[A-Z][A-Z0-9_]*", k) and isinstance(v, str) and "\n" not in v
               for k, v in value["env"].items()):
        raise ValueError("profile env must contain uppercase names and single-line strings")
    user = value.get("deployment", {}).get("agent_user", "selfheal")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,30}", user):
        raise ValueError("deployment.agent_user must be a Linux account name")
    home = f"/home/{user}"
    env = {
        "DRY_RUN": "true", "AUTO_MERGE": "false", "FIREBASE_ENABLED": "false", "SENTRY_ENABLED": "false",
        "LOG_DIR": "/var/log/job-dispatcher/turns",
        "WATCH_STATE_FILE": f"{home}/.output-watch-state",
        "WATCH_TG_ENV_FILE": f"{home}/.config/self-healing/telegram.env",
        "MONITOR_STATE_DIR": f"{home}/.local/state/self-healing/monitor",
        "MONITOR_LOCK_FILE": "/tmp/self-healing-monitor.lock",
        **value["env"], **inherited,
    }
    env["SELF_HEALING_PROFILE"] = str(path)
    env["GCP_PROJECT_ID"] = env.get("GCP_PROJECT", "")
    for key in ("GCP_PROJECT", "LINEAR_TEAM", "LINEAR_TEAM_ID", "LINEAR_MONITOR_LABEL_ID",
                "LINEAR_AGENT_CLAIMED_LABEL_ID", "WATCH_URL", "TG_CHAT_ID", "TRACKED_REPOS"):
        if not env.get(key, "").strip():
            raise ValueError(f"{key} is required")
    for key in ("LINEAR_TEAM_ID", "LINEAR_MONITOR_LABEL_ID", "LINEAR_AGENT_CLAIMED_LABEL_ID"):
        if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", env[key]):
            raise ValueError(f"{key} must be a Linear UUID")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,61}[a-z0-9]", env["GCP_PROJECT"]):
        raise ValueError("GCP_PROJECT must be a GCP project ID")
    url = urlsplit(env["WATCH_URL"])
    if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password:
        raise ValueError("WATCH_URL must be an HTTP(S) origin without credentials")
    for repo in env["TRACKED_REPOS"].split(","):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo.strip()):
            raise ValueError("TRACKED_REPOS must contain owner/repo slugs")
    for key in ("DRY_RUN", "AUTO_MERGE", "FIREBASE_ENABLED", "SENTRY_ENABLED", "CODEX_ENABLED", "OPENCODE_ENABLED"):
        if env.get(key, "false") not in ("true", "false"):
            raise ValueError(f"{key} must be true or false")
    if env["SENTRY_ENABLED"] == "true":
        for key in ("SENTRY_ORG", "SENTRY_PROJECT_ID", "SENTRY_SERVICE", "SENTRY_TOKEN_SECRET"):
            if not env.get(key):
                raise ValueError(f"{key} is required when Sentry is enabled")
    for key, target in (("targets", "MONITOR_TARGETS_FILE"), ("policy", "CONSUMER_POLICY_FILE"),
                        ("monitor_adapter", "MONITOR_ADAPTER")):
        if key == "monitor_adapter" and not value.get(key):
            env.pop(target, None)
            continue
        resolved = (path.parent / value[key]).resolve()
        if not resolved.is_file():
            raise ValueError(f"profile {key} file is absent: {resolved}")
        env[target] = str(resolved)
    targets = json.loads(Path(env["MONITOR_TARGETS_FILE"]).read_text())
    if targets.get("project") != env["GCP_PROJECT"]:
        raise ValueError("targets.project and GCP_PROJECT must match")
    if not allow_example and any("REPLACE_ME" in v or "example.com" in v or "your-gcp-project" in v
                                 or "your-org/" in v or v.startswith("00000000-") for v in value["env"].values()):
        raise ValueError("example placeholders remain; copy consumers/example and configure your own values")
    return value, env, {"__AGENT_USER__": user, "__AGENT_HOME__": home,
                        "__PROFILE_PATH__": str(path), "__LINEAR_TEAM_ID__": env["LINEAR_TEAM_ID"]}
