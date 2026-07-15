# self-healing

JobLander self-healing loop — the system that detects "product output died" in
production, pages the owner, files a ticket, and autonomously fixes it. Born from
the JOB-651 post-mortem (19h silent STT outage: zero errors, zero output — no
monitor measured product OUTPUT). Extracted into its own repo per owner directive
(JOB-731, 2026-07-14): the previous incarnation lived untracked on the
`joblander-agents` VM, and the dispatcher's TypeScript sources were lost.

**Goal: `terraform apply` + startup init = the whole loop stands up on any fresh
VM and works immediately.** Nothing hand-crafted on disk, all secrets in Secret
Manager, all alert policies in Terraform.

## The loop (three layers + a fixer)

| Layer | What it answers | Code | Runs |
|---|---|---|---|
| Detector `/health/output` | "did value reach the user?" per region vs same-window-yesterday baseline (JOB-668) | `backend` repo, `src/services/health-output/` | inside the backend service (Cloud Run, 3 regions) |
| Watcher | polls detector 1/min; on 3 consecutive bad samples: Telegram P0 → Linear `[Monitor]` ticket → wakes dispatcher; RECOVERED on clear (JOB-670) | `watcher/` | cron on the loop VM |
| Hourly triage | error-side monitoring narrative (errors, not output) | `monitor/` | cron on the loop VM |
| Dispatcher | autonomous fixer: picks ONE `monitor`-labeled Linear ticket per ~10 min tick, investigates prod, writes fix, PRs, auto-merges (sanctioned exception) | `dispatcher/` | systemd on the loop VM, HTTP :4100 (`/trigger`, `/status`, `/feed`) |

## Repo layout

```
dispatcher/   Node 20 + TS. dist/ is the RECOVERED compiled output from the VM
              (sources were lost; TS reconstruction = Phase 1, criterion: tsc
              output ≡ this dist). CLAUDE.md = the fixer's constitution
              (security-level document — versioned here).
watcher/      output-watch.sh (current prod version, incl. JOB-725 fix).
              Phase 1: TS port with unit tests (hysteresis, dedup, Telegram-FIRST).
monitor/      triage.py + run-monitor-session.sh (hourly Claude triage session).
init/         startup provisioning. legacy-startup-script.sh = current GCE
              metadata script (baseline). Target: idempotent init that installs
              runtime, clones repos (self-healing, meeting-lab from ITS repo,
              workspace), renders secrets from Secret Manager, installs
              units/cron from deploy/, starts everything.
infra/        Terraform (convention: ai-voice-agent-python — modules + roots,
              state gs://meet-assistant-6d8ad-tfstate): VM, dedicated SA,
              firewall, Secret Manager IAM, alert policies incl. dead-man
              "watcher heartbeat absent 5min".
deploy/       systemd units, cron files (installed by init), CI config.
              joblander-agents.crontab.snapshot = as-found snapshot (2026-07-15).
```

## Secrets (Secret Manager, project meet-assistant-6d8ad)

- `self-healing-dispatcher-env` — full dispatcher .env (split into individual
  secrets in Phase 2)
- `self-healing-trigger-token` — X-Dispatch-Token for POST /trigger
- `HEALTH_OUTPUT_HMAC_KEY`, `linear-api-key`, `joblander-sentry-monitor-token` — pre-existing, read by watcher/triage

One-time manual steps after provisioning (documented, unavoidable):
Claude subscription OAuth login (`claude` CLI) for the dispatcher agent.

## Backups / recovered artifacts

- `gs://joblander-agent-logs/backups/atlas-memory-2026-07-15.dump` — final pg_dump
  of the retired agent-memory DB (owner: nobody reads it; container to be removed
  at cutover)
- `gs://joblander-agent-logs/backups/dispatcher-state-2026-07-15.tgz` — full
  dispatcher dir snapshot (state, traces, .env) as of extraction

## Status / constraints

- Linear: JOB-731. Old VM `joblander-agents` STAYS until explicit owner signal —
  no cutover, no cleanup without it.
- Phases: 0 rescue (done) → 1 code (TS reconstruction + watcher port + CI) →
  2 terraform + init → 3 new VM, self-tested, parallel run → 4 cutover (owner signal).
