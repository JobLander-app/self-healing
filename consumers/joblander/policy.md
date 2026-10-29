# JobLander production policy

The product delivers interview transcripts and hints. The output detector is
the backend's `/health/output`; zero output can also mean no active interviews.
The production watcher uses a 15-sample threshold to avoid paging for brief,
previously observed quiet periods.

Repository mapping (GitHub organization `JobLander-app`):

| Service | Repository |
| --- | --- |
| joblander-audio-engine | backend |
| Frontend pages / joblander-app | joblander.app |
| Browser extension | chrome-extension |
| Cloud Functions email pipeline | email-service |
| Voice agent workers | ai-voice-agent-python |
| [SelfHeal] loop dependencies | self-healing |

Use `yarn install --frozen-lockfile` in the frontend. Read each target's current
repository instructions, required checks and production deployment workflow.
Only repositories in TRACKED_REPOS are approved. AUTO_MERGE is enabled for
this deployment, subject to the generic review and freshness gates.

Treat `targets.json` as reviewed coverage intent. Retired resources and ended
coverage must not be restored. The optional monitor adapter owns voice latency,
geographic routing, billing-ledger and duplicate-free-grant rules. The latter is
off unless DUPLICATE_WORKER_MODE explicitly enables it. Purchased minutes must
never be reduced by free-grant cleanup.

Required automated review: Codex on the current PR head; at most three rounds.
Resolve substantive findings and require all target repository CI checks.
