"""The cooldown must not hide a fix that did not hold.

The dispatcher ends its run at the merge; post-deploy verification is the
hourly triage. A Done [Monitor] ticket with a merged PR whose signature is seen
again after the fix deployed bypasses the Done cooldown and is re-filed. Every
other cooldown case (Done without a PR, Canceled, recurrence before the deploy,
any lookup failure) keeps today's suppression.
"""

import datetime
import io
import json
import sys
import unittest
import urllib.parse
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, __file__.rsplit("/", 1)[0])

import triage  # noqa: E402

NOW = datetime.datetime(2026, 10, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
CLOSED = "2026-10-01T09:00:00.000Z"          # Done 3h ago, inside the 6h cooldown
PR = "https://github.com/JobLander-app/backend/pull/399"
SIG = "joblander-audio-engine:europe-west1:failed-to-deduct-balance-atomically"
SENTRY_SIG = "sentry:joblander-app:signup:typeerror"


def _ms(iso):
    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _group(sig=SIG, last_seen="2026-10-01T11:30:00.123456789Z", sev="P2", status="recurring",
           service="joblander-audio-engine", region="europe-west1"):
    return {
        "signature": sig, "service": service, "region": region, "count": 12,
        "first_seen": "2026-10-01T10:00:00Z", "last_seen": last_seen,
        "severity": sev, "diff_status": status, "sample_message": "Failed to deduct balance atomically",
        "linear_issue": "JOB-1131",
    }


def _cooldown(sig=SIG, state="completed", pr=PR, closed=CLOSED, prior="P2"):
    return {sig: {"state_type": state, "closed_at": closed, "issue": "JOB-1131",
                  "prior_severity": prior, "fixed_by_pr": pr}}


def _deploy(ts_iso, service="joblander-audio-engine", region="europe-west1"):
    entities = [{"type": "service", "id": service}]
    if region:
        entities.insert(0, {"type": "region", "id": region})
    return {"id": f"audit:{ts_iso}", "source": "gcp_audit", "kind": "run_deploy",
            "ts": _ms(ts_iso), "entities": entities,
            "title": f"google.cloud.run.v1.Services.ReplaceService namespaces/p/services/{service}"}


class _Feed:
    """Fake change-ingest GET /changes; records every requested URL."""

    def __init__(self, rows=None, error=None):
        self.rows, self.error, self.urls = rows or [], error, []

    def __call__(self, url, timeout=None):  # noqa: ARG002
        self.urls.append(url)
        if self.error:
            raise self.error
        return io.BytesIO(json.dumps(self.rows).encode())

    def params(self, i=0):
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.urls[i]).query)


def _run(groups, cooldowns, feed):
    with patch("triage.datetime") as mock_dt, patch("urllib.request.urlopen", feed):
        mock_dt.datetime.now.return_value = NOW
        mock_dt.datetime.fromisoformat.side_effect = datetime.datetime.fromisoformat
        mock_dt.timezone.utc = datetime.timezone.utc
        mock_dt.timedelta = datetime.timedelta
        _, esc = triage.build_escalations(groups, cooldowns)
    return esc


