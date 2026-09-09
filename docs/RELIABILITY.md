# Runtime reliability (JOB-947)

The watcher confirms delivery independently of incident detection. Crossing the
threshold creates a UUID and checkpoints an outbox before sending anything.
Confirmed page, Linear issue, ticket announcement and trigger actions are saved
separately. Failures retry after 1, 2, 4, then 5 minutes, without expiring a P0.
The cron flock prevents overlapping ticks. Recovery closes the incident and
cancels stale pages/ticket creation, while a failed recovery remains in the outbox
alongside any subsequent incident.

Telegram is **at least once**. An accepted send whose acknowledgement was lost
can be repeated; every message carries the same incident UUID. A successful send
is not repeated. Linear uses that UUID as `IssueCreateInput.id` and looks it up
before retrying an ambiguous create ([official schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)).
Dispatcher trigger receipts persist acceptance before the HTTP response, dedupe
completed keys for seven days, and resume pending wakeups after restart. A crash
between completing a run and committing its receipt is handled by the normal
Linear queue claim/state checks, not an exactly-once inference guarantee.

The watcher state retains the original `COUNT PAGED` first line and appends a
versioned JSON outbox. Legacy state is read without creating duplicate pages or
tickets; an already-paged legacy incident still receives recovery. Saves use
fsync plus atomic rename, and unreadable/corrupt existing state fails the tick
rather than erasing delivery history. Older watcher releases can read the first
line but do not maintain the outbox; preserve the state file before a manual
downgrade. `DRY_RUN=1` never saves production delivery state.

Only HTTP 200 with detector status `pass` is healthy. Missing, malformed, unknown
or non-string status does not recover an incident. `selfheal_watcher_pending_actions`
and `DELIVERY_FAILED` logs expose undelivered work; pages/recoveries metrics count
confirmed sends rather than attempts.

Change ingest separates liveness (`/live`, `/health`) from readiness (`/ready`,
`/healthz`). Readiness requires successful coverage from all three sources within
`SOURCE_STALE_MS` (15 minutes by default). Each source exposes last attempt,
last success, error, in-flight and stale state. Empty successful scans are valid;
failed credentials, HTTP/GraphQL errors, capped scans, and incomplete backfills
are unready. Partial audit backfills advance only their safe cursor and continue
on subsequent ticks. `/changes` returns 503 while coverage is incomplete/stale,
so it cannot silently represent an unavailable history as an empty history.

Deployment builds a detached snapshot before activation. A `.deploying` guard,
a second dispatcher busy check and watcher/monitor flocks quiesce writers.
Tracked local edits defer deployment. Source activation uses `git reset --keep`;
state, secrets and logs are excluded from runtime backups. Rollback restores the
exact previously running `dist`/`node_modules` artifacts (including watcher and
MCP), changed managed systemd/Prometheus/Grafana/Caddy files, and crontab. It never
rebuilds the rollback from a potentially unavailable package registry.

A root-only transaction manifest under `/var/lib/self-healing-deploy` precedes
live mutations. A killed deploy or reboot resumes rollback before fetching Git.
Failed rollback retains the backup and guard, logs/alerts, and retries on the
next timer tick. Health verification checks daemon liveness and payloads;
an upstream provider/source outage is an operational readiness failure rather
than grounds for reverting correct code. Host hardening converges through its
existing independent hourly timer after a successful release. Deployment
notifications use the repository's standalone Python helper and existing
Telegram credentials (environment or Secret Manager), without workspace scripts.

Verification: `npm test` in watcher, dispatcher and change-ingest;
`python3 -m unittest discover -s deploy/test -p 'test_*.py' -v`; and
`shellcheck deploy/bin/*.sh`. Failure tests use an isolated Git repository,
filesystem and fake host commands, including a killed activation; no live
notifications or production service mutations occur.
