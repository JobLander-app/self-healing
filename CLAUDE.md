# Self-Healing Loop — Project Rules

Project language: **English** (code, docs, commits, dashboards). Chat with the owner: Russian.

## LLM inference — subscription CLIs (owner directive, 2026-09-09)

The dispatcher uses Claude Agent SDK under the deployed Claude subscription as
primary and Codex CLI under ChatGPT subscription authentication as its fallback.
The same dispatcher constitution and tools apply to both providers. Fail over
only on provider quota, authentication or availability failures; task failures
must not be retried blindly. Cross-provider handover is a new session that
rechecks durable ticket/PR state, never a claim to resume Claude's conversation.

No external inference API keys or separate metered API integrations. Monitor
judgment remains inside its existing subscription CLI session. Deterministic
collection, filtering, health checks and accounting do not invoke an LLM.

### Consequence for Change Context (intent correlation)

The correlation "is this anomaly explained by a recent intentional change?" is **not** a
separate model call. It splits into:

- **Ingest / normalization → deterministic.** Pulling PR bodies, cloud audit-log entries,
  and closed-ticket text into `ChangeEvent` records is plain extraction, no LLM.
- **The judgment → the dispatcher agent's own reasoning.** The dispatcher agent that already
  investigates an incident reads the change feed as one more source (like logs or Linear) and
  concludes "explained → decline / unexplained → fix." No extra call, same session, same token.

See `docs/DESIGN-intent-correlation.md` and `docs/DESIGN-change-ingest-infra.md`.

## Git worktree hygiene (owner directive, 2026-07-12)

All code work happens in a dedicated git worktree off `origin/main`:
`git worktree add .claude/worktrees/<task> -b worktree-<task> origin/main`.
Never touch the main checkout. This rule is passed to every subagent that writes code.
