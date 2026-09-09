import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import run_monitor as runner


class MonitorRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = runner.Config(self.root / "state", (self.root / "legacy",),
                                    lock_file=self.root / "lock",
                                    provider_log_dir=self.root / "provider/turns",
                                    metrics_file=self.root / "metrics/monitor.prom")
        self.config.metrics_file.parent.mkdir()
        runner.migrate_state(self.config)

    def collector(self, escalations=None, alerts=None, at=None):
        def collect(config):
            runner.write_json(config.state_dir / "triage-summary.json", {
                "timestamp": at or runner.timestamp(), "triage_failed": False,
                "escalations": [{"signature": "audio:failed", **item} for item in (escalations or [])], "p0_alerts": alerts or [],
            })
            runner.write_json(config.state_dir / "latest-report.json", {
                "timestamp": at or runner.timestamp(), "error_groups": [{"signature": "audio:failed"}], "actions": {},
            })
            return 0
        return collect

    def run_once(self, **kwargs):
        kwargs.setdefault("publisher", lambda result: result["status"] == "success")
        with contextlib.redirect_stdout(io.StringIO()):
            return runner.run_once(self.config, **kwargs)

    def test_empty_batch_updates_freshness_without_auth_or_inference(self):
        session, pager = Mock(side_effect=AssertionError("must not run")), Mock()
        with patch.object(runner, "secret", side_effect=AssertionError("no auth on empty work")):
            self.assertEqual(self.run_once(collector=self.collector(), session_runner=session, pager=pager), 0)
        session.assert_not_called()
        pager.assert_not_called()
        result = json.loads((self.config.state_dir / "last-session.json").read_text())
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["llmSkipped"])
        self.assertTrue(result["heartbeatPublished"])
        self.assertIsNotNone(result["triageAt"])

    def test_failed_or_stale_triage_never_escalates_or_claims_health(self):
        session = Mock(side_effect=AssertionError("must not run"))
        for collector in (lambda config: 3, self.collector(at="2020-01-01T00:00:00Z")):
            self.assertEqual(self.run_once(collector=collector, session_runner=session), 1)
            result = json.loads((self.config.state_dir / "last-session.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertFalse(result["heartbeatPublished"])
        session.assert_not_called()

    def test_migration_preserves_reports_and_never_replaces_new_state(self):
        legacy = self.root / "source"
        legacy.mkdir()
        originals = {"known-errors.json": '{"patterns":[{"signature_match":"x"}]}',
                     "latest-report.json": '{"actions":{"linear_created":["JOB-1"]}}',
                     "2026-09-09T12.json": '{"archive":true}'}
        for name, content in originals.items():
            (legacy / name).write_text(content)
        config = runner.Config(self.root / "migrated", (legacy,))
        runner.migrate_state(config)
        for name, content in originals.items():
            self.assertEqual((config.state_dir / name).read_text(), content)
            self.assertEqual((legacy / name).read_text(), content)
        (config.state_dir / "known-errors.json").write_text("new suppression")
        runner.migrate_state(config)
        self.assertEqual((config.state_dir / "known-errors.json").read_text(), "new suppression")

    def test_old_and_new_launchers_cannot_hold_the_same_lock(self):
        with runner.monitor_lock(self.config.lock_file) as first:
            self.assertTrue(first)
            with runner.monitor_lock(self.config.lock_file) as second:
                self.assertFalse(second)
        with runner.monitor_lock(self.config.lock_file) as next_run:
            self.assertTrue(next_run)

    def test_migration_only_never_collects_and_refuses_a_busy_lock(self):
        with patch.object(runner.Config, "from_env", return_value=self.config), \
                patch.object(runner.signal, "signal"), \
                patch.object(runner, "run_once", side_effect=AssertionError("migration must not run monitor")), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(["--migrate-only"]), 0)
            with runner.monitor_lock(self.config.lock_file):
                self.assertEqual(runner.main(["--migrate-only"]), 1)

    def test_p0_outbox_survives_delivery_failure_and_retries_without_a_model(self):
        alert = "URGENT P0: exact original evidence"
        def failing_pager(text):
            self.assertIn(text, json.loads((self.config.state_dir / "p0-outbox.json").read_text()).values())
            raise RuntimeError("offline")
        self.assertEqual(self.run_once(collector=self.collector(alerts=[alert]), pager=failing_pager), 1)
        delivered = []
        session = Mock(side_effect=AssertionError("no model for pending Telegram"))
        self.assertEqual(self.run_once(collector=self.collector(), session_runner=session, pager=delivered.append), 0)
        self.assertEqual(delivered, [alert])
        self.assertEqual(json.loads((self.config.state_dir / "p0-outbox.json").read_text()), {})
        session.assert_not_called()

    def test_p0_delivers_before_quota_failure_and_records_attempt_usage(self):
        order = []
        attempt = {"provider": "claude", "usage": {"input": None, "output": None}, "failureKind": "quota"}
        def session(config):
            order.append("session")
            return {"error": "quota exhausted", "attempts": [attempt]}
        self.assertEqual(self.run_once(
            collector=self.collector(escalations=[{"action": "telegram_p0_and_linear"}], alerts=["P0 exact"]),
            pager=lambda alert: order.append("page"), session_runner=session), 1)
        self.assertEqual(order, ["page", "session"])
        result = json.loads((self.config.state_dir / "last-session.json").read_text())
        self.assertEqual(result["attempts"], [attempt])
        self.assertEqual(result["telegramSent"], ["P0 exact"])
        self.assertFalse(result["heartbeatPublished"])
        report = json.loads((self.config.state_dir / "latest-report.json").read_text())
        self.assertEqual(report["actions"]["telegram_sent"], ["P0 exact"])

    def test_partial_linear_progress_is_saved_even_when_provider_fails(self):
        actions = {"linear_created": ["JOB-42"], "linear_commented": [],
                   "issue_by_signature": {"audio:failed": "JOB-42"}}
        self.assertEqual(self.run_once(
            collector=self.collector(escalations=[{"action": "linear_create_if_no_dup"}]),
            session_runner=lambda config: {"error": "provider interrupted", "attempts": [], "actions": actions}), 1)
        report = json.loads((self.config.state_dir / "latest-report.json").read_text())
        self.assertEqual(report["actions"]["linear_created"], ["JOB-42"])
        self.assertEqual(report["error_groups"][0]["linear_issue"], "JOB-42")
        result = json.loads((self.config.state_dir / "last-session.json").read_text())
        self.assertEqual(result["actions"], actions)
        self.assertFalse(result["heartbeatPublished"])

    def test_pending_p0_retries_even_when_next_collection_fails(self):
        runner.write_json(self.config.state_dir / "p0-outbox.json", {"old": "Prepared P0"})
        delivered = []
        self.assertEqual(self.run_once(collector=lambda config: 1, pager=delivered.append), 1)
        self.assertEqual(delivered, ["Prepared P0"])
        self.assertEqual(json.loads((self.config.state_dir / "p0-outbox.json").read_text()), {})

    def test_failed_p2_escalation_is_retried_after_collector_stops_marking_it_new(self):
        self.assertEqual(self.run_once(
            collector=self.collector(escalations=[{"action": "linear_create_if_no_dup", "severity": "P2"}]),
            session_runner=lambda config: {"error": "quota", "attempts": []}), 1)
        def retry(config):
            batch = json.loads((config.state_dir / "escalation-batch.json").read_text())
            self.assertEqual(len(batch["escalations"]), 1)
            self.assertEqual(batch["escalations"][0]["severity"], "P2")
            self.assertIn("prepared_at", batch["escalations"][0])
            return {"error": None, "attempts": [], "actions": {
                "linear_created": ["JOB-42"], "linear_commented": [], "issue_by_signature": {"audio:failed": "JOB-42"}}}
        self.assertEqual(self.run_once(collector=self.collector(), session_runner=retry), 0)
        self.assertEqual(json.loads((self.config.state_dir / "linear-outbox.json").read_text()), {})
        session = Mock(side_effect=AssertionError("acked backlog must not replay"))
        self.assertEqual(self.run_once(collector=self.collector(), session_runner=session), 0)
        session.assert_not_called()

    def test_fresh_cooldown_adjudication_removes_a_pending_escalation(self):
        runner.write_json(self.config.state_dir / "linear-outbox.json", {
            "audio:failed": {"signature": "audio:failed", "action": "linear_create_if_no_dup"}})
        batch = runner.prepare_escalations(self.config, {
            "timestamp": runner.timestamp(), "escalations": [],
            "cooldown_suppressed": [{"signature": "audio:failed", "prior_issue": "JOB-42"}]})
        self.assertEqual(batch["escalations"], [])

    def test_success_marker_cannot_ack_a_batch_with_recorded_routing_errors(self):
        self.assertEqual(self.run_once(
            collector=self.collector(escalations=[{"action": "linear_create_if_no_dup"}]),
            session_runner=lambda config: {"error": None, "attempts": [], "actions": {
                "linear_created": [], "linear_commented": [], "issue_by_signature": {},
                "errors": ["Unknown routing service"]}}), 1)
        self.assertIn("audio:failed", json.loads((self.config.state_dir / "linear-outbox.json").read_text()))
        result = json.loads((self.config.state_dir / "last-session.json").read_text())
        self.assertFalse(result["heartbeatPublished"])

    def test_missing_gcloud_does_not_erase_completed_session(self):
        result = {"status": "success", "triageAt": runner.timestamp(), "llmSkipped": True,
                  "finishedAt": runner.timestamp()}
        with patch.object(runner.subprocess, "run", side_effect=FileNotFoundError("gcloud")):
            self.assertFalse(runner.publish_heartbeat(result))

    def test_shared_provider_adapter_uses_isolated_cwd_and_records_actions(self):
        self.collector(escalations=[{"action": "linear_create_if_no_dup"}])(self.config)
        fake = self.root / "provider.py"
        fake.write_text('''import json,sys
from pathlib import Path
prompt=sys.stdin.read()
assert "Never claim work" in prompt
assert Path("triage-summary.json").exists()
Path("linear-actions.json").write_text(json.dumps({"linear_created":["JOB-42"],"linear_commented":[],"issue_by_signature":{"audio:failed":"JOB-42"}}))
print("operational log")
print(json.dumps({"output":'[SESSION_END] {"status":"success"}',"error":None,"attempts":[]}))
''')
        real_spawn = subprocess.Popen
        def spawn(command, **kwargs):
            self.assertTrue(command[1].endswith("dispatcher/dist/providerCli.js"))
            self.assertEqual(kwargs["cwd"], self.config.state_dir / "runtime")
            return real_spawn([sys.executable, str(fake)], **kwargs)
        with patch.object(runner, "provider_env", return_value=dict(os.environ)), patch.object(runner.subprocess, "Popen", side_effect=spawn):
            result = runner.run_session(self.config)
        self.assertIsNone(result["error"])
        self.assertEqual(result["actions"]["linear_created"], ["JOB-42"])

    def test_usage_metrics_do_not_double_count_cached_input_or_invent_unknown_zero(self):
        ledger = self.config.provider_log_dir.parent / "usage-ledger.jsonl"
        ledger.parent.mkdir()
        records = [
            {"kind": "attempt_started", "id": "one", "data": {"provider": "claude", "model": "sonnet", "usage": {}}},
            {"kind": "attempt", "id": "one", "data": {"provider": "claude", "model": "sonnet", "usage": {"input": 100, "cachedInput": 70, "cacheWrite": 0, "output": 20}}},
            {"kind": "attempt", "id": "two", "data": {"provider": "codex", "model": "gpt", "usage": {"input": None, "output": None}}},
        ]
        ledger.write_text("\n".join(json.dumps(record) for record in records) + "\npartial")
        self.run_once(collector=self.collector())
        metrics = self.config.metrics_file.read_text()
        self.assertIn('tokens_total{provider="claude",model="sonnet",kind="input"} 100', metrics)
        self.assertNotIn('tokens_total{provider="codex"', metrics)
        self.assertIn('attempts_missing_usage_total{provider="codex",model="gpt",kind="input"} 1', metrics)
        self.assertNotIn('attempts_missing_usage_total{provider="claude"', metrics)

    def test_metrics_use_reported_models_without_repeating_aggregate_usage(self):
        ledger = self.config.provider_log_dir.parent / "usage-ledger.jsonl"
        ledger.parent.mkdir()
        ledger.write_text(json.dumps({"kind": "attempt", "id": "one", "data": {
            "provider": "claude", "model": "requested-alias", "usage": {"input": 100},
            "models": [{"model": "actual-model", "usage": {"input": 100, "output": 20}}]}}))
        self.run_once(collector=self.collector())
        metrics = self.config.metrics_file.read_text()
        self.assertIn('provider="claude",model="actual-model",kind="input"} 100', metrics)
        self.assertNotIn("requested-alias", metrics)

    def test_marker_in_tool_text_or_failed_result_is_not_completion(self):
        self.assertFalse(runner.session_succeeded("No final marker"))
        self.assertFalse(runner.session_succeeded('[SESSION_END] {"status":"failed"}'))
        self.assertTrue(runner.session_succeeded('[SESSION_END] {"status":"success"}'))


if __name__ == "__main__":
    unittest.main()
