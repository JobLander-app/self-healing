"""Unit tests for the duplicate-free-grant worker monitor check (JOB-1010).

Tests the three escalation conditions in check_duplicate_worker():
  1. Missing run record (Firestore 404) → P2
  2. purchasedMinutesReduced > 0 → P1
  3. revokedMinutes/day > 3× trailing 7-day median → P2
Plus: mode=off skips the check entirely; errors > 0 → P2.

No network or GCP calls are made — all Firestore and gcloud interactions are
patched at the urllib.request / subprocess level.
"""

import datetime
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import MagicMock, patch

import triage


# ---------------------------------------------------------------------------
# Firestore response helpers
# ---------------------------------------------------------------------------

def _fs_doc(fields_dict):
    """Build a minimal Firestore REST document payload from a plain dict."""
    fields = {}
    for k, v in fields_dict.items():
        if isinstance(v, int):
            fields[k] = {"integerValue": str(v)}
        elif isinstance(v, float):
            fields[k] = {"doubleValue": v}
        elif isinstance(v, str):
            fields[k] = {"stringValue": v}
        elif v is None:
            fields[k] = {"nullValue": None}
    return json.dumps({"fields": fields}).encode()


def _mock_urlopen_doc(doc_bytes):
    """Return a context-manager mock that yields doc_bytes on read()."""
    cm = MagicMock()
    cm.__enter__ = lambda s: cm
    cm.__exit__ = MagicMock(return_value=False)
    cm.read.return_value = doc_bytes
    return cm


def _http_404():
    """Raise an HTTPError with code 404."""
    raise urllib.error.HTTPError(url="", code=404, msg="Not Found", hdrs={}, fp=None)


# ---------------------------------------------------------------------------
# Helpers to exercise the check
# ---------------------------------------------------------------------------

