import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import false_positives as fp
import run_monitor as runner
import triage


class FalsePositiveTests(unittest.TestCase):
    now = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)

    def rule(self, day=0, identifier='APP-1', priority=3, created=None):
        return {'signature': 'api:eu:noise', 'priority': priority, 'issue_identifier': identifier,
                'issue_id': identifier, 'decided_at': self.now + timedelta(days=day),
                'created_at': self.now + timedelta(days=day if created is None else created)}

    def issue(self, signature='api:eu:noise', priority=3, labels=('monitor', 'false-positive')):
        return {'id': 'id', 'identifier': 'APP-1', 'title': '[Monitor] noise',
                'description': f'**Signature:** `{signature}`', 'priority': priority,
                'labels': {'nodes': [{'name': label} for label in labels]},
                'createdAt': self.now.isoformat(), 'canceledAt': self.now.isoformat(),
                'state': {'type': 'canceled'}}

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
        rule = self.rule()
        self.assertEqual(fp.matching(rule['signature'], 'P2', [rule], self.now)['confirmations'], 1)
        self.assertEqual(fp.matching(rule['signature'], 'P3', [rule], self.now)['confirmations'], 1)
        for signature, severity in [('api:us:noise', 'P2'), (rule['signature'], 'P1'), (rule['signature'], 'P0'), (rule['signature'], None)]:
            self.assertIsNone(fp.matching(signature, severity, [rule], self.now))
        groups, audit = fp.filter_groups({rule['signature']: {'severity': 'P2'}}, [rule], self.now)
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

    def test_first_two_verdicts_pause_24h_third_pauses_30d(self):
        history = [self.rule(), self.rule(1, 'APP-2'), self.rule(2, 'APP-3')]
        for index, days in enumerate((1, 1, 30)):
            at = self.now + timedelta(days=index)
            active = fp.matching('api:eu:noise', 'P2', history[:index+1], at)
            self.assertEqual(active['confirmations'], index + 1)
            self.assertEqual(active['suppress_until'], at + timedelta(days=days))
            self.assertIsNone(fp.matching('api:eu:noise', 'P2', history[:index+1], at + timedelta(days=days)))

    def test_duplicate_tickets_and_repeated_records_never_extend_pause(self):
        history = [self.rule(), self.rule(0.1, 'APP-2'), self.rule(0.2, 'APP-3'), self.rule()]
        active = fp.matching('api:eu:noise', 'P2', history, self.now + timedelta(hours=23))
        self.assertEqual(active['confirmations'], 1)
        self.assertEqual(active['suppress_until'], self.now + timedelta(days=1))
        self.assertIsNone(fp.matching('api:eu:noise', 'P2', history, self.now + timedelta(days=1)))

    def test_old_ticket_closed_after_pause_does_not_count_as_new_investigation(self):
        history = [self.rule(), self.rule(2, 'APP-2', created=0.5)]
        self.assertIsNone(fp.matching('api:eu:noise', 'P2', history, self.now + timedelta(days=2)))

    def test_after_30_days_a_new_cycle_starts_with_one_confirmation(self):
        history = [self.rule(), self.rule(1, 'APP-2'), self.rule(2, 'APP-3'), self.rule(32, 'APP-4')]
        active = fp.matching('api:eu:noise', 'P2', list(reversed(history)), self.now + timedelta(days=32))
        self.assertEqual(active['confirmations'], 1)
        self.assertEqual(active['suppress_until'], self.now + timedelta(days=33))

    def test_future_verdicts_and_lower_severity_history_do_not_count(self):
        history = [self.rule(priority=4), self.rule(1, 'APP-2')]
        self.assertIsNone(fp.matching('api:eu:noise', 'P2', history, self.now))

    def test_stable_host_timestamp_prevents_lost_response_retry_extending_pause(self):
        issue = self.issue()
        issue['canceledAt'] = (self.now + timedelta(days=10)).isoformat()
        issue['description'] += ('\n<!-- self-healing:false-positive -->\n'
                                 f'**Verdict recorded at:** `{self.now.isoformat()}`')
        with patch.dict(os.environ, {'LINEAR_TEAM_ID': 'team'}):
            rules = fp.decisions(Mock(return_value=self.page([issue])))
        self.assertEqual(rules[0]['decided_at'], self.now)
        self.assertIsNone(fp.matching('api:eu:noise', 'P2', rules, self.now + timedelta(days=10)))

    def test_reopened_or_undated_or_invalid_decisions_do_not_suppress(self):
        issues = [self.issue() for _ in range(5)]
        issues[0]['state'] = {'type': 'started'}
        issues[1]['canceledAt'] = None
        issues[2]['createdAt'] = 'not a date'
        issues[3]['canceledAt'] = '2026-10-29T12:00:00'  # No timezone.
        issues[4]['description'] += '\n<!-- self-healing:false-positive -->\n**Verdict recorded at:** `invalid`'
        with patch.dict(os.environ, {'LINEAR_TEAM_ID': 'team'}):
            self.assertEqual(fp.decisions(Mock(return_value=self.page(issues))), [])

    def test_pending_filings_pruned_and_p0_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            config = runner.Config(Path(directory), ())
            runner.write_json(config.state_dir / 'linear-outbox.json', {
                'api:eu:noise': {'signature': 'api:eu:noise', 'severity': 'P2', 'action': 'linear_create_if_no_dup'}})
            summary = {'timestamp': runner.timestamp(), 'escalations': []}
            rule = self.rule()
            rule['decided_at'] = rule['created_at'] = datetime.now(timezone.utc)
            with patch.object(runner, 'decisions', return_value=[rule]):
                self.assertEqual(runner.prepare_escalations(config, summary)['escalations'], [])
                summary['escalations'] = [{'signature': rule['signature'], 'severity': 'P0'}]
                self.assertEqual(len(runner.prepare_escalations(config, summary)['escalations']), 1)

    def test_false_positive_closure_does_not_restart_legacy_cooldown(self):
        response = {'data': self.page([self.issue()])}
        with patch.object(triage, 'run_cmd', return_value='test-token'), \
                patch.object(triage.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())):
            self.assertEqual(triage.collect_closed_signature_cooldowns(), {})

    def test_expired_pause_allows_fresh_escalation(self):
        with tempfile.TemporaryDirectory() as directory:
            config = runner.Config(Path(directory), ())
            rule = self.rule()
            rule['decided_at'] = rule['created_at'] = datetime.now(timezone.utc) - timedelta(hours=25)
            summary = {'timestamp': runner.timestamp(), 'escalations': [
                {'signature': rule['signature'], 'severity': 'P2', 'action': 'linear_create_if_no_dup'}]}
            with patch.object(runner, 'decisions', return_value=[rule]):
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

    def collect_tick(self, directory, count, rules):
        group = {'signature': 'api:eu:noise', 'service': 'api', 'region': 'eu', 'count': count,
                 'first_seen': runner.timestamp(), 'last_seen': runner.timestamp(), 'sample_message': 'noise'}
        with contextlib.ExitStack() as stack:
            for name, value in [('STATE_DIR', directory), ('ADAPTER', None), ('collection_errors', []),
                                ('TARGETS', {'services': ['api']})]:
                stack.enter_context(patch.object(triage, name, value))
            stack.enter_context(patch.object(triage, 'inspect_targets', return_value=[]))
            stack.enter_context(patch.object(triage, 'collect_cloud_run', side_effect=lambda groups: groups.update({group['signature']: group})))
            stack.enter_context(patch.object(triage, 'collect_cloud_functions'))
            stack.enter_context(patch.object(triage, 'collect_sentry'))
            stack.enter_context(patch.object(triage, 'decisions', return_value=rules))
            stack.enter_context(patch.object(triage, 'collect_closed_signature_cooldowns', return_value={}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            triage.main()
        return (json.loads((Path(directory) / 'triage-summary.json').read_text()),
                json.loads((Path(directory) / 'latest-report.json').read_text()))

    def test_suppressed_observations_still_detect_growth_to_p0(self):
        with tempfile.TemporaryDirectory() as directory:
            rule = self.rule(priority=2)
            rule['decided_at'] = rule['created_at'] = datetime.now(timezone.utc)
            summary, report = self.collect_tick(directory, 150, [rule])
            self.assertEqual(summary['escalations'], [])
            self.assertEqual(report['error_groups'][0]['count'], 150)
            self.assertEqual(report['error_groups'][0]['suppressed'], 'false-positive')
            self.assertEqual(report['services']['api']['status'], 'HEALTHY')
            summary, report = self.collect_tick(directory, 400, [rule])
            self.assertEqual(len(summary['p0_alerts']), 1)
            self.assertEqual(summary['escalations'][0]['severity'], 'P0')
            self.assertEqual(report['error_groups'][0]['diff_status'], 'worsened')
            self.assertIsNone(report['error_groups'][0]['suppressed'])
            self.assertEqual(report['services']['api']['status'], 'DEGRADED')

    def test_stable_p2_is_reinvestigated_when_pause_expires(self):
        with tempfile.TemporaryDirectory() as directory:
            rule = self.rule()
            rule['decided_at'] = rule['created_at'] = datetime.now(timezone.utc)
            summary, _ = self.collect_tick(directory, 10, [rule])
            self.assertEqual(summary['escalations'], [])
            rule['decided_at'] = rule['created_at'] = datetime.now(timezone.utc) - timedelta(hours=25)
            summary, _ = self.collect_tick(directory, 10, [rule])
            self.assertEqual(summary['escalations'][0]['action'], 'linear_create_if_no_dup')

    def test_legacy_known_error_rules_also_cannot_hide_growth_to_p0(self):
        with tempfile.TemporaryDirectory() as directory:
            runner.write_json(Path(directory) / 'known-errors.json', {'patterns': [{'signature_match': 'api:*'}]})
            summary, _ = self.collect_tick(directory, 150, [])
            self.assertEqual(summary['escalations'], [])
            summary, _ = self.collect_tick(directory, 400, [])
            self.assertEqual(len(summary['p0_alerts']), 1)
