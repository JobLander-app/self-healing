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
2. Persist prepared P0 pages to `p0-outbox.json`, deliver verbatim through Telegram,
   and remove only acknowledged deliveries. Failed deliveries retry next launch,
   even if the next collection fails. A crash after delivery can repeat a page;
   preserving delivery takes precedence over suppressing every duplicate.
3. Persist escalations in `linear-outbox.json` until a session completes. This
   retains a new P2 across a quota failure even when the next collection calls it
   recurring. Fresh cooldown decisions remove suppressed pending signals.
   If both current escalations and this backlog are empty, skip all model execution and OAuth resolution. Write
   a fresh successful session result; a quiet run is healthy.
4. Otherwise invoke `dispatcher/dist/providerCli.js` with the compact local prompt
   and prepared files in an isolated runtime directory. It uses the same verified
   provider configuration, MCP tools, fallback policy and usage journal as the
   executor. The monitor must never claim tickets or repair code.
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
