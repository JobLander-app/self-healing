# self-healing

**A standalone product: an autonomous production self-healing loop.** It detects
when a service's *product output* dies (not just when it throws errors), pages the
owner, files a ticket, and autonomously investigates → fixes → ships. The pattern
is the product; a *consumer* plugs in its own output detector, its dependency set,
and the repo to fix.

**Consumers.** JobLander is **consumer #1** — the first (and currently only)
tenant. Everything consumer-specific here is JobLander's configuration, not the
loop itself: the detector endpoint (`/health/output`), the dependencies the fixer
reaches (firebase / sentry / linear / gcloud), the target repos it patches, and
the secrets. Generalizing to additional consumers is on the roadmap; today the
consumer wiring is hard-coded to JobLander — this doc is honest about that, not
aspirational.

Born from a JobLander incident, **JOB-651** (a 19-hour silent STT outage: zero
errors, zero output — every existing monitor watched errors, none watched product
OUTPUT). Extracted into this repo (**JOB-731**, 2026-07-14) from an untracked
incarnation on a shared VM whose dispatcher TypeScript sources had been lost.

**Design goal:** `terraform apply` + startup init = the whole loop stands up on a
fresh VM and works. Nothing hand-crafted on disk, all secrets in Secret Manager,
all alert policies in Terraform, all the fixer's tools (MCP servers) vendored in
this repo. Reproducibility is the point — the original was one disk failure away
from non-existence.

**Status (2026-07-17):** fully live on VM `self-healing-1` (europe-west1-b,
Terraform-managed, GCP project `meet-assistant-6d8ad`), healing JobLander prod.
All three roles — watcher, hourly monitor, dispatcher — run there.

---

## The loop

The **detector** is the consumer's contract with the loop: any endpoint that
answers "is product output alive?" for that consumer. Everything else (watcher,
monitor, dispatcher) is the reusable engine.

| Layer | What it answers | Code | Runs |
|---|---|---|---|
| **Detector** (consumer-owned) | "did value reach the user?" — JobLander's is `/health/output`, per region vs same-window-yesterday baseline (JOB-668) | JobLander `backend` repo, `src/services/health-output/` | inside the consumer's service (Cloud Run, 3 regions) — NOT this repo |
| **Watcher** | polls the detector 1/min; on 3 consecutive bad samples: Telegram P0 → Linear `[Monitor]` ticket → wakes the dispatcher; RECOVERED on clear. Hysteresis avoids flapping (JOB-670, JOB-725) | `watcher/` | minute cron on the VM |
| **Hourly monitor** | error-side triage (Cloud Run / Cloud Functions / LiveKit VMs / Sentry) → escalations + verbatim P0 alerts; a Claude session sends only what the deterministic `triage.py` prepared | `monitor/` | hourly cron on the VM |
| **Dispatcher** | autonomous fixer: picks ONE `monitor`-labeled Linear ticket per tick, investigates prod, writes a fix, opens a PR, and auto-merges (the sanctioned Self-Healing Loop exception) — or proves it's not a bug | `dispatcher/` | systemd on the VM, HTTP :4100 (`/trigger`, `/status`, `/feed`) |
| **Watchdog** (off-box) | the only layer that is not on the VM: reads heartbeat age from Cloud Logging every 5 min, pages Telegram, and resets the instance on its own — budgeted, and never on a signal it has never seen (2026-08-26) | `watchdog/` | Cloud Scheduler → Cloud Functions gen2, `europe-west1` |

The watcher files a ticket → the dispatcher picks it up → the fix merges → Cloud
Build deploys. A closed loop from "output died" to "fix in prod", with the owner
watching in Telegram but not in the critical path.


### Why one layer lives outside the VM

