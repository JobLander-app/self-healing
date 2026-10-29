# Dispatcher harnesses

The dispatcher selects one recent Linear monitor ticket before starting a model.
All harnesses receive the same [constitution](CLAUDE.md), consumer policy, exact
candidate and freshness/intent gates. Empty queues do not start inference.

| Harness | Authentication | Configuration | Role |
| --- | --- | --- | --- |
| Claude Agent SDK / Claude Code | Claude subscription OAuth (`CLAUDE_CODE_OAUTH_TOKEN`) | `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS` | Primary |
| Codex CLI | VM-local ChatGPT login, serialized credential refresh | `CODEX_ENABLED=true`, explicit `CODEX_MODEL` | Optional fallback |
| OpenCode CLI + OpenRouter | Metered `OPENROUTER_API_KEY` | `OPENCODE_ENABLED=true`, `OPENCODE_MODEL=openrouter/<provider>/<model>` | Optional fallback |

Order: Claude → enabled Codex → enabled OpenCode. No model name is silently
chosen for a fallback. The installer pins CLI versions; the selected model must
support tools and the required context. Verify a read-only turn on the actual VM
before enabling it. A subscription is not a guarantee of unlimited throughput.
OpenRouter usage has separate billing; its key belongs in the dispatcher secret,
not a consumer profile or Git. The monitor uses the same provider runner.

Fallback handles quota, throttling, authentication and provider availability.
Task failures and timeouts do not automatically start another investigation.
After tool activity a handover re-reads durable ticket/PR state; it is a new
session, not continuation of another provider's conversation. Usage accounting
records each attempt separately and preserves unknown cost as unknown.

The OpenCode adapter consumes JSON events, uses local MCP servers and bounds
runtime/output. It invokes `opencode run --format json --model … --auto` (pinned
1.18.33). Its MCP config contains paths and routing, never secret values in argv.
The agent runs with the VM account's authority; `--auto`, Claude bypass permission
mode and Codex's execution mode are not isolation boundaries. Use a dedicated VM,
scoped service account, repository allowlist and branch protection.

## Local validation

```sh
npm ci
npm run build
npm test
```

Run from this directory through the profile launcher:

```sh
python3 ../config/run.py --profile ../consumers/my-app/profile.json -- node dist/index.js
```

Credentials are supplied by the service's EnvironmentFile / Secret Manager.
`DRY_RUN=true` and `AUTO_MERGE=false` are the new-consumer defaults. Inspect
`GET /status`, `/feed`, `/metrics` and `/health` on localhost:4100. Readiness,
accounting health, provider readiness and VM liveness are separate signals.

## Breaking false-positive loops

For every `not-a-bug` result the host verifies the original issue, then saves its
reason/evidence, `false-positive` label and Canceled state in one Linear update.
The queue skips that label. The monitor reads labeled tickets before filing the
same signature again, including old and archived tickets. It also prunes pending
filings. No separate database is needed. The small local delivery outbox handles
lost responses/restarts; it does not replace Linear as the source of decisions.
If Linear cannot be read, filing waits; urgent pages still run.

The host persists the verdict timestamp before delivery; a retry cannot restart
the pause. The first two independent verdicts pause exact-signature filing for
24 hours each; the third pauses it for 30 days, then the confirmation cycle resets.
Only new tickets filed after the prior pause count. P0 and increased severity
bypass suppression. Removing a label withdraws that verdict from history.
Do not use this verdict for a stale report or an already fixed real bug.
