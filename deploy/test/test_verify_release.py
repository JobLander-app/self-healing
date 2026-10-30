import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verify_release", Path(__file__).resolve().parents[1] / "bin/verify-release.py")
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.state = dict(head="expected", active=True, pending=False, profileLoaded=True,
                          status="ok", accountingHealthy=True, changeFeedReadable=True, ready=False)

    def test_checkout_alone_or_incomplete_transaction_cannot_pass(self):
        for key, value in dict(head="old", active=False, pending=True, profileLoaded=False,
                               status="error", accountingHealthy=False, changeFeedReadable=False).items():
            self.assertFalse(verify.activated({**self.state, key: value}, "expected"), key)
        # Stale provider evidence is reported separately, not a release failure.
        self.assertTrue(verify.activated(self.state, "expected"))

    def test_transient_failure_restarts_the_full_observation_window(self):
        states = [self.state] * 3 + [OSError("restarting")] + [self.state] * 5
        with patch.object(verify.sys, "argv", ["verify", "expected", "/unused", "agent"]), \
             patch.object(verify, "snapshot", side_effect=states) as snapshot, \
             patch.object(verify.time, "sleep"), patch("builtins.print"):
            verify.main()
        self.assertEqual(snapshot.call_count, 9)


if __name__ == "__main__":
    unittest.main()