On 2026-08-26 the loop lost its DHCP address under memory pressure and ran blind
for six days: cron ticked, the dispatcher restarted, the watcher watched, and
none of it could reach Cloud Logging, Linear or Telegram. Every detector lived
on the VM or reported through its network, the dead-man alert notified an email
channel that has never delivered a message, and nothing anywhere could issue a
reset. Full account: `docs/POSTMORTEM-2026-08-26-network-blackout.md`.

So the loop now watches itself from three places at once:

- **inside, preventively** — `selfheal.slice` caps what an agent session may
  take, `earlyoom` kills a runaway before the host thrashes, and
  `KeepConfiguration=dhcp` keeps the address through a failed lease renewal;
- **inside, curatively** — `selfheal-netwatch.timer` probes the metadata server
  every two minutes and escalates reconfigure → restart networkd → reboot;
- **outside** — the watchdog function, which can page and reset without the VM's
  cooperation, and an alert relay (Pub/Sub → Telegram) so a page actually
  arrives.

---

## Dispatcher tooling (MCP servers, vendored in-repo)

The dispatcher's investigation session (Claude Agent SDK `query()` in
`dispatcher/src/session.ts`) is given real tools via **stdio MCP servers vendored
under `mcp/`** — run locally as child processes: no Cloud Run, no dependency on
the `tools` repo, no expiring OAuth connectors. The whole system stays
self-contained and reproducible from this repo alone.