class TestFixDidNotHold(unittest.TestCase):

    def test_recurrence_after_deploy_is_refiled(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group()], _cooldown(), feed)
        self.assertEqual(item["action"], "linear_create_if_no_dup",
                         "a recurring P2 would otherwise be report_only")
        override = item["cooldown_override"]
        self.assertEqual(override["reason"], "recurred-after-fix")
        self.assertEqual(override["prior_issue"], "JOB-1131")
        self.assertEqual(override["fixed_by_pr"], PR)
        self.assertEqual(override["fix_live_at"], "2026-10-01T09:14:08Z")
        self.assertTrue(override["fix_live_source"].startswith("change-feed"))
        self.assertEqual(
            item["fix_did_not_hold"],
            f"fix did not hold: JOB-1131 ({PR}) deployed 2026-10-01T09:14:08Z, "
            "signature seen again at 2026-10-01T11:30:00.123456789Z")
        self.assertTrue(item["suggested_title"].startswith("[Monitor] "))
        self.assertIn("fix did not hold (JOB-1131)", item["suggested_title"])
        params = feed.params()
        self.assertEqual(params["kind"], ["run_deploy"])
        self.assertEqual(params["entity"], ["service:joblander-audio-engine"])
        self.assertEqual(params["since"], [str(_ms(CLOSED))])

    def test_p1_improved_is_refiled_too(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group(sev="P1", status="improved")], _cooldown(prior="P1"), feed)
        self.assertEqual(item["action"], "linear_create_if_no_dup")
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")

    def test_p3_recurrence_stays_report_only(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group(sev="P3")], _cooldown(), feed)
        self.assertEqual(item["action"], "report_only")
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")

    def test_recurrence_only_before_deploy_stays_suppressed(self):
        # The old revision keeps erroring until the deploy lands; that is expected.
        feed = _Feed([_deploy("2026-10-01T11:45:00Z")])
        [item] = _run([_group(last_seen="2026-10-01T11:30:00Z")], _cooldown(), feed)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertNotIn("cooldown_override", item)

    def test_done_without_pr_stays_suppressed(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group()], _cooldown(pr=None), feed)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertEqual(feed.urls, [], "no fix → no deploy lookup")

    def test_canceled_stays_suppressed_even_with_a_pr(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group()], _cooldown(state="canceled"), feed)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertEqual(item["cooldown"]["limit_h"], triage.COOLDOWN_HOURS_CANCELED)

    def test_feed_unavailable_keeps_the_cooldown(self):
        # No deploy evidence: the event may still come from the old revision.
        for error in (URLError("connection refused"),
                      HTTPError("http://127.0.0.1:4200/changes", 503, "degraded", {}, None)):
            with self.subTest(error=type(error).__name__):
                [item] = _run([_group()], _cooldown(), _Feed(error=error))
                self.assertEqual(item["action"], "cooldown_suppressed")
                self.assertNotIn("cooldown_override", item)
                self.assertNotIn("fix_did_not_hold", item)

    def test_feed_without_a_deploy_keeps_the_cooldown(self):
        # A healthy feed with no deploy since the closure is positive evidence the
        # fix is not live yet (delayed, failed, never started).
        [item] = _run([_group()], _cooldown(), _Feed([]))
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertNotIn("cooldown_override", item)

    def test_sentry_signature_maps_to_the_app_service(self):
        feed = _Feed([_deploy("2026-10-01T09:20:00Z", service="joblander-app", region=r)
                      for r in triage.REGIONS])
        group = _group(sig=SENTRY_SIG, service="joblander-app", region="frontend",
                       last_seen="2026-10-01T11:00:00.000000Z")
        [item] = _run([group], _cooldown(sig=SENTRY_SIG), feed)
        self.assertEqual(feed.params()["entity"], ["service:joblander-app"])
        self.assertEqual(item["cooldown_override"]["fix_live_at"], "2026-10-01T09:20:00Z")
        self.assertEqual(item["action"], "linear_create_if_no_dup")

    def test_deploy_service_mapping(self):
        self.assertEqual(triage.deploy_service(SENTRY_SIG, "joblander-app"), "joblander-app")
        self.assertEqual(triage.deploy_service(SIG, "joblander-audio-engine"),
                         "joblander-audio-engine")
        self.assertEqual(triage.deploy_service("joblander-app:us-central1:http-500-get-root",
                                               "joblander-app"), "joblander-app")
        # Signal namespaces are not Cloud Run services tracked by the feed.
        for sig, service in (("voice-agent:europe-west1:x", "ai-voice-agent-python"),
                             ("cloud-function:sendEmail:x", "email-service"),
                             ("duplicate-worker:run-errors", "backend"),
                             ("monitor-topology:asia-south1:voice-agent-in",
                              "ai-voice-agent-python")):
            with self.subTest(sig=sig):
                self.assertIsNone(triage.deploy_service(sig, service))

    def test_untracked_and_snapshot_signals_keep_the_cooldown(self):
        # duplicate-worker stamps last_seen with the collection time, and
        # voice-agent worker-pool deploys are not in the feed: neither may
        # be declared a failed fix.
        for sig, service, region in (
                ("duplicate-worker:run-errors", "backend", "europe-west1"),
                ("voice-agent:europe-west1:google-stt-cancelled", "ai-voice-agent-python",
                 "europe-west1"),
                ("cloud-function:sendEmail:resend-failed", "email-service", "sendEmail")):
            with self.subTest(sig=sig):
                feed = _Feed([_deploy("2026-10-01T09:14:08Z", service=service)])
                group = _group(sig=sig, service=service, region=region,
                               last_seen="2026-10-01T11:59:00Z")
                [item] = _run([group], _cooldown(sig=sig), feed)
                self.assertEqual(item["action"], "cooldown_suppressed")
                self.assertNotIn("cooldown_override", item)
                self.assertEqual(feed.urls, [])

    def test_only_a_deploy_in_the_signature_region_counts(self):
        rows = [_deploy("2026-10-01T09:10:00Z", region="us-central1"),
                _deploy("2026-10-01T09:20:00Z", region="europe-west1"),
                _deploy("2026-10-01T09:05:00Z", region=None)]
        svc = "joblander-audio-engine"
        with patch("urllib.request.urlopen", _Feed(rows)):
            live, source = triage.fix_live_time(svc, SIG, "europe-west1",
                                                NOW.replace(hour=9, minute=0), NOW)
        self.assertEqual(live, NOW.replace(hour=9, minute=20))
        self.assertTrue(source.endswith(":europe-west1"))
        # Another region's rollout, or a row with no region, says nothing about
        # asia-south1, which may still serve the old revision.
        with patch("urllib.request.urlopen", _Feed(rows)):
            self.assertIsNone(triage.fix_live_time(svc, SIG, "asia-south1",
                                                   NOW.replace(hour=9, minute=0), NOW))

    def test_a_rollout_not_yet_in_the_signature_region_keeps_the_cooldown(self):
        # us-central1 went live at 09:14; europe-west1 errors at 11:30 on the old revision.
        feed = _Feed([_deploy("2026-10-01T09:14:08Z", region="us-central1")])
        [item] = _run([_group()], _cooldown(), feed)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertNotIn("cooldown_override", item)

    def test_sentry_waits_for_every_production_region(self):
        # Sentry's region is synthetic: the fix counts as live only once every
        # production region has deployed. A staggered rollout is not enough.
        staggered = [
            _deploy("2026-10-01T09:10:00Z", service="joblander-app", region="europe-west1"),
            _deploy("2026-10-01T09:50:00Z", service="joblander-app", region="us-central1")]
        with patch("urllib.request.urlopen", _Feed(staggered)):
            self.assertIsNone(triage.fix_live_time("joblander-app", SENTRY_SIG, "frontend",
                                                   NOW.replace(hour=9, minute=0), NOW))
        full = staggered + [
            _deploy("2026-10-01T09:30:00Z", service="joblander-app", region="asia-south1"),
            _deploy("2026-10-01T09:55:00Z", service="joblander-app", region="australia-southeast1"),
            _deploy("2026-10-01T10:30:00Z", service="joblander-app", region="europe-west1")]
        with patch("urllib.request.urlopen", _Feed(full)):
            live, source = triage.fix_live_time("joblander-app", SENTRY_SIG, "frontend",
                                                NOW.replace(hour=9, minute=0), NOW)
        self.assertEqual(live, NOW.replace(hour=9, minute=55))
        self.assertTrue(source.endswith(":all-regions"))

    def test_rows_for_another_service_or_kind_are_ignored(self):
        rows = [_deploy("2026-10-01T09:05:00Z", service="joblander-audio-engine-preview"),
                dict(_deploy("2026-10-01T09:06:00Z"), kind="iam_change"),
                _deploy("2026-10-01T09:40:00Z")]
        with patch("urllib.request.urlopen", _Feed(rows)):
            live, _ = triage.fix_live_time("joblander-audio-engine", SIG, "europe-west1",
                                           NOW.replace(hour=9, minute=0), NOW)
        self.assertEqual(live, NOW.replace(hour=9, minute=40))

    def test_an_error_in_the_check_keeps_the_cooldown(self):
        with patch.object(triage, "fix_live_time", side_effect=RuntimeError("boom")):
            [item] = _run([_group()], _cooldown(), _Feed())
        self.assertEqual(item["action"], "cooldown_suppressed")

    def test_unparseable_last_seen_keeps_the_cooldown(self):
        [item] = _run([_group(last_seen="yesterday")], _cooldown(),
                      _Feed([_deploy("2026-10-01T09:14:08Z")]))
        self.assertEqual(item["action"], "cooldown_suppressed")

    def test_p0_is_untouched(self):
        feed = _Feed([_deploy("2026-10-01T09:14:08Z")])
        [item] = _run([_group(sev="P0")], _cooldown(), feed)
        self.assertEqual(item["action"], "telegram_p0_and_linear")
        self.assertNotIn("cooldown_override", item)
        self.assertEqual(feed.urls, [])


