# Subscription fallback and readiness (JOB-947)

Claude remains the primary dispatcher provider. A quota, authentication or
service-availability failure permits one Codex CLI attempt inside the same
`MAX_RUN_MS` budget. Arbitrary task failures, exhausted turn budgets and
watchdog timeouts do not trigger a second investigation. Both providers receive
the same constitution, selected-ticket instructions and vendored Firebase,
Sentry and Linear MCP servers. Codex uses a new session; no cross-provider
conversation resume is claimed.

If Claude invoked no tools, Codex can safely start the selected ticket. If a
claim mutation was observed, the handover names that ticket and requires live
claim/comments/working-tree/PR verification before further writes. An ambiguous
interrupted session is left for the existing stale-claim recovery path, rather
than guessing which actions succeeded. Tool arguments and raw tool results are
excluded from dispatcher traces. Error messages redact known secret values.

## VM setup

The checked-in init script installs `@openai/codex@0.153.4`, the version tested
on `self-healing-1`, and the global `yeet` skill under
`/home/joblander/.agents/skills/yeet`. New installations receive
`deploy/codex/config.toml`; existing auth/config files are preserved. The runner
uses `--ephemeral` so new raw Codex sessions are not saved. The template disables
CLI prompt history (`history.persistence="none"`); apply that setting to an
existing dedicated home as well. Retain the compact usage ledger described below.
Any old smoke sessions/history can be archived under your existing retention
policy; do not remove authentication or provider/accounting state.

Set these values in the dispatcher environment secret after login verification:

```dotenv
CODEX_ENABLED=true
CODEX_BIN=/usr/bin/codex
CODEX_HOME=/home/joblander/.codex-shl
CODEX_MODEL=gpt-6-astra
```

`gpt-6-astra` with medium reasoning was verified with the VM's subscription on
2026-09-09. The code requires an explicit model when enabling Codex; future
model changes require another smoke test. The binary path is installation
dependent; check `command -v codex`.

Authenticate as the service account with `CODEX_HOME` set using `codex login
--device-auth`, or securely provision an authorized CLI auth cache as described
in the official authentication documentation. The directory must be mode 700
and auth/config files mode 600. Preserve token refreshes in place. Never put
credentials in git, command arguments, logs, Linear or PR descriptions. The
runner forces ChatGPT authentication and does not pass API-key variables to
Codex. The dedicated service home supplies existing `gh` and `gcloud` login
files; no second API billing path is introduced.

Build and run the isolated real-provider test on the VM:

```sh
npm ci --prefix dispatcher
npm run build --prefix dispatcher
sudo -u joblander -H env CODEX_HOME=/home/joblander/.codex-shl \
  CODEX_MODEL=gpt-6-astra node dispatcher/scripts/smoke-fallback.js
```

This injects a Claude quota response and invokes real Codex with a no-tools
probe. It uses temporary observability state, never starts the daemon or claims
an incident, and aborts after 90 seconds.

On 2026-09-09 at 18:55 UTC this check passed on the VM in 7.8 seconds: real
Codex reported input 15,378, cached input 12,160, cache writes 0 and output 12.
The Claude quota leg was simulated; no production incident was created.
Separate read-only Codex smokes called the vendored Firebase, Sentry and Linear
tools successfully. Select the exact `mcp__linear__list_teams` tool; loose
catalog suffix matching can confuse the local MCP with another connector.
A successful test is deployment evidence; it does not fabricate a production
repair or clear production state.

## Durable usage and provider state

Beside `LOG_DIR` (the trace directory), retain these files in backups:

| File | Purpose |
| --- | --- |
| `usage-ledger.jsonl` | Append-only, fsynced attempt starts, completed attempts and run summaries. Never rotate with individual traces. |
| `providers.json` | Provider status, actual last success/failure, failure kind and next eligible retry time. |
| `health-alerts.json` | Pending/delivered capability and dependency notifications, retry state. |

Restart replays every ledger record once by ID; the 50-run `/feed` ring does not
limit counters. Existing traces are imported once. Interrupted attempts are
recorded with unknown usage on recovery. Partial final JSONL writes are skipped
without losing subsequent records. Storage errors fail the new attempt rather
than running an unaccounted investigation. Replay reads 64 KiB chunks with a 4 MB
per-record bound instead of loading the complete ledger. Invalid records are
excluded from the feed and exposed as `accounting.rejectedRecords` plus a
maintenance alert; they do not poison valid records.