| MCP | Tools | Auth | Purpose |
|---|---|---|---|
| `mcp/firebase/` | 11 — `firestore_*`, `auth_*` | **ADC** (VM service account, no key file); SA has `roles/datastore.viewer` | read Firestore (meetings/users) during investigation |
| `mcp/sentry/` | 2 — `sentry_list_issues`, `sentry_get_issue` | `joblander-sentry-monitor-token` | read error groups |
| `mcp/linear/` | 13 — `list_issues`, `get_issue`, `search_issues`, `update_issue`, `create_comment`, `list_teams/states/labels/projects/cycles/comments`, `create_issue`, `create_project` | `linear-api-key` — a **personal API key that never expires** (why we self-host instead of claude.ai's OAuth Linear connector, which kept logging out) | structured Linear: claim = `update_issue`, comment = `create_comment`, find work = `list_issues` |

GCP is reached via the `gcloud` CLI (Bash) — the SA has `logging.viewer`; no MCP
needed. `dispatcher/CLAUDE.md` (the constitution) documents when to use which.

Wiring: `session.ts` passes these as inline `mcpServers` stdio defs and adds
`mcp__firebase__*` / `mcp__sentry__*` / `mcp__linear__*` to `allowedTools`;
`LINEAR_API_KEY` is resolved once from Secret Manager and injected into the child
env. The daemon's out-of-agent poll pre-check uses Linear GraphQL directly —
separate from the agent's MCP path.

---

## Self-healthcheck (keeps the dispatcher's tools working)

`dispatcher/src/healthcheck.ts` — ported from the `handy-daemon` pattern and
pointed **inward**. Runs on startup and every 6h (`0 */6 * * *`), entirely outside
the agent (plain Node / child processes / stdio JSON-RPC — never through Claude
tools). Five probes, each with a real smoke call:

1. **firebase MCP** — spawn → `tools/list` >0 → smoke `firestore_list_collections` (exercises ADC + datastore.viewer end-to-end)
2. **sentry MCP** — spawn → smoke `sentry_list_issues`
3. **gcp** — `gcloud logging read … --limit 1` exit 0 (the SA can read logs)
4. **claude-oauth-token** — resolves + non-empty (presence only; expiry is a known gap)
5. **linear MCP** — spawn → smoke `list_teams`

On failure: one Telegram (`⚠️ self-heal: dependency <dep> DOWN …`) **and it files a
`[SelfHeal]` Linear ticket** (label `monitor`, deduped against open ones) — which
the dispatcher's own poll then picks up and repairs. The same loop, turned on its
own toolchain. `/status.lastHealthcheck` exposes the latest result. This class of
check would have caught the OAuth-token/secret-access failure that silently broke
the hourly monitor on 2026-07-17.

---

## Cost control (poll pre-check)

`dispatcher/src/poller.ts` runs a cheap Linear existence query before spawning the
LLM agent on each tick. Zero `monitor` candidates → skip the agent entirely
(`lastPrecheck: skip` on `/status`), saving ~144 empty LLM runs/day. **Fail-open**:
any pre-check error → spawn the agent as before, so the loop is never blinded. A
manual `/trigger` bypasses the pre-check.

---

## Lifecycle observability (Telegram)

The owner watches one incident travel end-to-end: **created → acted upon → in
prod**. Every message is plain text (no `parse_mode` — unescaped content +
Markdown once silently dropped a real P0 on 2026-07-16); a send failure never
affects the loop.

| Event | Message | Emitted by |
|---|---|---|
| P0 page | `URGENT P0 [output-watch]: /health/output = … Regions: … <url>` | watcher, on 3 consecutive bad samples |
| Ticket created | `🎫 {IDENTIFIER} created — self-healing engaged` | watcher, right after a successful Linear create |
| Acted upon / in prod | `🚀 in prod: {ticket} FIXED — {PR} merged, deploy pipeline running. … ${cost}, {n}s` · `✅ {ticket}: investigated — not a bug. … ${cost}` · `⚠️ {ticket}: {outcome}. …` (DRY_RUN prefixed `[DRY_RUN] `) | dispatcher, at the end of a run that picked a ticket (`no-work` stays silent) |
| Recovered | `RECOVERED: /health/output = … Product output flowing again.` | watcher, when the detector clears after a page |
| Self-heal | `⚠️ self-heal: dependency <dep> DOWN — …. Filing repair ticket.` | dispatcher healthcheck, on a dep failure |

---

## Repo layout

```
watcher/       TypeScript port of output-watch.sh — pure decision core
               (hysteresis / exactly-once / recovery) + injectable effects
               (Telegram-first paging, best-effort Linear/trigger, heartbeat).
               vitest suite. output-watch.sh kept for reference/parity.
monitor/       triage.py (deterministic collector: Cloud Run/Functions/LiveKit
               via Cloud Logging + Sentry) + run-monitor-session.sh (hourly
               Claude escalation session; runs from THIS repo, reads state in
               the workspace checkout).
dispatcher/    Node 20 + TS autonomous fixer. src/ (reconstructed, tsc → dist/,
               dist committed — the VM runs dist), CLAUDE.md (the fixer's
               constitution — a security-level document, versioned), poller.ts
               (self-poll + pre-check), session.ts (Agent SDK + MCP wiring),
               healthcheck.ts, routes/ (trigger/status/feed).
mcp/           Vendored stdio MCP servers: firebase/ sentry/ linear/.
init/          init.sh — idempotent GCE startup-script (installs runtime, clones
               repos, renders secrets, builds dispatcher+watcher+mcp, installs
               systemd unit + crontab). legacy-startup-script.sh kept for ref.
infra/         Terraform (convention: ai-voice-agent-python — modules + roots,
               backend gs://meet-assistant-6d8ad-tfstate prefix self-healing):
               VM, dedicated SA + minimal IAM, IAP-only firewall, Secret Manager
               IAM, alert policies (dead-man on WATCHER_HEARTBEAT 5min +
               meetings-saved backstop).
deploy/        systemd unit, self-healing.crontab (installed by init),
               joblander-agents.crontab.snapshot (legacy, as-found).
docs/          TEST-PLAN.md (the role-handover test plan used for cutover).
```

---

## Provisioning

```bash
cd infra/terraform/self-healing
terraform init     # backend: gs://meet-assistant-6d8ad-tfstate, prefix self-healing
terraform apply    # VM self-healing-1 + SA + IAM + firewall + alert policies
```

`terraform apply` creates the VM with `init/init.sh` as its startup-script
(rendered via `templatefile`, **idempotent** — re-run any time with
`sudo google_metadata_script_runner startup`). Init installs the runtime (node 20,
gh, docker, Claude CLI, python, xvfb), creates user `joblander`, clones
`self-healing` + `workspace`, renders `dispatcher/.env` and `workspace/.env` from
Secret Manager, `npm ci`s + builds `dispatcher`, `watcher`, and each `mcp/*`,
installs the systemd unit + crontab, and starts everything.

**SSH:** IAP only — `gcloud compute ssh self-healing-1 --zone europe-west1-b --tunnel-through-iap`.

**Post-init TODO** (printed + written to `/home/joblander/POST-INIT-TODO.md`) —
the only steps init cannot script:
- Claude Code OAuth login as `joblander` — `claude setup-token` (subscription auth)
- `self-healing-gh-token` secret (a GitHub token) if not yet created — used for
  cloning private repos and the dispatcher's auto-merge (a dedicated GitHub App /
  machine identity is the intended replacement for the interim owner-token copy)

