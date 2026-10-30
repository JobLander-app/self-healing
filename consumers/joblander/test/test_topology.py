import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import run_monitor as runner
import topology

UNTIL_KEYS = ("until", "until_reason", "until_evidence")


def open_ended(targets):
    """The checked-in targets with every reviewed end of coverage removed."""
    value = copy.deepcopy(targets)
    for target in [value["livekit"], *value["voice_agents"]]:
        for key in UNTIL_KEYS:
            target.pop(key, None)
    return value


def write_targets(directory, value):
    path = Path(directory) / "targets.json"
    path.write_text(json.dumps(value))
    return path


class TopologyTests(unittest.TestCase):
    def test_missing_resources_do_not_disappear_from_expected_coverage(self):
        targets = open_ended(topology.load_targets())
        fetch = Mock(side_effect=RuntimeError("permission denied or missing"))
        result = topology.inspect_targets(targets, fetch)
        self.assertEqual(len(result), len(targets["voice_agents"]) + 1)
        self.assertTrue(all(t["status"] == "UNKNOWN" for t in result))

    def test_deployed_configuration_drift_and_not_ready_are_explicit(self):
        def fetch(project, kind, name, region):
            if kind == "worker-pools":
                return {"status": {"conditions": [{"type": "Ready", "status": "False"}]}}
            return {"spec": {"template": {"spec": {"containers": [{"env": [
                {"name": "LIVEKIT_URL", "value": "wss://replacement.livekit.cloud"}]}]}}}}
        result = topology.inspect_targets(open_ended(topology.load_targets()), fetch)
        self.assertEqual([r["status"] for r in result], ["NOT_READY"] * 3 + ["DRIFT"])

    def test_targets_are_inspected_until_their_reviewed_end_of_coverage(self):
        targets = topology.load_targets()
        cutoff = topology.coverage_until(targets["voice_agents"][0])
        fetch = Mock(side_effect=RuntimeError("missing"))
        before = topology.inspect_targets(targets, fetch, now=cutoff.replace(hour=11))
        self.assertEqual([r["kind"] for r in before], ["worker-pool"] * 3)
        self.assertEqual(topology.inspect_targets(targets, fetch, now=cutoff), [])
        self.assertEqual(topology.inspect_targets(targets, fetch, now=datetime(2027, 1, 1, tzinfo=timezone.utc)), [])

    def test_queued_coverage_escalations_end_with_their_target(self):
        targets = topology.load_targets()
        cutoff = topology.coverage_until(targets["voice_agents"][0])
        livekit = topology.topology_signature("europe-west1", "livekit-config")
        pool = topology.topology_signature("asia-south1", "voice-agent-in")
        error = "voice-agent:asia-south1:connection-failed"
        pending = {signature: {"signature": signature} for signature in (livekit, pool, error)}
        with tempfile.TemporaryDirectory() as directory:
            config = runner.Config(Path(directory), ())
            before = runner.retire_pending(config, pending, "signature_prefixes", now=cutoff.replace(hour=11))
            self.assertEqual(set(before), {pool, error})
            after = runner.retire_pending(config, pending, "signature_prefixes", now=cutoff)
            self.assertEqual(set(after), {error})
            audit = json.loads((Path(directory) / "retired-outbox.json").read_text())
        self.assertEqual({entry["resource"] for entry in audit.values()}, {"livekit-config", "voice-agent-in"})
        self.assertTrue(all(entry["evidence"].startswith("https://") for entry in audit.values()))

    def test_end_of_coverage_requires_timezone_reason_and_evidence(self):
        base = topology.load_targets()
        cases = []
        naive = copy.deepcopy(base); naive["voice_agents"][0]["until"] = "2026-10-19T12:00:00"; cases.append(naive)
        garbage = copy.deepcopy(base); garbage["livekit"]["until"] = "soon"; cases.append(garbage)
        no_reason = copy.deepcopy(base); no_reason["voice_agents"][1]["until_reason"] = ""; cases.append(no_reason)
        no_evidence = copy.deepcopy(base); del no_evidence["livekit"]["until_evidence"]; cases.append(no_evidence)
        with tempfile.TemporaryDirectory() as directory:
            for value in cases:
                with self.assertRaises(ValueError):
                    topology.load_targets(write_targets(directory, value))

    def test_next_retirement_needs_data_only_and_retains_unrelated_pages(self):
        targets = copy.deepcopy(topology.load_targets())
        resource = copy.deepcopy(targets["retired_resources"][0])
        old = resource["name"]
        resource = json.loads(json.dumps(resource).replace(old, "next-retired-host"))
        targets["retired_resources"].append(resource)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "targets.json"
            path.write_text(json.dumps(targets))
            validated = topology.load_targets(path)
            config = runner.Config(Path(directory), ())
            old_sig = "voice-agent:next-retired-host:failed"
            current_sig = "voice-agent:next-retired-host-v2:failed"
            pending = {old_sig: {"signature": old_sig}, current_sig: {"signature": current_sig}}
            with patch.object(runner, "load_targets", return_value=validated):
                result = runner.retire_pending(config, pending, "signature_prefixes")
                self.assertEqual(set(result), {current_sig})
                old_page = "URGENT P0: voice-agent:next-retired-host:failed"
                current_page = "URGENT P0: voice-agent:all:connection-failed"
                result = runner.retire_pending(config, {"old": old_page, "real": current_page}, "page_prefixes")
                self.assertEqual(result, {"real": current_page})
            audit = json.loads((Path(directory) / "retired-outbox.json").read_text())
            self.assertEqual(len(audit), 2)
            self.assertTrue(all(x["evidence"] and x["policy_revision"] for x in audit.values()))

    def test_invalid_policy_cannot_silently_disable_coverage_or_page_filtering(self):
        base = topology.load_targets()
        cases = []
        broad = copy.deepcopy(base); broad["retired_resources"][0]["signature_prefixes"] = ["voice-agent:"]; cases.append(broad)
        active = copy.deepcopy(base); active["retired_resources"][0]["name"] = base["voice_agents"][0]["name"]; cases.append(active)
        future = copy.deepcopy(base); future["retired_resources"][0]["retired_at"] = "2999-01-01T00:00:00Z"; cases.append(future)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "targets.json"
            for value in cases:
                path.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    topology.load_targets(path)
            path.write_text("broken")
            config = runner.Config(Path(directory), ())
            page = "URGENT P0: voice-agent:all:failed"
            runner.write_json(config.state_dir / "p0-outbox.json", {"real": page})
            pager = Mock()
            with patch.object(topology, "TARGETS_FILE", path), self.assertRaises(ValueError):
                runner.deliver_pending(config, [], pager)
            pager.assert_not_called()
            self.assertEqual(json.loads((config.state_dir / "p0-outbox.json").read_text()), {"real": page})

    def test_log_filter_binds_each_pool_to_its_region(self):
        targets = topology.load_targets()
        query = topology.voice_filter(targets)
        for pool in targets["voice_agents"]:
            self.assertIn(f'worker_pool_name="{pool["name"]}" AND resource.labels.location="{pool["region"]}"', query)
        self.assertNotIn("gce_instance", query)

    def test_known_degradation_wins_and_livekit_config_cannot_override_workers(self):
        unknown = {"kind": "worker-pool", "status": "UNKNOWN"}
        not_ready = {"kind": "worker-pool", "status": "NOT_READY"}
        ready = {"kind": "worker-pool", "status": "READY"}
        for config_status in ["UNKNOWN", "DRIFT", "MATCH"]:
            config = {"kind": "livekit-config", "status": config_status}
            self.assertEqual(topology.worker_service_status("DEGRADED", [unknown, config]), "DEGRADED")
            self.assertEqual(topology.worker_service_status("HEALTHY", [unknown, not_ready, config]), "DEGRADED")
            self.assertEqual(topology.worker_service_status("HEALTHY", [ready, config]), "HEALTHY")
            self.assertEqual(topology.worker_service_status("HEALTHY", [unknown, config]), "UNKNOWN")


if __name__ == "__main__":
    unittest.main()
