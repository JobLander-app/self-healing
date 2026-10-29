"""Linear labels are durable, exact-signature false-positive decisions."""
import json
import os
import re
import subprocess
import urllib.request


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
      nodes{id identifier title description priority labels{nodes{name}}}
      pageInfo{hasNextPage endCursor}}}'''
    rules, after, cursors = [], None, set()
    for _ in range(100):
        issues = request(query, {'team': os.environ['LINEAR_TEAM_ID'], 'after': after})['issues']
        for issue in issues['nodes']:
            labels = [label['name'] for label in issue['labels']['nodes']]
            if 'false-positive' not in labels or not ('monitor' in labels or issue['title'].startswith('[Monitor]')):
                continue
            signature = re.search(r'\*\*Signature:\*\*\s*`([^`\n]+)`', issue.get('description') or '')
            if signature and '*' not in signature[1] and issue.get('priority') in (2, 3, 4):
                rules.append({'signature': signature[1], 'priority': issue['priority'],
                              'issue_identifier': issue['identifier']})
        if not issues['pageInfo']['hasNextPage']:
            return rules
        after = issues['pageInfo']['endCursor']
        if not after or after in cursors:
            break
        cursors.add(after)
    raise RuntimeError('Incomplete Linear false-positive scan; filing deferred')


def matching(signature, severity, rules):
    # Changed signatures and worse severity reopen investigation. Never hide P0.
    priority = {'P0': 1, 'P1': 2, 'P2': 3, 'P3': 4}.get(severity)
    if priority is None or priority == 1:
        return None
    return next((r for r in rules if r['signature'] == signature and priority >= r['priority']), None)


def filter_groups(groups, rules):
    kept, suppressed = {}, []
    for signature, group in groups.items():
        rule = matching(signature, group.get('severity'), rules)
        if rule:
            suppressed.append({'signature': signature, 'issue': rule['issue_identifier']})
        else:
            kept[signature] = group
    return kept, suppressed
