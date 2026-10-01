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
REV = "joblander-audio-engine-00285-nl6"


def _ms(iso):
    return int(datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def _group(sig=SIG, last_seen="2026-10-01T11:30:00.123456789Z", sev="P2", status="recurring",
           service="joblander-audio-engine", region="europe-west1"):
    return {
        "signature": sig, "service": service, "region": region, "count": 12,
        "first_seen": "2026-10-01T10:00:00Z", "last_seen": last_seen,
        "severity": sev, "diff_status": status, "sample_message": "Failed to deduct balance atomically",
        "linear_issue": "JOB-1131", "last_revision": REV,
    }


def _cooldown(sig=SIG, state="completed", pr=PR, closed=CLOSED, prior="P2", merged=None):
    return {sig: {"state_type": state, "closed_at": closed, "issue": "JOB-1131",
                  "prior_severity": prior, "fixed_by_pr": pr, "fixed_merged_at": merged}}


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


PRE = "joblander-audio-engine-00284-abc"   # the newest revision seen before the merge


class _Revisions:
    """Fake pre_merge_revision: returns a fixed revision name (or None)."""

    def __init__(self, pre=None):
        self.pre, self.calls = pre, []

    def __call__(self, service, region, merged_at, now_dt):
        self.calls.append((service, region, merged_at))
        return self.pre


def _run(groups, cooldowns, feed, revisions=None):
    revisions = revisions if revisions is not None else _Revisions()
    with patch("triage.datetime") as mock_dt, patch("urllib.request.urlopen", feed), \
            patch.object(triage, "pre_merge_revision", revisions):
        mock_dt.datetime.now.return_value = NOW
        mock_dt.datetime.fromisoformat.side_effect = datetime.datetime.fromisoformat
        mock_dt.timezone.utc = datetime.timezone.utc
        mock_dt.timedelta = datetime.timedelta
        _, esc = triage.build_escalations(groups, cooldowns)
    return esc


class TestFixDidNotHold(unittest.TestCase):
    """Cloud Run log signals: judged by the revision that logged the error."""

    def test_error_on_a_post_merge_revision_is_refiled(self):
        revs = _Revisions(PRE)
        feed = _Feed()
        [item] = _run([_group()], _cooldown(), feed, revs)
        self.assertEqual(item["action"], "linear_create_if_no_dup",
                         "a recurring P2 would otherwise be report_only")
        override = item["cooldown_override"]
        self.assertEqual(override["reason"], "recurred-after-fix")
        self.assertEqual(override["prior_issue"], "JOB-1131")
        self.assertEqual(override["fixed_by_pr"], PR)
        self.assertEqual(override["fix_live_at"], "2026-10-01T09:00:00Z")
        self.assertEqual(override["fix_live_source"], f"revision:{REV}>{PRE}")
        self.assertEqual(
            item["fix_did_not_hold"],
            f"fix did not hold: JOB-1131 ({PR}) merged 2026-10-01T09:00:00Z, signature seen "
            f"again at 2026-10-01T11:30:00.123456789Z on revision {REV}, newer than {PRE} "
            "which served before the merge")
        self.assertTrue(item["suggested_title"].startswith("[Monitor] "))
        self.assertIn("fix did not hold (JOB-1131)", item["suggested_title"])
        [(service, region, since)] = revs.calls
        self.assertEqual((service, region), ("joblander-audio-engine", "europe-west1"))
        self.assertEqual(since, triage._parse_ts(CLOSED))
        self.assertEqual(feed.urls, [], "Cloud Run log signals do not use the deploy feed")

    def test_the_first_post_merge_error_is_enough(self):
        # A one-off billing failure on the new revision must count on its own,
        # even right after the merge.
        [item] = _run([_group(last_seen="2026-10-01T09:00:01Z")], _cooldown(), _Feed(), _Revisions(PRE))
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")

    def test_p1_improved_is_refiled_too(self):
        [item] = _run([_group(sev="P1", status="improved")], _cooldown(prior="P1"), _Feed(),
                      _Revisions(PRE))
        self.assertEqual(item["action"], "linear_create_if_no_dup")
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")

    def test_p3_recurrence_stays_report_only(self):
        [item] = _run([_group(sev="P3")], _cooldown(), _Feed(), _Revisions(PRE))
        self.assertEqual(item["action"], "report_only")
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")

    def test_error_on_a_pre_merge_revision_keeps_the_cooldown(self):
        # The old revision keeps serving until traffic switches (backend deploys
        # with --no-traffic first), or after a rollback: its errors are expected.
        for pre in (REV, "joblander-audio-engine-00286-zzz"):
            with self.subTest(pre=pre):
                [item] = _run([_group()], _cooldown(), _Feed(), _Revisions(pre))
                self.assertEqual(item["action"], "cooldown_suppressed")
                self.assertNotIn("cooldown_override", item)

    def test_lookup_starts_at_the_merge(self):
        # The dispatcher merges first (08:50) and marks Done after (09:00).
        revs = _Revisions(PRE)
        [item] = _run([_group()], _cooldown(merged="2026-10-01T08:50:00Z"), _Feed(), revs)
        self.assertEqual(item["cooldown_override"]["fix_live_at"], "2026-10-01T08:50:00Z")
        self.assertEqual(revs.calls[0][2], triage._parse_ts("2026-10-01T08:50:00Z"))

    def test_unknown_pre_merge_state_or_missing_revision_keeps_the_cooldown(self):
        for pre in (None, "not-a-revision-name"):
            with self.subTest(pre=pre):
                [item] = _run([_group()], _cooldown(), _Feed(), _Revisions(pre))
                self.assertEqual(item["action"], "cooldown_suppressed")
        group = _group()
        del group["last_revision"]
        revs = _Revisions(PRE)
        [norev] = _run([group], _cooldown(), _Feed(), revs)
        self.assertEqual(norev["action"], "cooldown_suppressed")
        self.assertEqual(revs.calls, [])

    def test_done_without_pr_stays_suppressed(self):
        revs = _Revisions(PRE)
        [item] = _run([_group()], _cooldown(pr=None), _Feed(), revs)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertEqual(revs.calls, [], "no fix → no revision lookup")

    def test_canceled_stays_suppressed_even_with_a_pr(self):
        revs = _Revisions(PRE)
        [item] = _run([_group()], _cooldown(state="canceled"), _Feed(), revs)
        self.assertEqual(item["action"], "cooldown_suppressed")
        self.assertEqual(item["cooldown"]["limit_h"], triage.COOLDOWN_HOURS_CANCELED)

    def test_synthetic_region_aggregate_uses_the_deploy_feed(self):
        # The geo misroute group is Cloud Run-derived but spans regions
        # ("geo-routing") and carries no revision: judged by the feed, which
        # needs every production region deployed.
        sig = "joblander-app:geo:in-users-misrouted"
        group = _group(sig=sig, service="joblander-app", region="geo-routing",
                       last_seen="2026-10-01T11:00:00Z", sev="P1")
        del group["last_revision"]
        feed = _Feed([_deploy("2026-10-01T09:20:00Z", service="joblander-app", region=r)
                      for r in triage.REGIONS])
        revs = _Revisions()
        [item] = _run([group], _cooldown(sig=sig, prior="P1"), feed, revs)
        self.assertEqual(item["cooldown_override"]["reason"], "recurred-after-fix")
        self.assertTrue(item["cooldown_override"]["fix_live_source"].endswith(":all-regions"))
        self.assertEqual(revs.calls, [])

    def test_sentry_feed_unavailable_or_empty_keeps_the_cooldown(self):
        group = _group(sig=SENTRY_SIG, service="joblander-app", region="frontend",
                       last_seen="2026-10-01T11:00:00Z")
        for feed in (_Feed(error=URLError("connection refused")),
                     _Feed(error=HTTPError("http://127.0.0.1:4200/changes", 503, "degraded", {}, None)),
                     _Feed([])):
            with self.subTest(feed=feed.error or "empty"):
                [item] = _run([group], _cooldown(sig=SENTRY_SIG), feed)
                self.assertEqual(item["action"], "cooldown_suppressed")
                self.assertNotIn("fix_did_not_hold", item)


class TestPreMergeRevision(unittest.TestCase):

    def _entry(self, rev):
        return {"timestamp": "2026-10-01T08:00:00Z", "resource": {"labels": {"revision_name": rev}}}

    def test_highest_sequence_seen_before_the_merge_wins(self):
        # A rollback brought 00220 back after 00228 had run: 00228 is the frontier.
        merged = datetime.datetime(2026, 10, 1, 9, 0, tzinfo=datetime.timezone.utc)
        system = json.dumps([self._entry("joblander-app-00220-9b2"),
                             self._entry("joblander-app-00228-mdd"),
                             self._entry("joblander-app-00227-f52")])
        newest = json.dumps([self._entry("joblander-app-00220-9b2")])
        with patch.object(triage, "run_cmd", side_effect=[system, newest]) as run:
            pre = triage.pre_merge_revision("joblander-app", "us-central1", merged, NOW)
        self.assertEqual(pre, "joblander-app-00228-mdd")
        first, second = (c[0][0] for c in run.call_args_list)
        self.assertIn('logName:"varlog%2Fsystem"', first[3])
        self.assertIn('timestamp<"2026-10-01T09:00:00Z"', first[3])
        self.assertIn('timestamp>="2026-09-29T09:00:00Z"', first[3])
        self.assertIn('resource.labels.location="us-central1"', first[3])
        self.assertIn("--limit=1", second)

    def test_no_entries_or_bad_output_is_none(self):
        merged = datetime.datetime(2026, 10, 1, 9, 0, tzinfo=datetime.timezone.utc)
        for outs in ((None, None), ("", "[]"), ("not json", "[]"), ('{"a": 1}', "[]")):
            with self.subTest(outs=outs), patch.object(triage, "run_cmd", side_effect=list(outs)):
                self.assertIsNone(triage.pre_merge_revision("s", "r", merged, NOW))

    def test_either_query_failing_fails_the_whole_lookup(self):
        # A partial view could miss a newer pre-merge revision and make it look
        # post-merge: one failed query means the pre-merge state is unknown.
        merged = datetime.datetime(2026, 10, 1, 9, 0, tzinfo=datetime.timezone.utc)
        ok = json.dumps([self._entry("joblander-audio-engine-00284-d9x")])
        for outs in ((None, ok), (ok, None)):
            with self.subTest(outs=outs), patch.object(triage, "run_cmd", side_effect=list(outs)):
                self.assertIsNone(triage.pre_merge_revision("joblander-audio-engine", "asia-south1",
                                                            merged, NOW))

    def test_revision_seq(self):
        self.assertEqual(triage.revision_seq("joblander-audio-engine-00285-nl6"), 285)
        self.assertEqual(triage.revision_seq("joblander-app-00344-dnv"), 344)
        for bad in (None, "", "joblander-app", "joblander-app-285-nl6"):
            self.assertIsNone(triage.revision_seq(bad))

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
        self.assertEqual(cooldowns[SIG]["fixed_merged_at"], "2026-10-01T08:59:00Z")
        self.assertIsNone(cooldowns["svc:eu:not-a-bug"]["fixed_by_pr"])
        self.assertIsNone(cooldowns["svc:eu:not-a-bug"]["fixed_merged_at"])


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
