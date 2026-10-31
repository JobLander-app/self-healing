# Monitor

Production errors can wake the monitor through an authenticated webhook. The
hourly cron remains an independent fallback; both invoke `run-monitor-session.sh`,
hold the same process lock, read the same sources and apply the same severity,
false-positive and ticket-deduplication policy. A notification is only a hint to
collect evidence, never an instruction to the agent. Confirmed urgent P0 pages
and the loop's own dead-man alerts remain enabled. Successful urgent pages have
one-hour delivery receipts per signature/severity, so frequent event runs do not
multiply reminders; a new signature or higher severity pages immediately. Failed
deliveries stay in the outbox. These receipts never suppress investigations.

The GCP path is a Cloud Logging sink → Pub/Sub → HTTPS `/monitor/alerts` → the
monitor. Pub/Sub signs an OIDC token; the receiver verifies its signature, expiry,
exact audience and verified service-account email, and checks the subscription
and source project. No shared webhook password is stored in Terraform. Streaming avoids the 20
notifications/day limit of a log-based alert policy. Pub/Sub traffic is metered;
the queue coalesces collections, not incoming message delivery. Only this
route is exposed through Caddy; the dispatcher API stays on loopback.

The receiver persists a coalesced wake-up before returning 204. Pub/Sub retries
failed deliveries for up to 24 hours. The local queue survives service restarts;
duplicates and bursts do not start concurrent runs. First collection starts after
10 seconds for log ingestion, with a second collection five minutes after success
to catch growing bursts. Subsequent events are coalesced at five-minute intervals.
An event run colliding with cron retries after 30 seconds; other failures retry after five
minutes. An event arriving during a run remains queued. Deployment guards defer
starts. No webhook body is forwarded to the model or used to construct a command.
Scheduled runs wait up to 55 minutes for the lock, then fail explicitly if it is
still held. Event cooldowns leave space for that waiting fallback to run and
publish its own heartbeat.

`last-event-session.json`, `last-cron-session.json`, and `webhook-queue.json` expose
the two paths separately. `GET http://127.0.0.1:4100/monitor/status` shows queue
health without message contents. Event runs publish `MONITOR_EVENT success`;
only scheduled successes publish `MONITOR_HEARTBEAT success`, so busy incoming
traffic cannot hide a stopped cron. The existing two-hour collection lookback
covers a missed hourly tick; outages longer than that require manual investigation
of the uncovered interval. Sentry and consumer-only probes remain hourly unless
another source publishes a wake-up.

Configure ingress for another consumer:

1. Generate the trigger scope from the collector's targets:
   `python3 monitor/trigger_config.py consumers/<name>/targets.json consumers/<name>/monitor-trigger.json`.
   Thresholds and suppressions stay in the monitor, not in GCP alert rules.
2. Instantiate `infra/terraform/modules/self-healing-monitor-ingress` with the
   project ID/number, HTTPS endpoint and generated `trigger_config`. Enable the
   Pub/Sub and Monitoring APIs first. The applying identity needs permission to
   attach the dedicated push service account to its subscription.
3. Set `MONITOR_WEBHOOK_AUDIENCE`, `MONITOR_WEBHOOK_EMAIL` and
   `MONITOR_WEBHOOK_SUBSCRIPTION` in the consumer profile to the exact endpoint,
   module `push_identity` and `subscription` outputs. Deploy the reviewed release.
4. Prove rejected unauthenticated requests and a successful authenticated wake-up
   before removing covered services from any existing raw error paging policy.
   Preserve coverage for services outside this monitor's targets.

An integration can publish `{"kind":"monitor-wakeup","project":"<project>"}`
to the module's topic using an identity with `pubsub.publisher` on that topic.
This starts a real collection; it does not manufacture an error or bypass rules.

The runner holds one process lock, collects deterministic evidence, pages
urgent incidents, and gives only a prepared escalation batch to the shared
Claude/Codex/OpenCode provider runner. The monitor agent can deduplicate/file
issues and record delivery receipts; it cannot claim repair work or change code.

Cloud Run collection is limited to the consumer's services and regions. Sentry
and product adapters are optional. Logs retain observation time, counting window,
revision and redacted evidence. A seven-day Sentry count does not prove current
failure; the freshness gate checks last-seen time.

Before escalation the monitor reads all `false-positive` labeled tickets in its
Linear team, including archived ones. Exact canonical `**Signature:**` strings
at the same/lower severity are suppressed for 24 hours after each of the first
two confirmed verdicts and 30 days after the third. Count independent investigations,
not events: a ticket must have been created after the previous pause ended.
Duplicate/old tickets cannot advance the count or extend the pause. After the
30-day window, the next verdict starts a new cycle. Closed labeled tickets use
the host's stable decision time (legacy tickets use their terminal timestamp).
Reopened or undated tickets do not authorize suppression. P0 and severity increases
remain eligible. The same check prunes durable pending filings before an agent starts.
Suppression runs after growth-based severity escalation. Reports retain suppressed
observations (marked with `suppressed`) so worsening signals are still detected;
they do not degrade service health or create actions while suppression applies.
When a pause expires, a stable P2 signal is eligible for investigation again.
A failed/incomplete label scan defers filing, while urgent pages still run.
Removing a label withdraws that verdict; remove all matching labels to reset. Stale and fixed incidents use separate,
short cooldowns; they are not permanent false positives.

Existing `known-errors.json` files are read for migration compatibility. New
verdicts belong on Linear tickets, not new wildcard file rules. Reviewed retired
targets also remove obsolete queued pages/filings, with an audit record.

Cloud Run/Sentry recurrence after a tracked deployed fix can bypass the Done
cooldown. The monitor requires deployment/revision evidence: an old revision
still logging errors is not evidence the fix failed. Other origins receive a
later dispatcher verification run.

State lives in `MONITOR_STATE_DIR`: reports, Linear/page outboxes and delivery
receipts. The runner writes atomic files, preserves failures across restarts and
emits a successful heartbeat only when the cycle finishes. Back up this directory
and the dispatcher's ledger/outboxes. Run through `config/run.py`; do not install
a second independent hourly scheduler.

Dry-run reports and metrics live under `MONITOR_STATE_DIR/dry-run/`. Preview cycles
do not alter live baselines/outboxes or publish production heartbeats. Switching
to live mode therefore evaluates fresh observations against the last live baseline,
not against preview activity. Inspect the preview's `triage-summary.json` and
`last-session.json` before enabling writes.

```sh
python3 -m unittest discover -s monitor -p 'test_*.py'
PYTHONPATH=monitor python3 config/run.py --profile consumers/joblander/profile.json -- \
  python3 -m unittest discover -s consumers/joblander/test -p 'test_*.py'
```
