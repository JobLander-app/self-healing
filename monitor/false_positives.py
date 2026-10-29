"""Linear labels are durable, exact-signature false-positive decisions."""
import json
import os
import re
import subprocess
import urllib.request
from datetime import datetime, timedelta, timezone


SHORT_PAUSE = timedelta(hours=24)
LONG_PAUSE = timedelta(days=30)
CONFIRMATIONS = 3


def parse_time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, AttributeError, TypeError):
        return None


def linear_request(query, variables):
    token = os.environ.get('LINEAR_API_KEY')
    if not token:
        result = subprocess.run(['gcloud', 'secrets', 'versions', 'access', 'latest',
                                 '--secret=' + os.environ.get('LINEAR_API_KEY_SECRET', 'linear-api-key'),
                                 '--project=' + os.environ['GCP_PROJECT']],
                                capture_output=True, text=True, timeout=20, check=True)
        token = result.stdout.strip()
    request = urllib.request.Request('https://api.linear.app/graphql',
                                    data=json.dumps({'query': query, 'variables': variables}).encode(),
                                    headers={'Authorization': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if result.get('errors') or not result.get('data'):
        raise RuntimeError('Could not read Linear false-positive decisions')
    return result['data']


def decisions(request=linear_request):
    query = '''query($team:ID!,$after:String){issues(first:100,after:$after,includeArchived:true,
      filter:{team:{id:{eq:$team}},labels:{name:{eq:"false-positive"}}}){
      nodes{id identifier title description priority createdAt canceledAt completedAt
        state{type} labels{nodes{name}}}
      pageInfo{hasNextPage endCursor}}}'''
    rules, after, cursors = [], None, set()
    for _ in range(100):
        issues = request(query, {'team': os.environ['LINEAR_TEAM_ID'], 'after': after})['issues']
        for issue in issues['nodes']:
            labels = [label['name'] for label in issue['labels']['nodes']]
            if 'false-positive' not in labels or not ('monitor' in labels or issue['title'].startswith('[Monitor]')):
                continue
            description = issue.get('description') or ''
            signature = re.search(r'\*\*Signature:\*\*\s*`([^`\n]+)`', description)
            if issue.get('state', {}).get('type') not in ('canceled', 'completed'):
                continue
            verdict = description.partition('<!-- self-healing:false-positive -->')[2]
            recorded = re.search(r'\*\*Verdict recorded at:\*\* `([^`\n]+)`', verdict)
            decided_at = parse_time(recorded[1] if recorded else issue.get('canceledAt') or issue.get('completedAt'))
            created_at = parse_time(issue.get('createdAt'))
            if (signature and '*' not in signature[1] and issue.get('priority') in (2, 3, 4)
                    and created_at and decided_at and created_at <= decided_at):
                rules.append({'signature': signature[1], 'priority': issue['priority'],
                              'issue_identifier': issue['identifier'], 'issue_id': issue['id'],
                              'created_at': created_at, 'decided_at': decided_at})
        if not issues['pageInfo']['hasNextPage']:
            return rules
        after = issues['pageInfo']['endCursor']
        if not after or after in cursors:
            break
        cursors.add(after)
    raise RuntimeError('Incomplete Linear false-positive scan; filing deferred')


def matching(signature, severity, rules, now=None):
    # Changed signatures and worse severity reopen investigation. Never hide P0.
    priority = {'P0': 1, 'P1': 2, 'P2': 3, 'P3': 4}.get(severity)
    if priority is None or priority == 1:
        return None
    now = now or datetime.now(timezone.utc)
    history = sorted((r for r in rules if r['signature'] == signature and priority >= r['priority']
                      and r['decided_at'] <= now), key=lambda r: (r['decided_at'], r['issue_id']))
    count, until, latest, seen = 0, None, None, set()
    for rule in history:
        if rule['issue_id'] in seen:
            continue
        seen.add(rule['issue_id'])
        # Only a new investigation filed after the prior pause can confirm again.
        # Duplicate/old tickets cannot extend a pause or exhaust the threshold.
        if until and rule['created_at'] < until:
            continue
        count = 1 if count == CONFIRMATIONS else count + 1
        until = rule['decided_at'] + (LONG_PAUSE if count == CONFIRMATIONS else SHORT_PAUSE)
        latest = rule
    if latest and now < until:
        return {**latest, 'confirmations': count, 'suppress_until': until}
    return None


def filter_groups(groups, rules, now=None):
    kept, suppressed = {}, []
    for signature, group in groups.items():
        rule = matching(signature, group.get('severity'), rules, now)
        if rule:
            suppressed.append({'signature': signature, 'issue': rule['issue_identifier'],
                               'confirmations': rule['confirmations'],
                               'suppress_until': rule['suppress_until'].isoformat()})
        else:
            kept[signature] = group
    return kept, suppressed
