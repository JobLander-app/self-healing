"""Exercise provisioning against disposable directories, without a VM or secrets."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("provision_profile", ROOT / "deploy/bin/provision-profile.py")
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "etc/self-healing"
        self.checkout = self.root / "checkout"
        self.target = self.checkout / "consumers/joblander/profile.json"
        self.contract = "SH_DIR=/home/joblander/self-healing\n"

    def test_effective_service_overrides_are_validated_before_installation(self):
        with self.assertRaisesRegex(ValueError, "targets.project"):
            provision.prepare(ROOT, self.checkout, "consumers/joblander/profile.json",
                              [{"GCP_PROJECT": "different-project"}])
        self.assertFalse(self.directory.exists())

    def test_consumer_legacy_lock_and_user_are_preserved(self):
        user, contract, target = provision.prepare(ROOT, self.checkout, "consumers/joblander/profile.json", [{}])
        self.assertEqual(user, "joblander")
        self.assertEqual(target, self.target)
        self.assertIn("DEPLOY_MONITOR_LOCK=/tmp/joblander-Monitor.lock\n", contract)
        self.assertNotIn("TOKEN", contract)

    def test_profile_must_be_repository_relative(self):
        for name in ("/tmp/profile.json", "../profile.json"):
            with self.assertRaises(ValueError):
                provision.prepare(ROOT, self.checkout, name, [])

    def test_contract_is_published_last_and_existing_checkout_is_untouched(self):
        self.checkout.mkdir()
        marker = self.checkout / "existing-state"
        marker.write_text("preserve me")
        original = os.replace
        def replace(source, destination):
            self.assertEqual(os.readlink(self.directory / "profile.json"), str(self.target))
            self.assertFalse((self.directory / "deploy.env").exists())
            original(source, destination)
        with patch.object(provision.os, "replace", side_effect=replace):
            provision.install(self.directory, self.target, self.contract)
        self.assertEqual((self.directory / "deploy.env").read_text(), self.contract)
        self.assertEqual((self.directory / "deploy.env").stat().st_mode & 0o777, 0o644)
        self.assertEqual(marker.read_text(), "preserve me")
        self.assertFalse(self.target.exists())

    def test_retry_after_failure_before_publication_is_safe(self):
        with patch.object(provision.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                provision.install(self.directory, self.target, self.contract)
        self.assertFalse((self.directory / "deploy.env").exists())
        self.assertEqual(list(self.directory.iterdir()), [self.directory / "profile.json"])
        provision.install(self.directory, self.target, self.contract)
        before = (self.directory / "deploy.env").stat().st_ino
        provision.install(self.directory, self.target, self.contract)
        self.assertEqual((self.directory / "deploy.env").stat().st_ino, before)

    def test_conflicting_contract_or_profile_is_not_overwritten(self):
        provision.install(self.directory, self.target, self.contract)
        with self.assertRaises(ValueError):
            provision.install(self.directory, self.target, "SH_DIR=/other\n")
        with self.assertRaises(ValueError):
            provision.install(self.directory, self.root / "other", self.contract)
        self.assertEqual((self.directory / "deploy.env").read_text(), self.contract)
        self.assertEqual(os.readlink(self.directory / "profile.json"), str(self.target))

    def test_writable_directory_or_contract_is_rejected(self):
        provision.install(self.directory, self.target, self.contract)
        self.directory.chmod(0o777)
        with self.assertRaises(ValueError):
            provision.install(self.directory, self.target, self.contract)
        self.directory.chmod(0o755)
        (self.directory / "deploy.env").chmod(0o666)
        with self.assertRaises(ValueError):
            provision.install(self.directory, self.target, self.contract)

    def test_symlinked_environment_is_not_followed(self):
        self.directory.mkdir(parents=True)
        outside = self.root / "outside"
        outside.write_text(self.contract)
        (self.directory / "deploy.env").symlink_to(outside)
        with self.assertRaises(ValueError):
            provision.install(self.directory, self.target, self.contract)
        self.assertFalse((self.directory / "profile.json").is_symlink())


if __name__ == "__main__":
    unittest.main()