`LEDGER_MAX_BYTES` defaults to 128 MiB per component, with an alert at half that
size. The regression fixture measured approximately 466 bytes per attempt start,
314 per completed attempt and 514 per run; real model breakdowns/errors are
larger. A conservative planning allowance of 5 KiB per two-provider run at 144
runs/day is about 0.7 MiB/day: warning after roughly three months, hard cap after
six, with normal empty-queue skips extending both. Observe actual bytes before
raising the bound. Existing trace cleanup must never include the ledger.

The cap bounds disk growth and dedup replay memory without dropping historical
IDs or resetting counters. A transactional compactor/checkpoint format is
intentionally deferred; naive rotation would break lifetime totals and replay
deduplication. Size warnings and failures use the independent durable Telegram
outbox as well as HTTP/Prometheus. At the cap or on a storage read/write error,
`/health` stays live, `/ready` is degraded, counter samples are omitted rather
than reporting false zeros, and new provider attempts stop. Preserve/back up
the ledger, repair ownership/mount/free space (or increase `LEDGER_MAX_BYTES`
with matching capacity and restart to load the configuration). A later poll
replays repaired storage automatically and restores the same totals before
resuming. Never delete/truncate the valid ledger to clear an alert. If the whole
filesystem is unwritable, outbox persistence can also fail; the liveness payload,
metrics and process log still expose accounting failure and notification retry
continues after storage repair.

Each attempt records provider, configured model, provider session ID, timing,
status, error class, raw numeric provider usage and normalized usage. Claude's
SDK model breakdown is retained and used for token metrics when submodels ran.

* `usage.input` is total input including cached reads and cache writes. Claude
  reports these separately, so they are added once. Codex's `input_tokens`
  already includes cached tokens, so `cached_input_tokens` is not added again.
* `cachedInput` and `cacheWrite` are subsets of input. Do not sum them with input.
* `null` means not reported/unknown; numeric zero means the provider reported
  zero. Missing usage increments the unknown-usage counter.
* `estimatedCostUsd` from Claude is the SDK's estimate, not the subscription
  invoice. Codex does not report dollar cost: its estimate stays `null`.
  Aggregate cost metrics contain known estimates only; they are never billed USD.

## Liveness, readiness and notifications

`/health` and `/live` retain HTTP 200 and `status:"ok"` for the cron heartbeat
and VM watchdog. They also expose `ready`, provider state and dependency status.
**Never reset or roll back a VM because a subscription is exhausted.**

`/ready` returns 200 only when a provider has real successful-turn evidence
within `PROVIDER_EVIDENCE_MAX_MS` (default 24h), no newer availability failure,
all real dependency probes succeeded within seven hours, and durable accounting
storage is healthy. Otherwise it
returns 503. `/status` and Prometheus expose the same distinction. An expired
cooldown makes a provider eligible for another attempt; it never marks it
healthy. A token file's presence is not recovery evidence.

Quota messages with dated UTC resets (including extra-usage exhaustion) retain
their actual reset deadline plus a two-minute buffer. Unparseable quotas and
auth/service errors use `PROVIDER_RETRY_MS` (default one hour). A legacy Claude
`pause.json` is imported without blocking the newly enabled Codex provider. Bare
429/rate-limit throttling uses `PROVIDER_THROTTLE_RETRY_MS` (default one minute),
while explicit reset metadata still wins. The resume watcher uses provider
deadlines rather than obsolete global pause state.

Capability failure/recovery is notified independently of Linear and does not
create recurring quota repair tickets. Dependency tickets are deduplicated,
but notification delivery is tracked separately: a failed Telegram send stays
pending across restart and retries each minute. Existing open tickets do not
suppress a previously undelivered alert. Recovery notifications require a real
successful probe or turn. Grafana includes overall/provider readiness, actual
token counters, attempts/failures and unknown-usage counts.

## Standalone monitor adapter

`node dispatcher/dist/providerCli.js` reads a prompt on stdin and writes a final
JSON line `{turnId, output, error, attempts}`. Exit 0 means provider completion;
exit 1 means unavailable or failed. The caller must still validate its own task
output. It uses the same adapters, MCP servers, subscription constraints,
fallback and usage ledger. Set a distinct `LOG_DIR` for the monitor (for example
`/var/log/self-healing-monitor/turns`) and serialize monitor invocations with its
cron lock. The monitor and dispatcher must not concurrently write the same
provider-state file. No dispatcher startup/poll occurs through this entry point.

Official references: [non-interactive JSON events](https://learn.chatgpt.com/docs/non-interactive-mode),
[subscription authentication](https://learn.chatgpt.com/docs/auth),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
