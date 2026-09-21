import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import run_monitor as runner
import topology


class TopologyTests(unittest.TestCase):
    def test_missing_resources_do_not_disappear_from_expected_coverage(self):
        targets = topology.load_targets()
        fetch = Mock(side_effect=RuntimeError("permission denied or missing"))
        result = topology.inspect_targets(targets, fetch)
        self.assertEqual(len(result), len(targets["voice_agents"]) + 1)
        self.assertTrue(all(t["status"] == "UNKNOWN" for t in result))
        self.assertEqual(topology.load_targets(), targets)

    def test_deployed_configuration_drift_and_not_ready_are_explicit(self):
        def fetch(project, kind, name, region):
            if kind == "worker-pools":
                return {"status": {"conditions": [{"type": "Ready", "status": "False"}]}}
            return {"spec": {"template": {"spec": {"containers": [{"env": [
                {"name": "LIVEKIT_URL", "value": "wss://replacement.livekit.cloud"}]}]}}}}
        result = topology.inspect_targets(topology.load_targets(), fetch)
        self.assertEqual([r["status"] for r in result], ["NOT_READY"] * 3 + ["DRIFT"])

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
        empty = copy.deepcopy(base); empty["voice_agents"] = []; cases.append(empty)
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


if __name__ == "__main__":
    unittest.main()
