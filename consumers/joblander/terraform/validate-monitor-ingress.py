"""Permit additive ingress resources and a scoped change to the old 5xx filter."""
import json
from pathlib import Path
import sys

PREFIX = "module.monitor_ingress."
NEW = {PREFIX + name for name in (
    "google_pubsub_topic.errors", "google_service_account.push",
    "google_service_account_iam_member.token_creator", "google_pubsub_subscription.push",
    "google_monitoring_notification_channel.monitor", "google_pubsub_topic_iam_member.monitoring",
    "google_monitoring_alert_policy.errors")}
LEGACY = "google_monitoring_alert_policy.legacy_5xx"


def omit(value, keys):
    return {k: v for k, v in value.items() if k not in keys}


def validate(plan):
    for resource in plan.get("resource_changes", []):
        c, address = resource["change"], resource["address"]
        if c["actions"] in (["no-op"], ["read"]):
            continue
        before, after = c.get("before") or {}, c.get("after") or {}
        if c["actions"] == ["create"] and address in NEW:
            if after.get("project", "meet-assistant-6d8ad") == "meet-assistant-6d8ad":
                continue
        if c["actions"] == ["update"] and address == LEGACY:
            # Importing an existing policy must preserve channels, severity,
            # enabled state, timings and every field except its query filter.
            old, new = before.get("conditions", []), after.get("conditions", [])
            if len(old) == len(new) == 1:
                a, b = old[0], new[0]
                aq = a["condition_monitoring_query_language"][0]
                bq = b["condition_monitoring_query_language"][0]
                services = json.loads((Path(__file__).parent.parent / "targets.json").read_text())["cloud_run_services"]
                predicate = "response_code_class == \"5xx\""
                scoped = " && ".join([predicate] + [f"resource.service_name != {json.dumps(s)}" for s in services])
                expected = aq["query"].replace(f"filter ({predicate})", f"filter ({scoped})")
                if (omit(before, {"conditions"}) == omit(after, {"conditions"})
                    and omit(a, {"condition_monitoring_query_language"}) == omit(b, {"condition_monitoring_query_language"})
                    and omit(aq, {"query"}) == omit(bq, {"query"}) and bq["query"] == expected):
                    continue
        raise ValueError(f"Unreviewed infrastructure change: {address} {c['actions']}")


if __name__ == "__main__":
    validate(json.loads(Path(sys.argv[1]).read_text()))
    print("Ingress plan contains only reviewed additive resources and scoped paging cutover")
