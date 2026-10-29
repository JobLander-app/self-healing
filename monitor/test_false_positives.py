import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import false_positives as fp
import run_monitor as runner


class FalsePositiveTests(unittest.TestCase):
    def issue(self, signature='api:eu:noise', priority=3, labels=('monitor', 'false-positive')):
        return {'id': 'id', 'identifier': 'APP-1', 'title': '[Monitor] noise',
                'description': f'**Signature:** `{signature}`', 'priority': priority,
                'labels': {'nodes': [{'name': label} for label in labels]}}

    def page(self, nodes, more=False, cursor=None):
        return {'issues': {'nodes': nodes, 'pageInfo': {'hasNextPage': more, 'endCursor': cursor}}}

    def test_pagination_includes_archived_and_has_no_age_cutoff(self):
        request = Mock(side_effect=[self.page([], True, 'next'), self.page([self.issue()])])
        with patch.dict(os.environ, {'LINEAR_TEAM_ID': 'team'}):
            rules = fp.decisions(request)
        self.assertEqual(rules[0]['signature'], 'api:eu:noise')
        self.assertIn('includeArchived:true', request.call_args.args[0])
        self.assertNotIn('updatedAt', request.call_args.args[0])
        self.assertEqual(request.call_args.args[1], {'team': 'team', 'after': 'next'})

    def test_exact_signature_same_or_lower_severity_only(self):
        rule = {'signature': 'api:eu:noise', 'priority': 3, 'issue_identifier': 'APP-1'}
        self.assertEqual(fp.matching(rule['signature'], 'P2', [rule]), rule)
        self.assertEqual(fp.matching(rule['signature'], 'P3', [rule]), rule)
        for signature, severity in [('api:us:noise', 'P2'), (rule['signature'], 'P1'), (rule['signature'], 'P0'), (rule['signature'], None)]:
            self.assertIsNone(fp.matching(signature, severity, [rule]))
        groups, audit = fp.filter_groups({rule['signature']: {'severity': 'P2'}}, [rule])
        self.assertEqual(groups, {})
        self.assertEqual(audit[0]['issue'], 'APP-1')

    def test_removed_label_unknown_priority_and_wildcards_do_not_suppress(self):
        request = Mock(return_value=self.page([self.issue(labels=('monitor',)), self.issue(priority=0),
                                              self.issue(priority=1), self.issue(signature='api:*')]))
        with patch.dict(os.environ, {'LINEAR_TEAM_ID': 'team'}):
            self.assertEqual(fp.decisions(request), [])

    def test_partial_or_failed_scan_cannot_authorize_filing(self):
        with patch.dict(os.environ, {'LINEAR_TEAM_ID': 'team'}):
            for request in [Mock(return_value=self.page([], True, 'same')), Mock(side_effect=RuntimeError('offline'))]:
                with self.assertRaises(RuntimeError):
                    fp.decisions(request)

    def test_pending_filings_pruned_and_p0_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            config = runner.Config(Path(directory), ())
            runner.write_json(config.state_dir / 'linear-outbox.json', {
                'api:eu:noise': {'signature': 'api:eu:noise', 'severity': 'P2', 'action': 'linear_create_if_no_dup'}})
            summary = {'timestamp': runner.timestamp(), 'escalations': []}
            rule = {'signature': 'api:eu:noise', 'priority': 3, 'issue_identifier': 'APP-1'}
            with patch.object(runner, 'decisions', return_value=[rule]):
                self.assertEqual(runner.prepare_escalations(config, summary)['escalations'], [])
                summary['escalations'] = [{'signature': rule['signature'], 'severity': 'P0'}]
                self.assertEqual(len(runner.prepare_escalations(config, summary)['escalations']), 1)

    def test_label_outage_still_pages_before_deferring_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = runner.Config(root, (), metrics_file=root/'metrics.prom')
            def collect(_):
                runner.write_json(root/'triage-summary.json', {'timestamp': runner.timestamp(),
                    'triage_failed': False, 'p0_alerts': ['urgent'], 'escalations': []})
                return 0
            pager, session = Mock(), Mock()
            with patch.dict(os.environ, {'DRY_RUN': 'false'}), patch.object(runner, 'decisions', side_effect=RuntimeError('offline')), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.run_once(config, collector=collect, pager=pager,
                                                session_runner=session, publisher=lambda _: False), 1)
            pager.assert_called_once_with('urgent')
            session.assert_not_called()
