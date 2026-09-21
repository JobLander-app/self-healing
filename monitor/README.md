# Monitor and executor live in self-healing

`monitor/` owns deterministic collection, escalation lifecycle, and the monitor
prompt. `dispatcher/` owns execution and the shared Claude/Codex subscription
provider adapter. There is no separate monitor repository or runtime dependency
on the workspace launcher, manager prompt, `.mcp.json`, or git updates.

The existing hourly cron still invokes `monitor/run-monitor-session.sh`. Its
Python runner holds `/tmp/joblander-Monitor.lock`, the same lock as the retired
workspace launcher, throughout collection, state migration and escalation.
Deploy activation also waits for that lock. Do not add a second cron.

1. Collect and classify deterministically with `triage.py`.
   LiveKit uses Cloud since 2026-09-19; retired SFU VM HTTP and disk checks
   are removed. Voice-agent error, stage, timeout, avatar and latency collectors
   query the three regional Cloud Run worker pools, including JSON `level` errors
   when GCP severity is absent. LiveKit is reported as managed; this is not a
   synthetic end-to-end SFU health check. Pending HTTP/disk and VM log alerts for
   the four retired hosts are discarded; unrelated durable alerts remain pending.
   Sentry collection fetches unresolved issues and locally rejects explicit
   non-error categories, performance types and informational/warning levels before inference.
   Missing classification fields stay eligible; the real title replaces an absent
   exception type. The prepared evidence preserves the seven-day counting window.
   Cloud Run request logs without a message retain HTTP status, method, route,
   revision and trace evidence. Request signatures distinguish statuses and routes
   but stay stable across revisions; URL credentials, query and fragment are omitted.
   Real HTTP 5xx events still count toward the existing escalation thresholds.
2. Persist prepared P0 pages to `p0-outbox.json`, deliver verbatim through Telegram,
   and remove only acknowledged deliveries. Failed deliveries retry next launch,
   even if the next collection fails. A crash after delivery can repeat a page;
   preserving delivery takes precedence over suppressing every duplicate.
3. Persist escalations in `linear-outbox.json` until each signature has a recorded
   Linear issue or structured GitHub PR duplicate outcome. A success marker with
   empty or partial actions never clears the batch; acknowledge completed items
   individually and retain missing outcomes. This
   retains a new P2 across a quota failure even when the next collection calls it
   recurring. Fresh cooldown decisions remove suppressed pending signals.
   If both current escalations and this backlog are empty, skip all model execution and OAuth resolution. Write
   a fresh successful session result; a quiet run is healthy.
4. Otherwise invoke `dispatcher/dist/providerCli.js` with the compact local prompt
   and prepared files in an isolated runtime directory. It uses the same verified
   provider configuration, MCP tools, fallback policy and usage journal as the
   executor. The monitor must never claim tickets or repair code.
   The supported services and their six Linear projects are listed in
   `prompt.md`. An unmapped service remains pending with an explicit routing
   error; it cannot create a ticket in a guessed project.
5. Commit successful and partial actions to `latest-report.json`; record completion/failure in
   `last-session.json`. Publish a Cloud Logging heartbeat only after successful
   collection and completion of required actions, including P0 delivery.

State defaults to `/home/joblander/.local/state/self-healing/monitor`, outside
the checkout. `MONITOR_STATE_DIR` can override it. On the first launch, while the
shared lock is held, copy the old workspace `teams/logs/monitoring` directory
atomically into the new location. Existing reports, archives and `known-errors`
are preserved byte for byte; the old tree is retained. Deployment must perform
this migration under its monitor lock before starting the dispatcher, which can
write new suppressions. Do not pre-create the final state directory. Later launches never
overwrite the new state from that historical copy. Rolling back code requires
pointing the older launcher at the current `MONITOR_STATE_DIR` so newly recorded
actions and suppressions are not lost.
If the first deployment fails during activation, CD removes only the new state
target recorded as absent before that transaction. The resumed legacy launcher
keeps its old tree current, and a later retry copies those newer files. A state
directory that already existed before deployment is preserved during rollback.
Bootstrap uses `python3 monitor/run_monitor.py --migrate-only` before starting
the dispatcher. This command refuses a busy monitor lock and performs no
collection, credential resolution, delivery or inference.

Provider configuration comes from the self-healing dispatcher's rendered `.env`
and process environment. Monitor overrides `LOG_DIR` to
`/var/log/self-healing-monitor/turns` (`MONITOR_LOG_DIR`) to keep provider state and
the durable usage ledger separate from the concurrently running dispatcher.
Telegram uses `TG_BOT_TOKEN`/`TG_CHAT_ID` or the existing Secret Manager secret
`self-healing-workspace-env`; its historical name does not require a workspace
file. Never put credentials in the prompt, MCP configuration or logs.

`MONITOR_HEARTBEAT success` is written to log id `self-healing-monitor`. The
Terraform `monitor_dead_man` policy alerts on two hours without successful
completion, through the existing notification channels. It never resets the VM.
`last-session.json` also explains failed or quiet runs locally. Prometheus
`selfheal_monitor_*` textfile metrics include latest status and per-provider/model
actual token totals from the durable attempt ledger. Missing provider usage is
counted separately and never represented as zero tokens or a fabricated bill.

Validation: `python3 -m unittest discover -s monitor -p 'test_*.py' -v`.
Unit tests inject collection, delivery and provider execution; they never contact
production or start an inference session.

## Infrastructure lifecycle

`targets.json` is the reviewed monitoring contract: expected regional worker
pools, the LiveKit Cloud endpoint used by the app, and explicit retired resource
scopes with effective dates and evidence. Update this contract in the same
migration rollout, before removing old resources. Add and verify replacements
before retiring their predecessors. Never derive expected coverage from the
set of currently running VMs or from whichever resources emitted recent logs.

Every collection checks the expected worker deployments and the app's actual
LIVEKIT_URL. It records a policy revision and each observation in the report.
Missing permissions, missing resources and failed lookups remain UNKNOWN;
deployment disagreement is DRIFT/NOT_READY. These generate a P2 monitoring
configuration investigation, never a synthetic HTTP 0 P0. Actual production
error spikes retain their existing P0/P1 thresholds. Cloud control-plane Ready
and an endpoint match do not claim successful end-to-end voice calls.

Explicit retirements also filter both durable outboxes, including delivery
retries after collection failure. Before removal, the original item, reason,
evidence and policy revision are saved in `retired-outbox.json`. Unknown scopes
and replacement hosts remain eligible. Invalid policy fails before any removal
or delivery; pending work is preserved. CI rejects empty voice coverage,
active/retired overlap, ambiguous retirement prefixes and future retirements.
Python code does not need edits to retire another resource or change a pool.
