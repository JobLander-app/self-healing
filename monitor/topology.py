"""Reviewed monitoring intent, independent of resources that happen to exist.

Never discover the watchlist from running machines or recent logs: that would
erase a real outage. Explicit retirements also govern durable pending alerts.
"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

TARGETS_FILE = Path(__file__).with_name("targets.json")
NAME = re.compile(r"[a-z][a-z0-9-]{0,62}\Z")


def load_targets(path=None):
    value = json.loads(Path(path or TARGETS_FILE).read_text())
    if value.get("version") != 1 or not NAME.fullmatch(value.get("project", "")):
        raise ValueError("invalid monitoring target schema/project")
    livekit = value["livekit"]
    if (livekit.get("hosting") != "cloud" or not re.fullmatch(r"wss://[a-z0-9-]+\.livekit\.cloud", livekit.get("endpoint", ""))
            or not NAME.fullmatch(livekit.get("config_service", "")) or not NAME.fullmatch(livekit.get("config_region", ""))):
        raise ValueError("invalid LiveKit target")
    pools = value["voice_agents"]
    if not pools:
        raise ValueError("voice agent coverage cannot be empty")
    active = set()
    for pool in pools:
        if not all(NAME.fullmatch(pool.get(key, "")) for key in ("name", "region")):
            raise ValueError("invalid worker pool target")
        identity = (pool["name"], pool["region"])
        if identity in active:
            raise ValueError("duplicate worker pool target")
        active.add(identity)
    retired = set()
    prefixes = set()
    for resource in value["retired_resources"]:
        name = resource["name"]
        if not NAME.fullmatch(name) or name in retired or name in {name for name, _ in active}:
            raise ValueError("invalid, duplicate or still-active retirement")
        at = datetime.fromisoformat(resource["retired_at"].replace("Z", "+00:00"))
        if at.tzinfo is None or at > datetime.now(timezone.utc) or not resource["reason"] or not resource["evidence"].startswith("https://"):
            raise ValueError("retirement requires past effective time, reason and evidence")
        retired.add(name)
        for kind in ("signature_prefixes", "page_prefixes"):
            for prefix in resource[kind]:
                # Require a concrete resource boundary, never a service-wide
                # suppression or a similarly named replacement host.
                if not isinstance(prefix, str) or not re.search(rf"(?<![a-z0-9-]){re.escape(name)}(?=[: ])", prefix):
                    raise ValueError("retirement prefix must identify its resource")
                if kind == "signature_prefixes" and not prefix.endswith(":"):
                    raise ValueError("signature prefix must end at a scope boundary")
                if prefix in prefixes:
                    raise ValueError("duplicate retirement prefix")
                prefixes.add(prefix)
    return value


def revision(targets):
    return hashlib.sha256(json.dumps(targets, sort_keys=True).encode()).hexdigest()


def voice_filter(targets):
    scopes = [f'(resource.labels.worker_pool_name="{p["name"]}" AND resource.labels.location="{p["region"]}")'
              for p in targets["voice_agents"]]
    return 'resource.type="cloud_run_worker_pool" AND (' + " OR ".join(scopes) + ')'


def retirement(value, kind, targets):
    return next((resource for resource in targets["retired_resources"]
                 if any(value.startswith(prefix) for prefix in resource[kind])), None)


def describe(project, kind, name, region):
    args = ["gcloud", *(["beta"] if kind == "worker-pools" else []), "run", kind, "describe", name,
            f"--region={region}", f"--project={project}", "--format=json"]
    result = subprocess.run(args, capture_output=True, text=True, timeout=45, check=False)
    if result.returncode:
        # Permissions/network/404 are coverage failures, not HTTP 0 or proof
        # of intentional retirement. Do not disclose stderr or environment.
        raise RuntimeError("resource describe failed; verify deployment intent and access")
    value = json.loads(result.stdout)
    if not isinstance(value, dict) or value.get("metadata", {}).get("name") != name:
        raise ValueError("resource describe returned invalid identity")
    return value


def inspect_targets(targets, fetch=describe):
    """Separate configuration drift and missing coverage from application errors.

    Ready is a control-plane deployment condition, not synthetic call health.
    Log-based application error thresholds continue to apply independently.
    """
    observations = []
    for pool in targets["voice_agents"]:
        observation = {"name": pool["name"], "region": pool["region"], "status": "UNKNOWN"}
        try:
            resource = fetch(targets["project"], "worker-pools", pool["name"], pool["region"])
            condition = next((c for c in resource.get("status", {}).get("conditions", []) if c.get("type") == "Ready"), {})
            observation["status"] = {"True": "READY", "False": "NOT_READY"}.get(condition.get("status"), "UNKNOWN")
        except Exception:
            pass
        observations.append(observation)
    cloud = targets["livekit"]
    observation = {"name": "livekit-config", "region": cloud["config_region"], "status": "UNKNOWN"}
    try:
        app = fetch(targets["project"], "services", cloud["config_service"], cloud["config_region"])
        containers = app["spec"]["template"]["spec"]["containers"]
        urls = [env["value"] for container in containers for env in container.get("env", [])
                if env.get("name") == "LIVEKIT_URL" and isinstance(env.get("value"), str)]
        if urls:
            observation["status"] = "MATCH" if all(url == cloud["endpoint"] for url in urls) else "DRIFT"
    except Exception:
        pass
    observations.append(observation)
    return observations
