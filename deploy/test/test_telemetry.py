import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).resolve().parents[1]/'bin/publish-events.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class TelemetryTests(unittest.TestCase):
    def test_failed_delivery_does_not_advance_cursor_and_private_text_never_leaves(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger, cursor = root/'ledger', root/'cursor'
            data = {'kind': 'run', 'data': {'turnId': 'run', 'outcome': 'not-a-bug', 'durationSec': 30,
                    'dryRun': False, 'finishedAt': '2026-10-29T12:00:00Z', 'summary': 'private evidence'}}
            ledger.write_text(json.dumps(data)+'\n')
            publisher.deliver(ledger, cursor, lambda _: self.fail('historical run must not be backfilled'))
            self.assertEqual(json.loads(cursor.read_text())['offset'], ledger.stat().st_size)
            cursor.write_text('{"offset":0}')
            def fail(_):
                raise RuntimeError('offline')
            with self.assertRaises(RuntimeError):
                publisher.deliver(ledger, cursor, fail)
            self.assertEqual(json.loads(cursor.read_text())["offset"], 0)
            delivered = []
            publisher.deliver(ledger, cursor, delivered.append)
            publisher.deliver(ledger, cursor, delivered.append)
            self.assertEqual(len(delivered), 1)
            self.assertNotIn('summary', delivered[0])
            self.assertEqual(delivered[0]['event'], 'run.finished')
            ledger.write_text('')
            with self.assertRaisesRegex(RuntimeError, 'shrank'):
                publisher.deliver(ledger, cursor, delivered.append)
