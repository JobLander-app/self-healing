"""Regression tests for the per-signature cooldown gate (JOB-858).

These tests exercise the two functions added to triage.py for the cooldown gate
without requiring any external services (Linear API is mocked).

Replay scenarios from the ticket evidence (2026-07-27):
  - JOB-840 filed 07:03, closed Canceled 07:26 → JOB-843 filed 10:02 (same sig)
  - JOB-838 filed prior, closed Done 08:31 → JOB-844 filed 10:02 (same sig)
Both should have been suppressed by the cooldown gate; these tests verify that.
"""

import datetime
import sys
import unittest
from unittest.mock import patch

# ---------------------------------------------------------------------------
# Module-level import: triage.py lives in the same directory.
# ---------------------------------------------------------------------------
sys.path.insert(0, __file__.rsplit("/", 1)[0])

import triage  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _utc(iso: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _make_final_group(sig: str, sev: str, status: str = "recurring", count: int = 10):
    return {
        "signature": sig,
        "service": "ai-voice-agent-python",
        "region": "lk-asia-south1",
        "count": count,
        "first_seen": "2026-07-27T07:00:00Z",
        "last_seen": "2026-07-27T09:00:00Z",
        "severity": sev,
        "diff_status": status,
        "sample_message": "Google STT 499 cancelled",
        "linear_issue": None,
        "sentry_url": None,
        "user_count": None,
    }


SIG_STT = "voice-agent:lk-asia-south1:google-stt-<n>-cancelled"
SIG_STT_2 = "voice-agent:lk-asia-south1:google-stt-<n>-<n>-metadata-size-limit"

NOW = datetime.datetime(2026, 7, 27, 10, 2, 0, tzinfo=datetime.timezone.utc)


# ---------------------------------------------------------------------------
# Tests for build_escalations() cooldown gate
# ---------------------------------------------------------------------------


class TestBuildEscalationsCooldown(unittest.TestCase):

    def _run(self, final_groups, cooldowns=None, now_dt=NOW):
        """Invoke build_escalations with a patched 'now' timestamp."""
        with patch("triage.datetime") as mock_dt:
            mock_dt.datetime.now.return_value = now_dt
            mock_dt.datetime.fromisoformat.side_effect = datetime.datetime.fromisoformat
            mock_dt.timezone.utc = datetime.timezone.utc
            mock_dt.timedelta = datetime.timedelta
            p0, esc = triage.build_escalations(final_groups, cooldowns or {})
        return p0, esc

    # -----------------------------------------------------------------------
    # Replay: JOB-840 → JOB-843 (Canceled 2.6h before re-check, P2 recurring)
    # -----------------------------------------------------------------------

    def test_job840_843_suppressed(self):
        """Signature closed Canceled 2.6h ago → no new ticket (JOB-843 prevented)."""
        cooldowns = {
            SIG_STT: {
                "state_type": "canceled",
                "closed_at": "2026-07-27T07:26:00.000Z",
                "issue": "JOB-840",
                "prior_severity": "P2",
            }
        }
        groups = [_make_final_group(SIG_STT, "P2", status="recurring")]
        _, esc = self._run(groups, cooldowns)
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        active = [e for e in esc if e["action"] != "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 1, "Must suppress 1 signature")
        self.assertEqual(suppressed[0]["signature"], SIG_STT)
        self.assertEqual(suppressed[0]["cooldown"]["prior_issue"], "JOB-840")
        self.assertAlmostEqual(suppressed[0]["cooldown"]["age_h"], 2.6, delta=0.1)
        self.assertEqual(len(active), 0, "Must not produce any filing escalation")

    # -----------------------------------------------------------------------
    # Replay: JOB-838 → JOB-844 (Done 1.5h before re-check, P1 recurring)
    # -----------------------------------------------------------------------

    def test_job838_844_suppressed(self):
        """Signature closed Done 1.5h ago → no new ticket (JOB-844 prevented)."""
        cooldowns = {
            SIG_STT_2: {
                "state_type": "completed",
                "closed_at": "2026-07-27T08:31:00.000Z",
                "issue": "JOB-838",
                "prior_severity": "P1",
            }
        }
        groups = [_make_final_group(SIG_STT_2, "P1", status="recurring")]
        _, esc = self._run(groups, cooldowns)
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 1)
        self.assertEqual(suppressed[0]["cooldown"]["prior_issue"], "JOB-838")
        self.assertEqual(suppressed[0]["cooldown"]["limit_h"], triage.COOLDOWN_HOURS_DONE)

    # -----------------------------------------------------------------------
    # Cooldown expired: signature re-filed after window passes
    # -----------------------------------------------------------------------

    def test_cooldown_expired_allows_refiling(self):
        """After cooldown expires (>12h for Canceled), signature is escalated normally."""
        cooldowns = {
            SIG_STT: {
                "state_type": "canceled",
                "closed_at": "2026-07-26T21:00:00.000Z",  # ~13h before NOW
                "issue": "JOB-835",
                "prior_severity": "P2",
            }
        }
        groups = [_make_final_group(SIG_STT, "P2", status="new")]
        _, esc = self._run(groups, cooldowns)
        active = [e for e in esc if e["action"] != "cooldown_suppressed"]
        self.assertEqual(len(active), 1, "Must escalate after cooldown expires")
        self.assertIn(active[0]["action"], ("linear_create_if_no_dup", "linear_ensure_open_issue"))

    # -----------------------------------------------------------------------
    # Severity escalation override: P2→P1 during cooldown → MUST file
    # -----------------------------------------------------------------------

    def test_severity_escalation_overrides_cooldown(self):
        """If severity rises (P2→P1) during cooldown, the cooldown is bypassed."""
        cooldowns = {
            SIG_STT: {
                "state_type": "canceled",
                "closed_at": "2026-07-27T07:00:00.000Z",  # 3h ago, within 12h limit
                "issue": "JOB-840",
                "prior_severity": "P2",
            }
        }
        # Same signature is now P1 (worsened)
        groups = [_make_final_group(SIG_STT, "P1", status="worsened")]
        _, esc = self._run(groups, cooldowns)
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        active = [e for e in esc if e["action"] != "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 0, "Must NOT suppress when severity escalated")
        self.assertEqual(len(active), 1, "Must produce one escalation")
        self.assertIn("cooldown_override", active[0])
        self.assertEqual(active[0]["cooldown_override"]["prior_severity"], "P2")
        self.assertEqual(active[0]["cooldown_override"]["current_severity"], "P1")

    # -----------------------------------------------------------------------
    # P0 always exempt from cooldown
    # -----------------------------------------------------------------------

    def test_p0_never_suppressed(self):
        """P0 signatures are always escalated regardless of cooldown."""
        cooldowns = {
            SIG_STT: {
                "state_type": "canceled",
                "closed_at": "2026-07-27T09:50:00.000Z",  # 12 min ago
                "issue": "JOB-840",
                "prior_severity": "P0",
            }
        }
        groups = [_make_final_group(SIG_STT, "P0", status="recurring")]
        p0, esc = self._run(groups, cooldowns)
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 0, "P0 must never be suppressed")

    # -----------------------------------------------------------------------
    # No cooldown for unknown signature
    # -----------------------------------------------------------------------

    def test_no_cooldown_for_unknown_signature(self):
        """Signatures not in the cooldowns map are escalated normally."""
        groups = [_make_final_group(SIG_STT, "P2", status="new")]
        _, esc = self._run(groups, cooldowns={})
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 0)

    # -----------------------------------------------------------------------
    # Resolved groups are still skipped (existing behaviour preserved)
    # -----------------------------------------------------------------------

    def test_resolved_groups_skipped(self):
        """Groups with diff_status='resolved' are excluded from escalations."""
        groups = [_make_final_group(SIG_STT, "P2", status="resolved")]
        _, esc = self._run(groups, cooldowns={})
        self.assertEqual(len(esc), 0)

    # -----------------------------------------------------------------------
    # Malformed closed_at date in cooldown → fail open (no suppression)
    # -----------------------------------------------------------------------

    def test_bad_date_in_cooldown_fails_open(self):
        """A malformed closed_at date in the cooldown map causes fail-open."""
        cooldowns = {
            SIG_STT: {
                "state_type": "canceled",
                "closed_at": "not-a-date",
                "issue": "JOB-840",
                "prior_severity": "P2",
            }
        }
        groups = [_make_final_group(SIG_STT, "P2", status="new")]
        _, esc = self._run(groups, cooldowns)
        suppressed = [e for e in esc if e["action"] == "cooldown_suppressed"]
        self.assertEqual(len(suppressed), 0, "Bad date must fail open — no suppression")
        active = [e for e in esc if e["action"] != "cooldown_suppressed"]
        self.assertEqual(len(active), 1)


