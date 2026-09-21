"""Migration regressions: retired SFUs cannot page, active workers still can."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import run_monitor as runner
import triage


class LiveKitCloudTests(unittest.TestCase):
    def setUp(self):
        triage.collection_errors.clear()

    def test_worker_json_errors_keep_region_and_escalation_without_gcp_severity(self):
        entry = {"resource": {"type": "cloud_run_worker_pool", "labels": {
            "worker_pool_name": "voice-agent-in", "location": "asia-south1"}},
            "jsonPayload": {"level": "ERROR", "message": "Room connection failed"},
            "timestamp": triage.utcnow_iso()}
        groups = {}
        with patch.object(triage, "gcloud_logging_read", return_value=[entry] * 11) as fetch:
            triage.collect_voice_agent_errors(groups)
        query = fetch.call_args.args[0]
        self.assertIn("jsonPayload.level", query)
        self.assertIn(triage.VOICE_AGENT_LOG_FILTER, query)
        triage.assign_severity(groups, {}, 0)
        group = next(iter(groups.values()))
        self.assertEqual(group["region"], "asia-south1")
        self.assertEqual(group["service"], "ai-voice-agent-python")
        self.assertEqual(group["count"], 11)
        self.assertEqual(group["severity"], "P2")

    def test_all_voice_collectors_use_active_worker_pools(self):
        with patch.object(triage, "gcloud_logging_read", return_value=[]) as fetch:
            triage.collect_voice_agent_errors({})
            triage.collect_stage_errors({})
            triage.collect_audio_timeouts({})
            triage.collect_anam_failures({})
            triage.collect_transcription_delay({})
        self.assertEqual(fetch.call_count, 5)
        for call in fetch.call_args_list:
            self.assertIn(triage.VOICE_AGENT_LOG_FILTER, call.args[0])
            self.assertNotIn("gce_instance", call.args[0])

    def test_collection_never_probes_retired_hosts_or_reports_them_down(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            runner.write_json(Path(directory) / "latest-report.json", {"error_groups": [{
                "signature": "lk-server:lk-asia-south1:down", "service": "livekit",
                "region": "lk-asia-south1", "severity": "P0", "count": 1}]})
            stack.enter_context(patch.object(triage, "STATE_DIR", directory))
            stack.enter_context(patch.object(triage, "inspect_targets", return_value=[
                {"name": "worker", "status": "READY"}, {"name": "livekit-config", "status": "MATCH"}]))
            stack.enter_context(patch.object(triage, "gcloud_logging_read", return_value=[]))
            stack.enter_context(patch.object(triage, "collect_sentry"))
            stack.enter_context(patch.object(triage, "check_duplicate_worker"))
            stack.enter_context(patch.object(triage, "collect_closed_signature_cooldowns", return_value={}))
            stack.enter_context(patch.object(triage, "run_cmd", side_effect=AssertionError("unexpected probe")))
            stack.enter_context(patch.object(triage.subprocess, "run", side_effect=AssertionError("unexpected SSH")))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            triage.main()
            summary = json.loads((Path(directory) / "triage-summary.json").read_text())
            report = json.loads((Path(directory) / "latest-report.json").read_text())
        self.assertEqual(summary["p0_alerts"], [])
        self.assertEqual(summary["escalations"], [])
        self.assertNotIn("livekit-vms", report["services"])
        self.assertEqual(report["services"]["livekit"], {"hosting": "cloud", "status": "MANAGED"})
        self.assertEqual(report["error_groups"][0]["diff_status"], "resolved")

    def test_anam_aggregate_does_not_attribute_mixed_regions_to_first_worker(self):
        entries = [{"resource": {"labels": {"location": region}},
                    "jsonPayload": {"message": "Failed to start avatar"},
                    "timestamp": triage.utcnow_iso()}
                   for region in ["europe-west1", "asia-south1"] * 2]
        groups = {}
        with patch.object(triage, "gcloud_logging_read", return_value=entries):
            count = triage.collect_anam_failures(groups)
        triage.assign_severity(groups, {}, 0, anam_count=count)
        group = groups["voice-agent:all:anam-avatar-start-failed"]
        self.assertEqual((group["region"], group["count"], group["severity"]), ("all", 4, "P2"))

    def test_retired_pending_work_is_removed_but_real_alerts_still_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            config = runner.Config(Path(directory), ())
            retired = "lk-server:lk-asia-south1:down"
            active = "voice-agent:asia-south1:connection-failed"
            pending = {retired: {"signature": retired}, active: {"signature": active}}
            for vm in [r["name"] for r in runner.load_targets()["retired_resources"]]:
                signature = f"voice-agent:{vm}:connection-failed"
                pending[signature] = {"signature": signature}
            runner.write_json(config.state_dir / "linear-outbox.json", pending)
            batch = runner.prepare_escalations(config, {"timestamp": runner.timestamp(), "escalations": []})
            self.assertEqual([e["signature"] for e in batch["escalations"]], [active])
            obsolete_page = "URGENT P0: LiveKit server lk-asia-south1 HTTP 0 (expected 200) — detected 2026-09-20T09:00:39Z"
            real_page = "URGENT P0: voice-agent:all:connection-failed — 1100 errors/2h"
            old_worker_page = "URGENT P0: voice-agent:lk-eu-west4:failed — 1100 errors/2h"
            runner.write_json(config.state_dir / "p0-outbox.json", {"old": obsolete_page, "worker": old_worker_page, "real": real_page})
            pager = Mock(side_effect=RuntimeError("retry later"))
            sent, failures = runner.deliver_pending(config, [obsolete_page], pager)
            self.assertEqual(sent, [])
            self.assertEqual(len(failures), 1)
            pager.assert_called_once_with(real_page)
            self.assertEqual(json.loads((config.state_dir / "p0-outbox.json").read_text()), {"real": real_page})


if __name__ == "__main__":
    unittest.main()