---

## Domain & HTTPS (the console)

The observability console (Grafana + dashboards) is served by Caddy, which
obtains and renews a Let's Encrypt certificate automatically — you just point a
domain at your instance.

**1. Get the instance IP.** After `terraform apply`, read the outputs:

```console
$ terraform output console_static_ip
"203.0.113.10"
$ terraform output console_dns_record
"self-healing.example.com A 203.0.113.10"
```

**2. Create one DNS `A` record** at your DNS provider — Host = your chosen
subdomain, Type = `A`, Value = the IP above. Any provider works; e.g. in
Namecheap (*Advanced DNS → Host Records*):

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `self-healing` | `203.0.113.10` | Automatic |

**3. Set your domain** and re-apply, so the instance renders it into Caddy + Grafana:

```hcl
# terraform.tfvars
console_domain = "self-healing.example.com"
```
```console
$ terraform apply
```

**4. Open `https://<your-domain>`.** Once DNS resolves (usually minutes), Caddy
issues the certificate on the first request — no manual cert steps. You land on
the Grafana login; the admin password is the Secret Manager secret
`self-healing-grafana-admin`.

> **Prefer no public domain?** Skip steps 2–3 and reach the console over an SSH
> tunnel instead:
> ```console
> $ gcloud compute ssh <vm> --tunnel-through-iap -- -L 3000:localhost:3000
> ```
> then open `http://localhost:3000`. Nothing is exposed to the internet — you can
> even leave ports 80/443 closed.

---

## Deploying a code change

**Merging to `main` is deploying.** A systemd timer on the VM
(`self-healing-deploy.timer`, every 2 min) runs
`deploy/bin/self-healing-deploy.sh`, which pulls `origin/main`, rebuilds only the
packages that changed, restarts the affected units, verifies them, and rolls back
to the previous commit if the verify fails.

> **This reverses an earlier deliberate choice.** Until 2026-07-28 this section
> read *"there is no CI/CD to the VM (deliberate — the fixer must stay
> inspectable)"*. Manual deploy did not survive contact with reality: nothing
> rebuilt or restarted anything after a merge, so `dispatcher/dist` stayed at its
> 2026-07-19 build and the process at `NRestarts=0`. PR #16 — the loop's own
> healthcheck fix, merged 2026-07-23 — sat on disk for five days having never
> executed, while its Linear ticket read Done. The loop could not distinguish
> *merged* from *deployed*, and closed tickets on the strength of the former.
> Inspectability is preserved by the deploy log and CI, not by withholding
> automation. (Owner directive, 2026-07-28.)

Guardrails in the deploy script:

- **Never restarts mid-investigation.** It reads `/status` and defers if
  `busy:true` — killing a run would strand a Linear ticket claimed `In Progress`.