class TestMergedPrUrl(unittest.TestCase):

    def _att(self, url, status="merged", merged_at="2026-09-29T21:48:34.000Z"):
        meta = {"status": status, "number": 399}
        if merged_at:
            meta["mergedAt"] = merged_at
        return {"url": url, "metadata": meta}

    def test_merged_github_pr(self):
        self.assertEqual(triage.merged_pr_url({"nodes": [self._att(PR)]}), PR)

    def test_open_or_unmerged_pr_does_not_count(self):
        for status in ("open", "closed", "draft"):
            with self.subTest(status=status):
                self.assertIsNone(triage.merged_pr_url(
                    {"nodes": [self._att(PR, status=status, merged_at=None)]}))

    def test_non_pr_attachments_are_ignored(self):
        nodes = [self._att("https://sentry.io/organizations/x/issues/1/"),
                 self._att("https://github.com/JobLander-app/backend/commit/abc")]
        self.assertIsNone(triage.merged_pr_url({"nodes": nodes}))

    def test_latest_merged_pr_wins(self):
        older = self._att("https://github.com/JobLander-app/backend/pull/1",
                          merged_at="2026-09-01T00:00:00.000Z")
        newer = self._att(PR, merged_at="2026-09-29T21:48:34.000Z")
        self.assertEqual(triage.merged_pr_url({"nodes": [newer, older]}), PR)

    def test_malformed_input_is_no_pr(self):
        for value in (None, [], {"nodes": None}, {"nodes": [None, "x", {"url": PR}]}):
            with self.subTest(value=value):
                self.assertIsNone(triage.merged_pr_url(value))


