# Operations

The VM is a dedicated worker. Services bind to loopback; Caddy exposes only the
Grafana console with authentication. Use IAP for SSH. Maintain the application
allowlist, Linear workflow, secrets, model authorization, budgets and DNS.

`/health` is liveness; `/status` exposes provider readiness, queue precheck,
accounting, pending work and recent runs. A live daemon with exhausted providers
cannot repair an incident. A merged PR is not proof of deployment or recovery.
Monitor successful-cycle heartbeats require completed escalation and page
handling; watcher heartbeats only prove its tick completed.

Deployment polls reviewed `origin/main`, builds a detached snapshot, waits for
watcher/monitor/dispatcher activity to settle and activates transactionally.
Failures restore the previous exact artifacts/config. Never overwrite a dirty
runtime checkout or bypass the deployment lock. Changes to deploy/init/infra and
consumer authorization require human review. Use the supplied apply wrapper
from the selected Terraform root after reviewing the plan; it rejects stale
checkouts and destructive plans by default.

New installations receive a consumer profile link and `/etc/self-healing/deploy.env`.
An older VM without that deployment contract defers this release before replacing
runtime files. Use the [production consumer migration](../consumers/joblander/README.md)
when upgrading that installation. Do not run the full startup script on an active
worker as a configuration migration: it starts/restarts services.

Preserve the dispatcher `usage-ledger.jsonl`, provider state, false-positive
outbox, auth caches and monitor state across upgrades/reboots. The false-positive
file is only interrupted-write delivery state; Linear labels remain authoritative.
Inspect `false-positive-write-pending` and fix tracker access before resuming.
Do not delete a pending verdict just to silence an error. Decisions invalidated
by ticket signature/priority/team edits move to `false-positive-conflicts.json`
beside the outbox, with evidence and a reason. They apply no suppression and no
longer block unrelated work. Reconcile these records with the current ticket;
do not replay an obsolete snapshot. Preserve this conflict file in backups too.

Back up the persistent disk/state and the change feed using consistent SQLite
backups. Test restoration. Trace rotation must not truncate the accounting ledger;
its configured size cap suspends new model attempts until storage is maintained.
Token/cost fields can be unknown; OpenRouter/SDK estimates are not billing receipts.

Grafana shows local counters and recent tickets. Native GCP metrics come from
Cloud Logging heartbeats plus a minute publisher reading completed ledger rows.
It starts at the end of an existing ledger, then stores a byte cursor after
confirmed delivery and sends only bounded metadata. Historical totals remain local.
A lost acknowledgment may duplicate an event; use the ledger for accounting.
Investigation duration is explicitly not time to production recovery. Missing
metrics before the first event are normal; missing established heartbeats are not.

Emergency stop is an operator action: disable dispatch scheduling/services and
external reset automation together so the watchdog does not undo the stop. Keep
monitoring/alerts as appropriate. Do not use emergency-stop procedures for routine
repository edits or to steer a healthy production runner.