# ---------------------------------------------------------------------------
# Tests for collect_closed_signature_cooldowns() — signature extraction
# ---------------------------------------------------------------------------


class TestExtractSignatureFromDescription(unittest.TestCase):
    """Unit-test the regex used in collect_closed_signature_cooldowns()."""

    def _extract(self, description: str):
        import re
        m = re.search(r"\*\*Signature:\*\*\s*`([^`\n]+)`", description)
        return m.group(1).strip() if m else None

    def test_factory_ready_body(self):
        desc = (
            "## Problem (WHY)\n\nSomething broke.\n\n"
            "## Observed signal\n\n"
            "- **Signature:** `voice-agent:lk-asia-south1:google-stt-<n>-cancelled`\n"
            "- **Count:** 17 events in window 2h\n"
        )
        self.assertEqual(
            self._extract(desc),
            "voice-agent:lk-asia-south1:google-stt-<n>-cancelled",
        )

    def test_missing_signature_returns_none(self):
        desc = "## Problem\nNo signature here."
        self.assertIsNone(self._extract(desc))

    def test_sentry_signature(self):
        desc = "- **Signature:** `sentry:joblander-app:practice:invalid-character-error`\n"
        self.assertEqual(
            self._extract(desc),
            "sentry:joblander-app:practice:invalid-character-error",
        )

    def test_multiline_body_picks_first_signature(self):
        desc = (
            "## Observed signal\n"
            "- **Signature:** `joblander-audio-engine:us-central1:gemini-utils-network-failure`\n"
            "## Notes\n"
            "- **Signature:** `this-should-not-match`\n"
        )
        sig = self._extract(desc)
        self.assertEqual(sig, "joblander-audio-engine:us-central1:gemini-utils-network-failure")


if __name__ == "__main__":
    unittest.main()
