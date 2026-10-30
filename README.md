# Self-healing loop

An agent-operated production repair loop: observe failures, file evidence in
Linear, investigate one incident, propose a tested fix, and verify what happens
after deployment. Start here with your coding agent.

## What you need, and what you are enabling

| Resource | Required for the supplied deployment |
| --- | --- |
| Dedicated GCP project or scoped access to one | Billing enabled, a VPC/subnet, Cloud Logging, Secret Manager and permission to provision the listed Terraform resources. |
| Linux VM | The template defaults to Ubuntu 22.04, `e2-standard-2`, a 50 GB persistent disk and a static external IP. This is a continuously running VM, not a laptop service. |
| GitHub repositories | A fork of this repository, target source repositories, runnable tests, CI/release workflows and a narrowly scoped token. |
| Linear | A team, API key, workflow states and `monitor`, `agent-claimed`, `false-positive` labels. Linear stores incident decisions; no PostgreSQL setup is needed. |
| Agent access | Claude subscription OAuth for the primary harness. Optional Codex subscription login and/or OpenCode with a separately billed OpenRouter API key. See [harness support](dispatcher/README.md). |
| Product signal | Cloud Run error logs and a product-output health endpoint implementing the [watcher contract](watcher/README.md). Generic uptime alone cannot detect missing product output. |
| Alerts and console | A Telegram bot/chat, an email destination, a DNS name for Grafana and a strong Grafana admin secret. GCP's native dashboard uses Google IAM. |

Budget for continuous compute, disk/IP, logs, monitoring, Secret Manager, the
watchdog function/scheduler and model access. Costs depend on region, traffic,
retention and provider; set budgets and run limits before enabling live work.
The included VM permissions read logs/service configuration, write telemetry and
read named secrets. Firestore and Sentry are opt-in. The external watchdog can
reset this specific VM after stale heartbeats, within its reset budget.

Agents can read production evidence and, in live mode, edit repositories, create
PRs and change Linear tickets. `AUTO_MERGE=true` also authorizes merging eligible
repairs, potentially triggering your CI deployment. It defaults to **false**;
`DRY_RUN` defaults to **true**. These are operational instructions and host gates,
not a sandbox against malicious code. Use dedicated credentials, branch
protection and an operator who owns failures, review and spending. Do not place
secrets in profiles, Terraform variables or committed files.

## Ask your agent to set it up

Copy this prompt into your coding agent with access to your fork:

> Configure this self-healing repository for my application. Read README.md,
> dispatcher/README.md, docs/SETUP.md and consumers/example first. Discover my
> actual services, regions, repositories, Linear team/states/labels and existing
> CI from connected sources. Ask me only for missing product decisions, access
> and budget constraints. Create a new consumer profile, targets and policy;
> do not edit another consumer or assume its identifiers. Explain the resources,
> credentials, permissions and recurring costs before provisioning. Keep dry run
> enabled and auto-merge disabled. Implement/verify the output endpoint contract,
> run local tests and prepare a reviewable Terraform plan. Obtain authorization
> before creating cloud resources or enabling production writes. After setup,
> verify a dry-run investigation, false-positive suppression, alerts, dashboards
> and restart recovery. Record what was actually observed and what is untested.

The [setup runbook](docs/SETUP.md) gives concrete configuration and verification
steps. A new deployment needs its own Terraform state and secrets. Never apply
another consumer's state/configuration to your project.

## Replace the consumer, keep the loop

```text
consumers/my-app/
  profile.json     # non-secret environment and optional integration selection
  targets.json     # monitored services, regions, reviewed retirement intent
  policy.md        # service → repository routing, product rules, review/release policy
  monitor.py       # optional custom collectors/severity rules
```

Copy [consumers/example](consumers/example). `config/run.py` validates the profile
and injects it into watcher, monitor and dispatcher. Shared defaults are read-only;
provider credentials come from the service environment/Secret Manager. No custom
Python adapter is needed for the basic Cloud Run collector. See
[consumer contracts](consumers/README.md) for extension hooks.

The [JobLander consumer](consumers/joblander) contains the existing production
routing, voice/billing monitoring and deployment state location. It is an
optional reference deployment, not an implicit default. Historical incident
narratives live in Git history rather than reusable code comments.

## How the loop behaves

1. The minute watcher detects sustained loss of product output and sends a page.
2. The hourly monitor groups log signals, checks scope, freshness, closed-ticket
   cooldowns and **false-positive labels**, then deduplicates/creates Linear issues.
3. The dispatcher polls Linear, selects one recent eligible issue and checks
   provider readiness before inference. Empty queues do not spend model tokens.
4. The agent confirms the failure is current and unexplained by an intentional
   deployment/decommission. It tests a narrow fix and obtains required review/CI.
5. Authorized merges go through the target's release workflow. The monitor or a
   later verification run checks post-deployment recurrence; a merge alone does
   not establish recovery.

Every proven false positive gets a reason, evidence, `false-positive` label and
Canceled state on the **original ticket**. The dispatcher skips that label.
For the exact signature at equal/lower severity, the first and second confirmed
verdicts each pause filing for **24 hours**. A recurrence after the pause gets a
new investigation. The third independent verdict suppresses filing for **30 days**;
after expiry, the next investigation starts a new cycle. Duplicate tickets filed
during a pause do not count or extend it. Archived tickets retain the history.
P0 and increased severity bypass suppression. Removing a label withdraws that
verdict; remove all applicable labels to reset the history immediately.
Linear read/write failures defer work; a local delivery outbox retries interrupted
updates without another model run. This breaks the investigate → close → re-file
loop without adding a separate database.

## Components and observability

| Directory | Responsibility |
| --- | --- |
| [dispatcher](dispatcher/README.md) | Queue, three harnesses, repair constitution, accounting and localhost API |
| [monitor](monitor/README.md) | Deterministic collection, exact-signature suppression and durable escalation |
| [watcher](watcher/README.md) | Product-output health contract and incident lifecycle |
| [change-ingest](change-ingest/README.md) | Local SQLite feed of GitHub, GCP and Linear changes; no model calls |
| `mcp/` | Vendored Linear, optional Firestore and Sentry tools |
| `deploy/`, `init/`, `infra/` | Transactional pull deployment, VM installer, Terraform and watchdog |

Grafana/Prometheus show local run/provider/accounting health. A native GCP
Monitoring dashboard shows run outcomes, investigation duration and independent
heartbeats; it needs no application-specific database. Run duration is **not**
time to production recovery. Operational Cloud Logging counters use at-least-once
delivery; the local usage ledger is the accounting source. New metrics appear
only after installation and real activity. See [operations](docs/OPERATIONS.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep product rules in consumers and test
both generic behavior and affected adapters. This project is under the
[MIT license](LICENSE.md): preserve its copyright and permission notice when
redistributing. [Authors and acknowledgments](AUTHORS.md) credit the original
work and the Securify collaboration with Nkemjika.
