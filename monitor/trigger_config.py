"""Generate wake-up filters from the same target scope the collector reads.

An event is only a wake-up: thresholds, exclusions and false-positive policy are
evaluated by triage.py for both entrypoints. Never duplicate them in Terraform.
"""
import argparse
import json
from pathlib import Path


def cloud_run_filter(targets):
    services = targets.get("cloud_run_services", [])
    if not services:
        return None
    scope = " OR ".join(f'resource.labels.service_name={json.dumps(name)}' for name in services)
    return f'resource.type="cloud_run_revision" AND severity>=ERROR AND ({scope})'


def render(targets):
    filters = [cloud_run_filter(targets)]
    if targets.get("cloud_functions"):
        filters.append('resource.type="cloud_function" AND severity>=ERROR')
    return {"project": targets["project"], "filter": " OR ".join(f"({f})" for f in filters if f)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = json.dumps(render(json.loads(args.targets.read_text())), indent=2) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != text:
            raise SystemExit(f"Regenerate {args.output} with monitor/trigger_config.py")
    else:
        args.output.write_text(text)
