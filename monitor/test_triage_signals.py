"""Regression replays for JOB-952/953; no network or model execution."""

import copy
import datetime
import io
import json
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import triage


def sentry_issue(**overrides):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    return {
        "id": "145869830", "title": "Consecutive HTTP", "count": "38",
        "userCount": 0, "culprit": "POST /app/api/connection-details",
        "firstSeen": now, "lastSeen": now, "level": "info",
        "issueCategory": "http_client", "issueType": "performance_consecutive_http",
        "metadata": {"value": "POST https://lk-in.joblander.app/twirp/livekit.RoomService/CreateRoom"},
        "permalink": "https://joblander-z2.sentry.io/issues/145869830/", **overrides,
    }


def request_log(status=500, url="https://joblander.app/", method="POST", revision="app-00194", **overrides):
    return {
        "resource": {"labels": {"service_name": "joblander-app", "location": "us-central1",
                                "revision_name": revision}},
        "httpRequest": {"status": status, "requestMethod": method, "requestUrl": url},
        "timestamp": "2026-09-11T23:48:37Z", "trace": "projects/test/traces/abc",
        "insertId": "request-id", **overrides,
    }


class SignalTests(unittest.TestCase):
    def setUp(self):
        triage.collection_errors.clear()

    def collect_sentry(self, issues):
        groups = {}
        with patch.dict("os.environ", {"SENTRY_TOKEN": "test-only"}), \
                patch.object(triage.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(issues).encode())) as fetch:
            triage.collect_sentry(groups)
        query = parse_qs(urlsplit(fetch.call_args.args[0].full_url).query)
        self.assertEqual(query["query"], ["is:unresolved"])
        return groups

    def escalations(self, groups):
        triage.assign_severity(groups, {}, {}, 0)
        with tempfile.TemporaryDirectory() as state:
            final, _ = triage.diff_with_previous(groups, state)
        return triage.build_escalations(final)

    def test_job953_performance_info_produces_no_ticket_or_page(self):
        # Even error-level performance issues are not exception reports.
        for overrides in ({}, {"level": "error"}, {"level": "fatal"}, {"issueCategory": "performance"},
                          {"issueCategory": None}, {"issueCategory": "error"}):
            with self.subTest(overrides=overrides):
                groups = self.collect_sentry([sentry_issue(**overrides)])
                self.assertEqual(groups, {})
                self.assertEqual(self.escalations(groups), ([], []))

    def test_informational_error_category_logs_are_not_bugs(self):
        for level in ("info", "debug", "log", "warning", "sample"):
            with self.subTest(level=level):
                self.assertEqual(self.collect_sentry([sentry_issue(
                    level=level, issueCategory="error", issueType="error")]), {})

    def test_real_exceptions_keep_signature_and_reach_escalation(self):
        for level in ("error", "fatal"):
            with self.subTest(level=level):
                groups = self.collect_sentry([sentry_issue(
                    level=level, issueCategory="error", issueType="error",
                    title="TypeError: Room provisioning failed",
                    metadata={"type": "TypeError", "value": "Room provisioning failed"})])
                pages, items = self.escalations(groups)
                self.assertEqual(pages, [])
                self.assertEqual(len(items), 1)
                self.assertEqual(items[0]["action"], "linear_create_if_no_dup")
                self.assertEqual(items[0]["signature"], "sentry:joblander-app:connection-details:typeerror")
                self.assertEqual(items[0]["window"], "7d")
                self.assertEqual(items[0]["sentry_level"], level)
                self.assertEqual(items[0]["sentry_category"], "error")

    def test_missing_metadata_uses_truthful_title_without_guessing_type(self):
        for metadata in (None, {}, {"title": "Database unavailable"}):
            with self.subTest(metadata=metadata):
                groups = self.collect_sentry([sentry_issue(
                    level=None, issueCategory=None, issueType=None, metadata=metadata,
                    title="Database unavailable")])
                group = next(iter(groups.values()))
                self.assertTrue(group["signature"].endswith(":database-unavailable"))
                self.assertEqual(group["sample_message"], "Database unavailable")
                self.assertEqual(self.escalations(groups)[1][0]["action"], "linear_create_if_no_dup")

    def test_stale_real_exception_stays_out(self):
        old = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)).isoformat()
        self.assertEqual(self.collect_sentry([sentry_issue(
            level="error", issueCategory="error", issueType="error", lastSeen=old)]), {})

    def collect_requests(self, entries):
        groups = {}
        with patch.object(triage, "gcloud_logging_read", return_value=entries):
            triage.collect_cloud_run(groups)
        return groups

    def test_job952_preserves_real_500_count_and_request_evidence(self):
        groups = self.collect_requests([request_log() for _ in range(14)])
        self.assertEqual(list(groups), ["joblander-app:us-central1:http-500-post-root"])
        group = next(iter(groups.values()))
        self.assertEqual(group["count"], 14)
        self.assertEqual(group["sample_message"], "HTTP 500 POST / (revision app-00194)")
        pages, items = self.escalations(groups)
        self.assertEqual(pages, [])
        self.assertEqual(items[0]["action"], "linear_create_if_no_dup")
        self.assertEqual(items[0]["window"], "2h")
        self.assertEqual(items[0]["request_context"]["trace"], "projects/test/traces/abc")
        self.assertEqual(items[0]["request_context"]["insert_id"], "request-id")

    def test_requests_distinguish_route_status_method_but_not_revision(self):
        entries = [request_log(), request_log(revision="app-00195"), request_log(status=503),
                   request_log(url="https://joblander.app/api/checkout"), request_log(method="GET"),
                   request_log(url="https://joblander.app/root")]
        groups = self.collect_requests(entries)
        self.assertEqual(len(groups), 5)
        self.assertEqual(groups["joblander-app:us-central1:http-500-post-root"]["count"], 2)

    def test_url_credentials_and_query_do_not_reach_evidence_or_signature(self):
        groups = self.collect_requests([request_log(
            url="https://private-user:private-pass@joblander.app/api/checkout?token=private-token#private-fragment")])
        serialized = json.dumps(groups)
        self.assertNotIn("private-", serialized)
        self.assertEqual(next(iter(groups.values()))["request_context"]["path"], "/api/checkout")

    def test_dynamic_request_ids_group_together(self):
        groups = self.collect_requests([request_log(url=f"https://joblander.app/api/sessions/{identifier}")
                                       for identifier in ("abc00000-0000-0000-0000-000000000000",
                                                          "def00000-0000-0000-0000-000000000001")])
        self.assertEqual(len(groups), 1)
        self.assertEqual(next(iter(groups.values()))["count"], 2)

    def test_route_structure_case_and_long_suffixes_do_not_collide(self):
        paths = ["/api/foo-bar", "/api/foo/bar", "/api/Foo-bar", "/api/foo_bar",
                 "/api/a/b/c/d/e/f/first", "/api/a/b/c/d/e/f/second"]
        groups = self.collect_requests([request_log(url="https://joblander.app" + path)
                                        for path in paths for _ in range(6)])
        self.assertEqual(len(groups), len(paths))
        self.assertTrue(all(g["count"] == 6 for g in groups.values()))
        self.assertEqual({g["request_context"]["path"] for g in groups.values()}, set(paths))
        pages, items = self.escalations(groups)
        self.assertEqual(pages, [])
        self.assertTrue(all(item["action"] == "report_only" for item in items))

    def test_malformed_or_missing_request_url_does_not_crash_collection(self):
        for url in ("http://[invalid", None, ""):
            with self.subTest(url=url):
                group = next(iter(self.collect_requests([request_log(url=url)]).values()))
                self.assertEqual(group["request_context"]["path"], "unknown-route")

    def test_text_and_structured_exceptions_keep_their_original_signatures(self):
        for payload in ({"textPayload": "RuntimeError: room failed"},
                        {"jsonPayload": {"message": "RuntimeError: room failed"}}):
            with self.subTest(payload=payload):
                groups = self.collect_requests([request_log(**payload)])
                self.assertEqual(list(groups), ["joblander-app:us-central1:runtimeerror-room-failed"])
                self.assertEqual(next(iter(groups.values()))["sample_message"], "RuntimeError: room failed")

    def test_non_object_json_does_not_abort_request_collection(self):
        for payload in (["failure"], "failure", 42, 0, False, []):
            with self.subTest(payload=payload):
                groups = self.collect_requests([request_log(jsonPayload=payload), request_log()])
                self.assertEqual(sum(g["count"] for g in groups.values()), 2)
                self.assertEqual(triage.entry_message({"jsonPayload": payload}), json.dumps(payload))
                self.assertTrue(all(g.get("request_context") for g in groups.values()))

    def test_real_http_spike_still_pages_p0(self):
        groups = self.collect_requests([request_log() for _ in range(1001)])
        original = copy.deepcopy(groups)
        pages, items = self.escalations(groups)
        self.assertEqual(len(pages), 1)
        self.assertEqual(items[0]["action"], "telegram_p0_and_linear")
        self.assertEqual(items[0]["severity"], "P0")
        self.assertEqual(items[0]["count"], next(iter(original.values()))["count"])


if __name__ == "__main__":
    unittest.main()