def _run_check(doc_fields=None, mode="write", token="fake-token", extra_urlopen_calls=None):
    """Run check_duplicate_worker with patched gcloud + Firestore.

    doc_fields: dict of field-name → Python value for yesterday's run record,
                or None to simulate a 404 (missing document).
    Returns the groups dict populated by the check.
    """
    groups = {}
    triage.collection_errors.clear()

    call_count = [0]

    def fake_urlopen(req, timeout=15):
        call_count[0] += 1
        if isinstance(req, urllib.request.Request):
            url = req.full_url
        else:
            url = str(req)

        # First call = yesterday's doc
        if call_count[0] == 1:
            if doc_fields is None:
                _http_404()
            return _mock_urlopen_doc(_fs_doc(doc_fields))

        # Subsequent calls = prior-day docs for spike detection
        if extra_urlopen_calls is not None:
            idx = call_count[0] - 2
            if idx < len(extra_urlopen_calls):
                val = extra_urlopen_calls[idx]
                if val is None:
                    _http_404()
                return _mock_urlopen_doc(_fs_doc({"revokedMinutes": val, "mode": "write"}))
        # Default: missing prior days
        _http_404()

    with patch.dict("os.environ", {"DUPLICATE_WORKER_MODE": mode}), \
         patch.object(triage, "run_cmd", return_value=token), \
         patch.object(triage.urllib.request, "urlopen", side_effect=fake_urlopen):
        triage.check_duplicate_worker(groups)

    return groups


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class DuplicateWorkerCheckTests(unittest.TestCase):

    def setUp(self):
        triage.collection_errors.clear()

    # -----------------------------------------------------------------------
    # Condition 0: mode=off → no check
    # -----------------------------------------------------------------------

    def test_skipped_when_mode_is_off(self):
        groups = {}
        triage.collection_errors.clear()
        with patch.dict("os.environ", {"DUPLICATE_WORKER_MODE": "off"}), \
             patch.object(triage, "run_cmd", return_value="fake-token") as mock_cmd, \
             patch.object(triage.urllib.request, "urlopen") as mock_urlopen:
            triage.check_duplicate_worker(groups)
        self.assertEqual(groups, {})
        mock_urlopen.assert_not_called()

    def test_skipped_when_mode_env_absent_defaults_to_off(self):
        groups = {}
        triage.collection_errors.clear()
        import os as _os
        env = {k: v for k, v in _os.environ.items() if k != "DUPLICATE_WORKER_MODE"}
        with patch.dict("os.environ", env, clear=True), \
             patch.object(triage, "run_cmd", return_value="fake-token") as mock_cmd, \
             patch.object(triage.urllib.request, "urlopen") as mock_urlopen:
            triage.check_duplicate_worker(groups)
        self.assertEqual(groups, {})
        mock_urlopen.assert_not_called()

    # -----------------------------------------------------------------------
    # Condition 1: missing run record → P2
    # -----------------------------------------------------------------------

    def test_missing_run_record_raises_p2(self):
        groups = _run_check(doc_fields=None, mode="write")
        self.assertIn("duplicate-worker:missing-run", groups)
        g = groups["duplicate-worker:missing-run"]
        self.assertEqual(g["severity"], "P2")
        self.assertIn("did not run", g["sample_message"])

    def test_missing_run_record_in_dry_run_mode(self):
        groups = _run_check(doc_fields=None, mode="dry_run")
        self.assertIn("duplicate-worker:missing-run", groups)
        self.assertEqual(groups["duplicate-worker:missing-run"]["severity"], "P2")

    def test_clean_run_no_groups(self):
        """A clean run with no errors must not produce any escalation."""
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 5, "mode": "write"},
            mode="write",
            extra_urlopen_calls=[5, 5, 5, 5, 5, 5, 5],  # stable median
        )
        # Stable median (5) with today = 5 → not a spike
        self.assertNotIn("duplicate-worker:missing-run", groups)
        self.assertNotIn("duplicate-worker:run-errors", groups)
        self.assertNotIn("duplicate-worker:purchased-minutes-reduced", groups)
        self.assertNotIn("duplicate-worker:revocation-spike", groups)

    # -----------------------------------------------------------------------
    # Condition 2: purchasedMinutesReduced > 0 → P1
    # -----------------------------------------------------------------------

    def test_purchased_minutes_reduced_raises_p1(self):
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 3,
                        "revokedMinutes": 0, "mode": "write"},
            mode="write",
        )
        self.assertIn("duplicate-worker:purchased-minutes-reduced", groups)
        g = groups["duplicate-worker:purchased-minutes-reduced"]
        self.assertEqual(g["severity"], "P1")
        self.assertIn("must never happen", g["sample_message"])
        self.assertEqual(g["count"], 3)

    def test_zero_purchased_reduced_no_p1(self):
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 0, "mode": "write"},
            mode="write",
        )
        self.assertNotIn("duplicate-worker:purchased-minutes-reduced", groups)

    # -----------------------------------------------------------------------
    # Condition 3: errors > 0 → P2
    # -----------------------------------------------------------------------

    def test_errors_field_raises_p2(self):
        groups = _run_check(
            doc_fields={"errors": 2, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 0, "mode": "write"},
            mode="write",
        )
        self.assertIn("duplicate-worker:run-errors", groups)
        g = groups["duplicate-worker:run-errors"]
        self.assertEqual(g["severity"], "P2")
        self.assertEqual(g["count"], 2)

    # -----------------------------------------------------------------------
    # Condition 4: revocation spike → P2
    # -----------------------------------------------------------------------

    def test_spike_more_than_3x_median_raises_p2(self):
        # Median of [5, 5, 5, 5, 5, 5, 5] = 5; today = 20 → 20 > 3*5 = 15
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 20, "mode": "write"},
            mode="write",
            extra_urlopen_calls=[5, 5, 5, 5, 5, 5, 5],
        )
        self.assertIn("duplicate-worker:revocation-spike", groups)
        g = groups["duplicate-worker:revocation-spike"]
        self.assertEqual(g["severity"], "P2")
        self.assertIn("3×", g["sample_message"])  # "3×"

    def test_no_spike_when_within_3x(self):
        # Median = 10; today = 25 → 25 <= 3*10 = 30 → no spike
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 25, "mode": "write"},
            mode="write",
            extra_urlopen_calls=[10, 10, 10, 10, 10, 10, 10],
        )
        self.assertNotIn("duplicate-worker:revocation-spike", groups)

    def test_spike_skipped_when_fewer_than_3_prior_days(self):
        # Only 2 prior docs available → spike check must be skipped
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 1000, "mode": "write"},
            mode="write",
            extra_urlopen_calls=[1, 1],  # only 2 prior docs
        )
        self.assertNotIn("duplicate-worker:revocation-spike", groups)

    def test_spike_skipped_when_median_is_zero(self):
        # Median = 0: comparison is undefined (0 * 3 = 0, not a useful threshold)
        groups = _run_check(
            doc_fields={"errors": 0, "purchasedMinutesReduced": 0,
                        "revokedMinutes": 500, "mode": "write"},
            mode="write",
            extra_urlopen_calls=[0, 0, 0, 0, 0, 0, 0],
        )
        self.assertNotIn("duplicate-worker:revocation-spike", groups)

    # -----------------------------------------------------------------------
    # Informational: no token → informational error, no groups
    # -----------------------------------------------------------------------

    def test_no_access_token_is_informational(self):
        groups = {}
        triage.collection_errors.clear()
        with patch.dict("os.environ", {"DUPLICATE_WORKER_MODE": "write"}), \
             patch.object(triage, "run_cmd", return_value=None), \
             patch.object(triage.urllib.request, "urlopen") as mock_urlopen:
            triage.check_duplicate_worker(groups)
        self.assertEqual(groups, {})
        mock_urlopen.assert_not_called()
        errors = [e for e in triage.collection_errors if "duplicate" in e.get("cmd", "").lower()
                  or "duplicate" in e.get("error", "").lower()]
        self.assertTrue(any(e.get("informational") for e in errors))


if __name__ == "__main__":
    unittest.main()