class TestCooldownRecordsTheFix(unittest.TestCase):

    def setUp(self):
        triage.collection_errors.clear()

    def test_linear_attachments_become_fixed_by_pr(self):
        nodes = [
            {"identifier": "JOB-1131", "priority": 3, "state": {"type": "completed"},
             "updatedAt": CLOSED, "completedAt": CLOSED, "canceledAt": None,
             "description": f"**Signature:** `{SIG}`\n",
             "attachments": {"nodes": [{"url": PR, "metadata": {
                 "status": "merged", "mergedAt": "2026-10-01T08:59:00.000Z"}}]}},
            {"identifier": "JOB-1", "priority": 3, "state": {"type": "completed"},
             "updatedAt": CLOSED, "completedAt": CLOSED, "canceledAt": None,
             "description": "**Signature:** `svc:eu:not-a-bug`\n",
             "attachments": {"nodes": []}},
        ]
        body = json.dumps({"data": {"issues": {"pageInfo": {"hasNextPage": False},
                                               "nodes": nodes}}}).encode()
        sent = []

        def urlopen(req, timeout=None):  # noqa: ARG001
            sent.append(json.loads(req.data.decode())["query"])
            return io.BytesIO(body)

        with patch.object(triage, "run_cmd", return_value="key"), \
                patch("urllib.request.urlopen", urlopen):
            cooldowns = triage.collect_closed_signature_cooldowns()
        self.assertRegex(sent[0], r"attachments\(first: \d+\) \{ nodes \{ url metadata \} \}")
        self.assertEqual(cooldowns[SIG]["fixed_by_pr"], PR)
        self.assertIsNone(cooldowns["svc:eu:not-a-bug"]["fixed_by_pr"])


class TestParseTs(unittest.TestCase):

    def test_formats_seen_in_production(self):
        expected = datetime.datetime(2026, 10, 1, 14, 8, 39, 442058, tzinfo=datetime.timezone.utc)
        # Cloud Logging nanoseconds — rejected by Python 3.10's fromisoformat.
        self.assertEqual(triage._parse_ts("2026-10-01T14:08:39.442058123Z"), expected)
        self.assertEqual(triage._parse_ts("2026-10-01T14:08:39.442058Z"), expected)
        self.assertEqual(triage._parse_ts("2026-10-01T14:08:39.4Z"),
                         expected.replace(microsecond=400000))
        self.assertEqual(triage._parse_ts("2026-10-01T14:08:39Z"), expected.replace(microsecond=0))
        self.assertEqual(triage._parse_ts("2026-10-01T14:08:39"), expected.replace(microsecond=0))

    def test_garbage_is_none(self):
        for value in (None, "", "yesterday", 12):
            self.assertIsNone(triage._parse_ts(value))


if __name__ == "__main__":
    unittest.main()
