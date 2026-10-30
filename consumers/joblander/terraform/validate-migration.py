#!/usr/bin/env python3
"""Allow only the reviewed, non-disruptive first portable infrastructure rollout."""
import json
import sys

PROJECT = "meet-assistant-6d8ad"
NEW_RESOURCES = {
    "module.dashboard.google_logging_metric.runs",
    "module.dashboard.google_logging_metric.duration",
    "module.dashboard.google_logging_metric.dispatcher_heartbeat",
    "module.dashboard.google_monitoring_dashboard.loop",
}
VM = "module.self_healing.google_compute_instance.this"
AGENT = "module.self_healing.google_service_account.agent"
ALERT = "module.self_healing.google_monitoring_alert_policy.no_product_output[0]"


def omit(value, keys):
    return {key: item for key, item in value.items() if key not in keys}


def validate(plan):
    changes = []
    for resource in plan.get("resource_changes", []):
        change, address = resource["change"], resource["address"]
        actions = change["actions"]
        if actions in (["no-op"], ["read"]):
            continue
        before, after = change.get("before") or {}, change.get("after") or {}
        allowed = False
        if actions == ["create"] and address in NEW_RESOURCES:
            allowed = after.get("project") == PROJECT
        elif actions == ["update"] and address == VM:
            old_meta, new_meta = before.get("metadata", {}), after.get("metadata", {})
            script = new_meta.get("startup-script", "")
            allowed = (omit(before, {"metadata"}) == omit(after, {"metadata"})
                       and omit(old_meta, {"startup-script"}) == omit(new_meta, {"startup-script"})
                       and "config/run.py" in script and "config/render.py" in script)
        elif actions == ["update"] and address == AGENT:
            allowed = omit(before, {"description"}) == omit(after, {"description"})
        elif actions == ["update"] and address == ALERT:
            old_conditions, new_conditions = before.get("conditions", []), after.get("conditions", [])
            allowed = (omit(before, {"display_name", "documentation", "conditions"})
                       == omit(after, {"display_name", "documentation", "conditions"})
                       and [omit(c, {"display_name"}) for c in old_conditions]
                       == [omit(c, {"display_name"}) for c in new_conditions])
        if not allowed:
            raise ValueError(f"Unreviewed infrastructure change: {address} {actions}")
        changes.append({"address": address, "actions": actions})
    return changes


if __name__ == "__main__":
    with open(sys.argv[1]) as source:
        print(json.dumps(validate(json.load(source)), indent=2))