- **`flock`** so a slow `npm ci` cannot overlap the next timer tick.
- **Rollback on failed verify** — unit not active, or `/health` not `ok`, resets
  to the previous commit, rebuilds, restarts, and pages Telegram.
- **Build artifacts are gitignored,** so a failed build leaves the last working
  `dist/` in place instead of a half-written tree.

Watch it: `journalctl -u self-healing-deploy` or `/var/log/self-healing-deploy.log`.

CI (`.github/workflows/ci.yml`) is what makes this safe — the deploy trusts
`origin/main` blindly, so every package that ships is built there on each PR:
watcher, dispatcher, change-ingest, plus `shellcheck` on the deploy script.

Manual deploy, if you need to force one:

```bash
gcloud compute ssh self-healing-1 --zone europe-west1-b --tunnel-through-iap \
  --command='sudo systemctl start self-healing-deploy.service && sudo tail -20 /var/log/self-healing-deploy.log'
```

After changing `init.sh` or Terraform, run `terraform apply` to refresh the VM's
startup-script metadata so a future re-provision stays reproducible.

**Check health:** `curl -s localhost:4100/status` on the VM → `dryRun`, `busy`,
`lastPrecheck`, `lastHealthcheck`, plus recent runs via `/feed`.

---

## Secrets (Secret Manager, project meet-assistant-6d8ad)

| Secret | Used by |
|---|---|
| `self-healing-dispatcher-env` | dispatcher `.env` (rendered by init) |
| `self-healing-workspace-env` | `workspace/.env` — TG_BOT_TOKEN/TG_CHAT_ID for notify.sh |
| `self-healing-trigger-token` | `X-Dispatch-Token` for POST /trigger (watcher → dispatcher) |
| `self-healing-gh-token` | git clone + dispatcher auto-merge (interim) |
| `claude-code-oauth-token` | the dispatcher / monitor Claude sessions |
| `HEALTH_OUTPUT_HMAC_KEY` | watcher signs its `/health/output` probe |
| `linear-api-key` | watcher/poller GraphQL + the vendored linear MCP |
| `joblander-sentry-monitor-token` | monitor triage + the vendored sentry MCP |
| `qa-test-user-password` | granted to the SA (reserved) |

SA `self-healing-agent` project roles: `logging.viewer`, `logging.logWriter`,
`monitoring.metricWriter`, `datastore.viewer` (Firestore reads via ADC), plus
per-secret `secretAccessor` and bucket-scoped `objectAdmin` on
`gs://joblander-agent-logs`.

---

## Alerts (Terraform-managed)

- **Dead-man:** log-metric on `WATCHER_HEARTBEAT` absent 5 min → email. The
  watcher pages on prod, but nothing pages if the watcher itself dies — this closes
  that hole (its own failure domain).
- **Backstop:** meetings-saved absent 4h → email (the hand-made JOB-651 policy, as
  code).

---

## Backups / recovered artifacts (GCS)

- `gs://joblander-agent-logs/backups/loop-final-2026-07-17.tgz` — full snapshot of
  the loop components (dispatcher + state/traces, watcher, monitoring state) taken
  when they were removed from the legacy VM
- `gs://joblander-agent-logs/backups/atlas-memory-2026-07-15.dump` — final pg_dump
  of the retired agent-memory DB
- `gs://joblander-agent-logs/backups/dispatcher-state-2026-07-15.tgz` — early
  dispatcher dir snapshot

---

## Open items

- **Full legacy-VM cleanup** (owner signal): retire atlas-memory (backed up),
  decide on dead caddy domains, kill leftover experiment dirs. The loop is already
  off the old VM; this is the remaining housekeeping.
- **GitHub App / machine identity** for auto-merge, replacing the interim copy of
  the owner's `gh` token (needs a one-time owner setup in the GitHub org).
- **claude-oauth-token expiry** — the healthcheck verifies presence, not validity.

Tracking: Linear **JOB-731**.
