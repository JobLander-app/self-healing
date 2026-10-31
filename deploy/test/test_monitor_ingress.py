import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ingress_guard", ROOT / "consumers/joblander/terraform/validate-monitor-ingress.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class IngressPlanTests(unittest.TestCase):
    def plan(self, address, actions, before=None, after=None):
        return {"resource_changes": [{"address": address, "change": {
            "actions": actions, "before": before, "after": after}}]}

    def test_refuses_vm_changes_deletes_and_unrelated_grants(self):
        for address, actions in [("module.self_healing.google_compute_instance.this", ["update"]),
                                 (next(iter(guard.NEW)), ["delete", "create"]),
                                 ("google_project_iam_member.owner", ["create"])]:
            with self.assertRaises(ValueError):
                guard.validate(self.plan(address, actions))

    def test_cleanup_is_limited_to_the_new_obsolete_wakeup_policy(self):
        for address in guard.RETIRED:
            guard.validate(self.plan(address, ['delete'], {'project': 'meet-assistant-6d8ad'}))
            with self.assertRaises(ValueError):
                guard.validate(self.plan(address, ['delete'], {'project': 'other-project'}))
        with self.assertRaises(ValueError):
            guard.validate(self.plan(guard.LEGACY, ['delete'], {'project': 'meet-assistant-6d8ad'}))

    def test_old_policy_can_only_exclude_monitored_services_without_losing_other_coverage(self):
        query = 'fetch cloud_run_revision\n| filter (response_code_class == "5xx")\n| condition val() > 5'
        before = {"project": "meet-assistant-6d8ad", "enabled": True,
                  "notification_channels": ["existing-channel"], "severity": "CRITICAL", "conditions": [{
                      "display_name": "New condition", "condition_monitoring_query_language": [{
                          "query": query, "duration": "0s", "trigger": [{"count": 1}]}]}]}
        after = copy.deepcopy(before)
        services = json.loads((ROOT / 'consumers/joblander/targets.json').read_text())["cloud_run_services"]
        scoped = ' && '.join(['response_code_class == "5xx"'] + [f'resource.service_name != {json.dumps(s)}' for s in services])
        after['conditions'][0]['condition_monitoring_query_language'][0]['query'] = query.replace(
            'filter (response_code_class == "5xx")', f'filter ({scoped})')
        guard.validate(self.plan(guard.LEGACY, ['update'], before, after))
        for key, value in [('enabled', False), ('notification_channels', []), ('severity', 'WARNING')]:
            changed = copy.deepcopy(after); changed[key] = value
            with self.assertRaises(ValueError):
                guard.validate(self.plan(guard.LEGACY, ['update'], before, changed))
