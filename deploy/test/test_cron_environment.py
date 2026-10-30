"""Scheduled launchers must find Cloud SDK installations supplied by the VM image."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CronEnvironmentTest(unittest.TestCase):
    def test_profile_launcher_finds_a_snap_only_cloud_sdk_in_the_shipped_cron_path(self):
        lines = (ROOT / "deploy/cron/self-healing.crontab").read_text().splitlines()
        configured = next(line.removeprefix("PATH=") for line in lines if line.startswith("PATH="))
        with tempfile.TemporaryDirectory() as folder:
            host = Path(folder)
            # Model the real Ubuntu host: gcloud exists only in /snap/bin.
            sdk = host / "snap/bin/gcloud"
            sdk.parent.mkdir(parents=True)
            sdk.write_text("#!/bin/sh\nprintf 'cloud-sdk-found\\n'\n")
            sdk.chmod(0o755)
            mapped = os.pathsep.join(str(host / entry.lstrip("/")) for entry in configured.split(":"))
            result = subprocess.run([
                sys.executable, str(ROOT / "config/run.py"), "--profile",
                str(ROOT / "consumers/joblander/profile.json"), "--", "gcloud", "version",
            ], env={"PATH": mapped}, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "cloud-sdk-found")


if __name__ == "__main__":
    unittest.main()
