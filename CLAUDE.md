# Self-Healing Loop — Project Rules

Project language: **English** (code, docs, commits, dashboards). Chat with the owner: Russian.

## LLM inference — single-provider rule (owner directive, 2026-07-18)

**LLM calls in this project happen ONLY through the same Claude CLI already deployed
on the VM — or they do not happen at all.**

- The dispatcher and monitor run as Claude Code / Claude Agent SDK sessions on the
  VM under the subscription OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`). That is the
  **only** sanctioned inference path.
- **No external LLM API.** No Anthropic API key, no Gemini, no OpenAI, no Haiku-as-a-service,
  no "cheap side judge." No second inference credential, no second provider, no second bill.
- If a component needs judgment, it MUST be one of:
  1. reasoning done inside an existing Claude CLI agent session (the dispatcher/monitor
     already thinking), or
  2. fully deterministic (no LLM at all).

Rationale: the entire product is Claude-CLI-based. A bolted-on external inference path is
a second credential, a second failure mode, a second cost line, and an inconsistency every
self-hoster would inherit. One mechanism.

### Consequence for Change Context (intent correlation)

The correlation "is this anomaly explained by a recent intentional change?" is **not** a
separate model call. It splits into:

- **Ingest / normalization → deterministic.** Pulling PR bodies, cloud audit-log entries,
  and closed-ticket text into `ChangeEvent` records is plain extraction, no LLM.
- **The judgment → the dispatcher agent's own reasoning.** The Claude CLI agent that already
  investigates an incident reads the change feed as one more source (like logs or Linear) and
  concludes "explained → decline / unexplained → fix." No extra call, same session, same token.

See `docs/DESIGN-intent-correlation.md` and `docs/DESIGN-change-ingest-infra.md`.

## Git worktree hygiene (owner directive, 2026-07-12)

All code work happens in a dedicated git worktree off `origin/main`:
`git worktree add .claude/worktrees/<task> -b worktree-<task> origin/main`.
Never touch the main checkout. This rule is passed to every subagent that writes code.
