"""Run actual CD against isolated Git + fake host commands; never touch a VM."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin/self-healing-deploy.sh'


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='shl-deploy-test-')
        self.root = Path(self.tmp.name)
        self.host = self.root / 'host'
        self.repo = self.root / 'checkout'
        self.origin = self.root / 'origin.git'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.repo.mkdir()
        self.run_cmd('git', 'init', '-q', '--bare', str(self.origin))
        self.run_cmd('git', 'init', '-q', '-b', 'main', str(self.repo))
        self.git('config', 'user.name', 'Deploy Test')
        self.git('config', 'user.email', 'deploy-test@example.invalid')
        self.git('remote', 'add', 'origin', str(self.origin))
        self.write(self.repo / '.gitignore', 'node_modules/\ndist/\n.deploying\n')
        for component in ['dispatcher', 'watcher', 'change-ingest', 'mcp/linear']:
            self.write(self.repo / component / 'package.json', '{"name":"test"}\n')
            self.write(self.repo / component / 'source', 'old-source\n')
        for file in ['claude-code-vm-job-dispatcher.service', 'removed.service']:
            self.write(self.repo / 'deploy/systemd' / file, 'old-unit\n')
        self.write(self.repo / 'deploy/cron/self-healing.crontab', 'old-cron\n')
        self.write(self.repo / 'deploy/grafana/dashboards/technical.json', '{"version":"tracked-old"}\n')
        self.write(self.host / 'etc/grafana/dashboards/technical.json', '{"version":"stale-installed"}\n')
        self.write(self.repo / 'version', 'old\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'old source')
        self.old = self.git('rev-parse', 'HEAD').strip()
        # Actual working artifacts deliberately differ from source-derived builds.
        for component in ['dispatcher', 'watcher', 'change-ingest', 'mcp/linear']:
            for artifact in ['node_modules', 'dist'] if not component.startswith('mcp/') else ['node_modules']:
                self.write(self.repo / component / artifact / 'artifact', 'old-live-build\n')
        for file in ['claude-code-vm-job-dispatcher.service', 'removed.service']:
            self.write(self.host / 'etc/systemd/system' / file, 'old-installed-unit\n')
        self.cron = self.root / 'crontab'
        self.write(self.cron, 'old-installed-cron\n')
        for component in ['dispatcher', 'watcher', 'change-ingest', 'mcp/linear']:
            self.write(self.repo / component / 'source', 'new-source\n')
        self.write(self.repo / 'deploy/systemd/claude-code-vm-job-dispatcher.service', 'new-unit\n')
        self.write(self.repo / 'deploy/systemd/new.service', 'new-added-unit\n')
        (self.repo / 'deploy/systemd/removed.service').unlink()
        self.write(self.repo / 'deploy/cron/self-healing.crontab', 'new-cron\n')
        self.write(self.repo / 'version', 'new\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'new source')
        self.new = self.git('rev-parse', 'HEAD').strip()
        self.git('push', '-q', 'origin', 'main')
        self.git('reset', '-q', '--keep', self.old)
        self.mock('sudo', '#!/bin/sh\nshift 2\nexec "$@"\n')
        self.mock('chown', '#!/bin/sh\nexit 0\n')
        self.mock('npm', '''#!/bin/sh
[ "${FAIL_BUILD:-}" != 1 ] || exit 1
mkdir -p node_modules
printf 'new-build\\n' > node_modules/artifact
if [ "$1" = run ]; then mkdir -p dist; printf 'new-build\\n' > dist/artifact; fi
''')
        self.mock('systemctl', '''#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_SYSTEMCTL"
case "$*" in
  restart*) if [ "${KILL_ACTIVATION:-}" = 1 ] && [ "$(cat "$SH_DIR/version")" = new ]; then kill -KILL "$PPID"; fi ;;
esac
exit 0
''')
        self.mock('curl', '''#!/bin/sh
case "$*" in
  *status*) printf '{"busy":%s}' "${MOCK_BUSY:-false}" ;;
  *4200*) printf '{"ok":false,"rowCount":4}' ;;
  *) if [ "${FAIL_VERIFY:-}" = 1 ] && [ "$(cat "$SH_DIR/version")" = new ]; then exit 1; fi
     printf '{"status":"ok"}' ;;
esac
''')
        self.mock('crontab', '''#!/bin/sh
shift 2
case "$1" in
  -l) cat "$MOCK_CRON" ;;
  -r) rm "$MOCK_CRON" ;;
  *) cp "$1" "$MOCK_CRON" ;;
esac
''')
        # Linux flock is used in CI. macOS local run can use the Homebrew binary.
        flock = shutil.which('flock')
        if not flock:
            # macOS has the same flock(2) primitive but no util-linux CLI.
            # Reproduce only the exact descriptor-lock operation used by CD.
            self.mock('flock', "#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n")
        self.env = {**os.environ, 'PATH': str(self.bin) + os.pathsep + os.environ['PATH'],
                    'SH_DIR': str(self.repo), 'AGENT_USER': os.environ.get('USER', 'runner'),
                    'DEPLOY_SYSTEM_ROOT': str(self.host), 'DEPLOY_LOG': str(self.root / 'deploy.log'),
                    'DEPLOY_NOTIFY_SCRIPT': '/nonexistent/notify', 'DEPLOY_LOCK_FILE': str(self.root / 'deploy.lock'),
                    'DEPLOY_WATCH_LOCK': str(self.root / 'watch.lock'), 'DEPLOY_MONITOR_LOCK': str(self.root / 'monitor.lock'),
                    'DEPLOY_TMP_DIR': str(self.root), 'DEPLOY_TRANSACTION_FILE': str(self.root / 'registry/transaction.env'), 'DEPLOY_VERIFY_SLEEP': '0',
                    'MOCK_SYSTEMCTL': str(self.root / 'systemctl.log'), 'MOCK_CRON': str(self.cron)}

    @staticmethod
    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def mock(self, name, script):
        self.write(self.bin / name, script)
        (self.bin / name).chmod(0o755)

    def run_cmd(self, *cmd):
        return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)

    def git(self, *args):
        return self.run_cmd('git', '-C', str(self.repo), *args)

    def deploy(self, **env):
        result = subprocess.run(['bash', str(SCRIPT)], env={**self.env, **env}, text=True, capture_output=True)
        return result

    def assert_rollback(self, result):
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.old)
        for component in ['dispatcher', 'watcher', 'change-ingest', 'mcp/linear']:
            self.assertEqual((self.repo / component / 'node_modules/artifact').read_text(), 'old-live-build\n')
            if not component.startswith('mcp/'):
                self.assertEqual((self.repo / component / 'dist/artifact').read_text(), 'old-live-build\n')
        self.assertEqual((self.host / 'etc/systemd/system/claude-code-vm-job-dispatcher.service').read_text(), 'old-installed-unit\n')
        self.assertEqual((self.host / 'etc/systemd/system/removed.service').read_text(), 'old-installed-unit\n')
        self.assertFalse((self.host / 'etc/systemd/system/new.service').exists())
        self.assertEqual(self.cron.read_text(), 'old-installed-cron\n')
        self.assertEqual((self.host / 'etc/grafana/dashboards/technical.json').read_text(), '{"version":"stale-installed"}\n')
        self.assertFalse((self.repo / '.deploying').exists())

    def test_build_failure_leaves_working_runtime_untouched(self):
        self.assert_rollback(self.deploy(FAIL_BUILD='1'))
        self.assertFalse((self.root / 'systemctl.log').exists())

    def test_failed_activation_restores_every_runtime_config_and_cron(self):
        result = self.deploy(FAIL_VERIFY='1')
        self.assert_rollback(result)
        self.assertIn('ROLLBACK', (self.root / 'deploy.log').read_text())

    def test_legacy_reset_before_reexec_is_reverted_on_staging_failure(self):
        self.git('reset', '-q', '--keep', self.new)  # old CD behavior
        self.assert_rollback(self.deploy(FAIL_BUILD='1', SELF_HEALING_CD_FORCE_FROM=self.old))

    def test_interrupted_activation_recovers_exact_backup_before_any_fetch(self):
        result = self.deploy(KILL_ACTIVATION='1')
        self.assertLess(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'registry/transaction.env').exists())
        self.assertTrue((self.repo / '.deploying').exists())
        # Recovery is independent of network availability or current origin.
        self.git('remote', 'set-url', 'origin', '/nonexistent/offline.git')
        self.assert_rollback(self.deploy())
        self.assertFalse((self.root / 'registry/transaction.env').exists())

    def test_success_installs_built_artifacts_and_changed_config(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.new)
        self.assertEqual((self.repo / 'watcher/dist/artifact').read_text(), 'new-build\n')
        self.assertEqual((self.repo / 'mcp/linear/node_modules/artifact').read_text(), 'new-build\n')
        self.assertEqual(self.cron.read_text(), 'new-cron\n')
        self.assertEqual((self.host / 'etc/grafana/dashboards/technical.json').read_text(), '{"version":"tracked-old"}\n')
        self.assertFalse((self.host / 'etc/systemd/system/removed.service').exists())
        self.assertFalse((self.repo / '.deploying').exists())

    def test_busy_unknown_and_dirty_checkout_defer_without_restarting(self):
        for value in ['true', 'null', '"false"']:
            result = self.deploy(MOCK_BUSY=value)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.old)
        self.write(self.repo / 'watcher/source', 'uncommitted owner work\n')
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.repo / 'watcher/source').read_text(), 'uncommitted owner work\n')
        self.assertFalse((self.root / 'systemctl.log').exists())

    def tearDown(self):
        self.tmp.cleanup()


if __name__ == '__main__':
    unittest.main()
