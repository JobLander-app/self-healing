"""Notification transport contract, with no live Telegram/Secret Manager calls."""
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('shl_notify', Path(__file__).resolve().parents[1] / 'bin/self-healing-notify.py')
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class NotifyTest(unittest.TestCase):
    def test_existing_credentials_avoid_secret_lookup(self):
        with patch.dict(os.environ, {'TG_BOT_TOKEN': 'test-token', 'TG_CHAT_ID': '42'}, clear=True), patch.object(notify.subprocess, 'run') as run:
            self.assertEqual(notify.credentials(), ('test-token', '42'))
            run.assert_not_called()

    def test_secret_env_is_parsed_without_shell_execution_and_only_needed_fields(self):
        data = 'OTHER=$(do-not-execute)\nexport TG_BOT_TOKEN="test-token"\nTG_CHAT_ID=\'42\'\n'
        with patch.dict(os.environ, {'TG_BOT_TOKEN': ''}, clear=True), patch.object(notify.subprocess, 'run', return_value=SimpleNamespace(stdout=data)) as run:
            self.assertEqual(notify.credentials(), ('test-token', '42'))
            self.assertIn('--secret=self-healing-workspace-env', run.call_args.args[0])
            self.assertFalse(run.call_args.kwargs.get('shell', False))

    def test_plain_text_delivery_requires_confirmed_message_id(self):
        for body, succeeds in [({'ok': True, 'result': {'message_id': 123}}, True), ({'ok': False}, False), ({'ok': True, 'result': {}}, False)]:
            with patch.object(notify, 'credentials', return_value=('test-token', '42')), patch.object(notify.sys, 'argv', ['notify.py', 'safe_[plain text]']), patch.object(notify.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(body).encode())) as send:
                if succeeds:
                    notify.main()
                else:
                    with self.assertRaises(ValueError):
                        notify.main()
                self.assertEqual(json.loads(send.call_args.args[0].data), {'chat_id': '42', 'text': 'safe_[plain text]'})
