import json
from pathlib import Path
import tempfile
import unittest
from profile import load_profile
from render import render

ROOT = Path(__file__).resolve().parents[1]


class ProfileTests(unittest.TestCase):
    def test_example_is_check_only_and_defaults_are_portable(self):
        example = ROOT/'consumers/example/profile.json'
        with self.assertRaisesRegex(ValueError, 'placeholders'):
            load_profile(example, environ={})
        _, env, tokens = load_profile(example, environ={}, allow_example=True)
        self.assertEqual(env['DRY_RUN'], 'true')
        self.assertEqual(env['AUTO_MERGE'], 'false')
        self.assertNotIn('PGDATABASE', env)
        self.assertNotIn('MONITOR_ADAPTER', env)
        self.assertEqual(tokens['__AGENT_USER__'], 'selfheal')

    def test_process_overrides_and_invalid_project_are_checked(self):
        example = ROOT/'consumers/example/profile.json'
        _, env, _ = load_profile(example, environ={'DRY_RUN': 'false'}, allow_example=True)
        self.assertEqual(env['DRY_RUN'], 'false')
        with self.assertRaisesRegex(ValueError, 'must match'):
            load_profile(example, environ={'GCP_PROJECT': 'different-project'}, allow_example=True)
        with self.assertRaisesRegex(ValueError, 'true or false'):
            load_profile(example, environ={'AUTO_MERGE': '1'}, allow_example=True)

    def test_rendered_dashboard_and_units_have_no_consumer_placeholders(self):
        with tempfile.TemporaryDirectory() as directory:
            for source in [ROOT/'deploy/grafana/dashboards/technical.json', ROOT/'deploy/systemd/claude-code-vm-job-dispatcher.service']:
                output = Path(directory)/source.name
                render(ROOT/'consumers/example/profile.json', source, output)
                text = output.read_text()
                self.assertNotIn('__LINEAR_TEAM_ID__', text)
                self.assertNotIn('__AGENT_', text)
                if output.suffix == '.json':
                    self.assertIn('00000000-0000-4000-8000-000000000001', text)
                    json.loads(text)
