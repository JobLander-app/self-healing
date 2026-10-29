# Monitor

The hourly runner holds one process lock, collects deterministic evidence, pages
urgent incidents, and gives only a prepared escalation batch to the shared
Claude/Codex/OpenCode provider runner. The monitor agent can deduplicate/file
issues and record delivery receipts; it cannot claim repair work or change code.

Cloud Run collection is limited to the consumer's services and regions. Sentry
and product adapters are optional. Logs retain observation time, counting window,
revision and redacted evidence. A seven-day Sentry count does not prove current
failure; the freshness gate checks last-seen time.

Before escalation the monitor reads all `false-positive` labeled tickets in its
Linear team, including archived ones. Exact canonical `**Signature:**` strings
at the same/lower severity are suppressed; P0 and severity increases remain
eligible. The same check prunes durable pending filings before an agent starts.
A failed/incomplete label scan defers filing, while urgent pages still run.
Removing the label re-enables detection. Stale and fixed incidents use separate,
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

```sh
python3 -m unittest discover -s monitor -p 'test_*.py'
PYTHONPATH=monitor python3 config/run.py --profile consumers/joblander/profile.json -- \
  python3 -m unittest discover -s consumers/joblander/test -p 'test_*.py'
```
