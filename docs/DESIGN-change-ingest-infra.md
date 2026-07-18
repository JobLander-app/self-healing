# DESIGN: change-ingest + storage + serving infra

**Status:** contract locked with `architect` (design-only — nothing deployed).
**Owner:** DevOps/platform. **Consumer of this design:** the intent-correlation
core (`architect`), which *reads* the change store; this doc owns how changes
*get in* and *where they live*. **Scope:** deployable on the current single-VM
Terraform + `init.sh` model (`self-healing-1`, europe-west1-b, project
`meet-assistant-6d8ad`). Tracking: Linear **JOB-731** (intent-correlation task).

**Note (single-provider rule, 2026-07-18):** wherever this doc says "the LLM
judges," the judge is the **dispatcher's own Claude CLI agent session** reading
these rows — never a separate model call (see repo `CLAUDE.md` +
`DESIGN-intent-correlation.md` revision banner). This doc is unaffected: ingest,
store, and serving are fully deterministic and carry no inference.

**Boundary contract with the correlation core** (reconciled 2026-07-18 — the
authoritative half of the seam; `docs/DESIGN-intent-correlation.md` points here):
the store row carries a distilled **`intent_text`** the LLM judges on (§2), the
entity join table keeps **`type` fully opaque** (no per-consumer columns, §2/§5),
and serving accepts a **time window `[since, until]`** with **repeated `entity=`
OR-matched** in one round-trip (§6). `ts` is defined as **effective time in prod**.

---

## 0. Why this exists

The loop today reacts to *symptoms* (output died, errors spiked) with no idea
what *changed* just before. The failure that motivates the whole feature is the
`lk-au-southeast1` instance delete: a human/agent deleted a prod GCE instance,
and the loop had no record of it to correlate the resulting anomaly against — it
would have chased the symptom instead of naming the cause. The correlation core
needs a **stream of prod ChangeEvents** it can ask: *"what changed touching
entity X in the last N hours?"* This doc designs that stream: transport in,
normalized store, query-out — under the repo's hard constraints:

- **Only Caddy (80/443) is public.** Every other listener binds `127.0.0.1`
  (`infra/terraform/modules/self-healing-vm/firewall.tf` documents this as an
  invariant: *"Do NOT add rules for those ports."*). A design that needs a new
  public port is a design that erodes the security posture — avoid it.
- **Least-privilege SA.** `self-healing-agent` has exactly
  `logging.viewer`, `logging.logWriter`, `monitoring.metricWriter`,
  `datastore.viewer`, per-secret `secretAccessor`, and bucket `objectAdmin`
  (`iam.tf`). Every new role must be justified against the au-delete win.
- **Reproducible-first.** `terraform apply` + `init.sh` = the whole thing stands
  up. No hand-crafted state on disk; secrets in Secret Manager; systemd units
  and crontab installed by init.

---

## 1. TL;DR — recommended transport per source

| Source | Transport | Mechanism | New public port? | New IAM/secret? |
|---|---|---|---|---|
| **GCP Cloud Audit Logs** (instance delete, Cloud Run deploy, IAM change) | **pull** | `gcloud logging read` of `cloudaudit.googleapis.com/activity` on a 2-min internal cron | no | **none** — existing `logging.viewer` covers Admin Activity logs |
| **CI/CD deploys** | **pull (effect-based)** | folded into the audit-log pull (a deploy *is* a `run.services.*` / build audit event); optional `gcloud builds list` for build-level granularity | no | none |
| **GitHub PR merges** | **pull** | `GET /repos/{o}/{r}/pulls?state=closed&sort=updated` filtered on `merged_at > cursor`, using the existing `self-healing-gh-token` | no | none (v1); webhook + `self-healing-gh-webhook-secret` is the v2 upgrade |
| **Linear** (issue status changes) | **pull** | direct GraphQL poll, reusing `linear-api-key` and the exact pattern in `dispatcher/src/poller.ts` | no | none |
| **Notion** (doc edits) | **pull** | vendored Notion MCP (stdio), slow cron | no | `notion-api-key` (only if not already present) |

**The single most important call:** *everything is pull.* Pull keeps the "only
Caddy is public" invariant fully intact — no source needs an inbound endpoint.
The correlation window is **hours**, not seconds (the au delete would have been
caught by a 2-min-late poll just as well as by a real-time webhook), so the
latency cost of polling is irrelevant to the product goal, and we trade zero
correctness for a materially smaller attack surface and less moving
infrastructure. Push transports (Pub/Sub sink, GitHub webhooks) are documented
below as the **v2 / scale** upgrade with their exact IAM, so the path is known —
but v1 does not pay their complexity.

---

## 2. The ChangeEvent contract (normalized store row)

One normalized row per change, source-agnostic. This is the boundary the
correlation core reads (§5).

```
ChangeEvent
  id           TEXT PRIMARY KEY   -- source-prefixed, stable, idempotent:
                                  --   gh:PR-262, audit:<logEntry.insertId>,
                                  --   build:<buildId>, linear:JOB-710, notion:<pageId>@<editTs>
  source       TEXT   -- github | deploy | gcp_audit | linear | notion
  kind         TEXT   -- pr_merged | deploy_succeeded | instance_delete |
                      --   iam_change | run_deploy | issue_status | doc_edit …
  ts           INTEGER -- epoch ms, EFFECTIVE time in prod (see below) — the axis correlation ranges over
  actor        TEXT   -- github login | SA email | linear user | notion user (context, NOT indexed)
  title        TEXT   -- human one-line summary
  intent_text  TEXT   -- bounded ~2KB: the NL essence the LLM judges "expected?" on (see below)
  raw_ref      TEXT   -- pointer to full payload (gh url / log insertId / linear id / gcs path)
  ingested_at  INTEGER -- epoch ms, when we recorded it (lag visibility)
```

**`ts` = when the change took EFFECT in prod** (audit delete timestamp, deploy
*finish*, PR merge time, ticket-close time) — not when a decision was made. A
decision that precedes its effect (a ticket closed "decommission AU" two days
before the VM delete) arrives as its **own separate ChangeEvent row**, so the
correlation core reads the decision→effect temporal spread *from the stream*,
and its lookback window absorbs the lead time. This is why a single `ts` column
suffices — no `decidedAt`/`effectiveAt` pair on one row. For deploys where merge
≠ deploy-finish, use deploy-finish.

**`intent_text` (load-bearing — the moat).** `title` alone is not enough for the
correlation LLM, and forcing it to fetch `raw_ref` per candidate on the hot path
would couple every correlation to live GitHub/Notion/Linear APIs (N fetches per
anomaly) — defeating the "one cheap bounded LLM call over pre-gathered
candidates" design. So the **distilled** unstructured text is inlined at ingest
(the puller already holds the full payload — the cheapest place to extract),
while the **raw** payload stays fetch-on-demand via `raw_ref` for the rare
human-escalation deep-link. Best of both; hot path stays small. Populate per
source, truncated to ~2KB:

| source | `intent_text` = |
|---|---|
| github | PR title + body |
| linear | issue title + description + **closing comment** |
| notion | the matched section text |
| gcp_audit | `methodName` + `resourceName` (e.g. `v1.compute.instances.delete lk-au-southeast1`) |
| deploy | commit subject |

Entities are stored in a **generic child join table** so the core query
("changes touching entity X") is a plain indexed lookup, not a JSON scan:

```
change_entity
  change_id  TEXT   -- FK → ChangeEvent.id
  type       TEXT   -- OPAQUE string — never a hard-coded column (see below)
  id         TEXT
  PRIMARY KEY (change_id, type, id)
  -- INDEX (type, id) drives the hot query
```

**`type` stays opaque text — this is a product-architecture invariant, not a
storage detail.** The store must NOT hoist `region`/`service`/`instance` into
per-type indexed *columns*: the product onboards arbitrary consumers whose
entity types are unknown at build time (a customer with only GitHub + audit
declares its own types in an entity-map config). Typed columns would force a
store re-migration per consumer; generic `(type, id)` rows with one composite
index carry zero JobLander leakage in the storage layer and match the core's
`EntityRef[]` model directly. `actor` is kept on the row as LLM/audit context
but is deliberately **not indexed** — the core never joins on "who".

**Entity taxonomy** (the `{type}` values consumer #1 — JobLander — correlates
on, from `triage.py`/watcher reality; confirmed by `architect`):

| `type` | example `id` | emitted by | slice-0? |
|---|---|---|---|
| `gcp_instance` | `lk-au-southeast1`, `lk-eu-west4` | audit instance delete/create | ✅ |
| `region` | `australia-southeast1`, `europe-west1`, `us-central1`, `asia-south1` | audit (from zone/location), deploy | ✅ |
| `service` | `joblander-audio-engine`, `joblander-app`, `email-service` | audit Cloud Run deploy | ✅ |
| `repo` | `backend`, `joblander-app`, `chrome-extension`, `ai-voice-agent-python`, `email-service` | github PR merge | ✅ |
| `endpoint` | `lk-au.joblander.app`, `/health/output` | watcher scope | later (watcher slice) |

**Slice-0** (the dispatcher-gate cut: GitHub + audit + Linear) needs
`{gcp_instance, region, service, repo}` — exactly the AU-class join set.
`endpoint` lands with the later watcher slice.

The **entity extractor** — one small pure mapper per source, `raw payload →
change_entity[]` — is the heart of ingest quality. v1 extracts the
directly-named entity (the deleted instance, the deployed service, the merged
repo). "Which service does *this PR* touch" is a v2 enrichment (parse changed
paths → service/region, e.g. a diff to `cloudbuild.yaml` region list). Keeping
v1 shallow-but-correct beats a clever-but-wrong mapper. Notion docs often land
with **empty `entities`** — that is expected; the core fans them in by
`source=notion&since=` and text-matches in-engine, so no text index is built
here.

---

## 3. Per-source ingest design

All pollers run **inside one small `change-ingest` systemd service** (Node/TS,
`127.0.0.1:4200`) using `node-cron` internal schedules — mirroring the
dispatcher's own self-poll pattern (`dispatcher/src/poller.ts`), so there are
**no new crontab lines** and one process owns all writes to the store (single
writer). Each poller persists a **cursor** in the store (`ingest_cursor(source,
value)`), and every write is an idempotent `INSERT … ON CONFLICT(id) DO
NOTHING` on the source-prefixed `id` — so overlap on restart never
double-counts and a missed tick self-heals on the next poll.

### 3.1 GCP Cloud Audit Logs — **pull, 2-min cron** (the au-delete piece)

This is the source that would have caught the au delete, so it gets the most
care. See §4 for the full pipeline and IAM analysis. Transport: a `gcloud
logging read` of the Admin Activity audit log, exactly the subprocess pattern
`monitor/triage.py::gcloud_logging_read()` already uses (proven under the
minimal SA). Cursor = last seen `timestamp`; `--freshness` bounds the window.

### 3.2 CI/CD deploys — **pull, effect-based**

A prod deploy *is* an audit event: Cloud Run `google.cloud.run.v2.Services.*`
and (for JobLander's prod path) a Cloud Build run, both land in the same Admin
Activity log §4 already reads. So **deploys ride the audit-log poller for free**
— capturing the *effect* ("service X changed in region R") regardless of which
CI system (Cloud Build trigger on main, GitHub Actions) drove it. This is the
robust choice: it can't be bypassed by a CI reconfiguration. If build-level
granularity is later wanted (commit SHA, trigger name, duration), add a
`gcloud builds list --filter="create_time>cursor" --format=json` poll — still
zero new IAM (`logging.viewer` + the SA already reads Cloud Build via logs).
Cloud Build's auto-published `cloud-builds` Pub/Sub topic is the push
alternative (§4/v2).

### 3.3 GitHub PR merges — **pull, 5-min cron**

**Why not a webhook:** a GitHub webhook needs a public inbound endpoint. On this
VM that means either opening a port (violates the firewall invariant) or
routing `POST /ingest/github/*` through Caddy to the ingest service — doable
(Caddy already has a `handle_path` TODO stub in `deploy/caddy/Caddyfile`) but it
adds a public attack surface, an HMAC-verify path, and delivery-replay handling,
all to shave minutes off a latency the product doesn't care about. **Not worth
it for v1.** Poll instead.

**Mechanism:** for each tracked repo (`JobLander-app/backend`,
`/joblander.app`, `/chrome-extension`, `/email-service`,
`/ai-voice-agent-python`), `GET /repos/{owner}/{repo}/pulls?state=closed&
sort=updated&direction=desc&per_page=30`, keep those with `merged_at != null &&
merged_at > cursor`. Auth: the existing `self-healing-gh-token` (already on the
VM for clone + auto-merge). Cursor = max `merged_at` per repo. 5 repos every 5
min = 60 authenticated calls/hr, trivially under GitHub's 5000/hr.
Entity: `repo:<name>` + `actor:<merged_by>` (v1); path-derived service/region
is v2.

### 3.4 Linear — **pull, direct GraphQL**

The ingest cares about "issue moved to state X / was created" as a change
signal (an agent/human deciding to work something). Reuse `linear-api-key` and
the **exact** GraphQL-over-`fetch` pattern already in
`dispatcher/src/poller.ts::precheckCandidates()` (10s abort, fail-open). Query
issues `updatedAt > cursor`, emit `issue_status` ChangeEvents. No MCP needed for
this narrow read; the vendored `mcp/linear` stays the dispatcher's tool.

### 3.5 Notion — **pull, vendored MCP, slow cron**

Docs change rarely and are the weakest correlation signal, so this is lowest
priority. Use a vendored Notion MCP (stdio child, same shape as `mcp/linear`,
`mcp/firebase`) spawned by the ingest service on a slow (e.g. hourly) cron;
`search`/`query` for pages edited since cursor → `doc_edit` ChangeEvents. Needs
a `notion-api-key` secret if the project doesn't already have one. Defer to a
follow-up if Notion isn't in the first correlation cut.

---

## 4. Cloud Audit Logs pipeline (the au-delete detector) + IAM

### 4.1 What we ingest, and the exact filter

Three change classes, all in the **Admin Activity** audit log
(`cloudaudit.googleapis.com/activity`), which is **always-on and free**:

| Change | `protoPayload.methodName` |
|---|---|
| instance delete/create | `v1.compute.instances.delete` / `.insert` |
| Cloud Run deploy | `google.cloud.run.v2.Services.CreateService` / `.UpdateService` (+ v1 `ReplaceService`) |
| IAM change | `SetIamPolicy` (and `google.iam.admin.v1.*` for SA/key ops) |

Poll (2-min internal cron), mirroring `triage.py`:

```bash
gcloud logging read \
  'logName="projects/meet-assistant-6d8ad/logs/cloudaudit.googleapis.com%2Factivity"
   AND (protoPayload.methodName="v1.compute.instances.delete"
     OR protoPayload.methodName="v1.compute.instances.insert"
     OR protoPayload.methodName:"run.v2.Services"
     OR protoPayload.methodName="SetIamPolicy")
   AND timestamp>"<cursor-iso>"' \
  --project=meet-assistant-6d8ad --freshness=10m --format=json --limit=100
```

Extractor pulls `actor = protoPayload.authenticationInfo.principalEmail`,
`entities` from `protoPayload.resourceName` (e.g.
`.../instances/lk-au-southeast1` → `gcp_instance:lk-au-southeast1` +
`region:australia-southeast1` from the zone), `id = audit:<insertId>` (globally
unique, idempotent).

### 4.2 IAM analysis — **v1 needs NO new role**

This is the least-privilege headline. **Admin Activity and System Event audit
logs are readable with `roles/logging.viewer`** — the SA *already has it*. The
`logging.privateLogViewer` role is required **only** for **Data Access** audit
logs (which record data *reads* and live in a restricted bucket). We do **not**
ingest Data Access logs — instance deletes, Cloud Run deploys, and IAM changes
are all Admin Activity events. Therefore the entire v1 audit pipeline runs under
the **existing minimal SA with zero IAM delta**. (Caveat to record: if a future
change class needs Data Access logs — e.g. "who *read* secret X" beyond the
version-access events already in Admin Activity — that alone would justify
`logging.privateLogViewer`, and only then.)

### 4.3 Push alternative (v2 / scale): sink → Pub/Sub → pull subscription

Documented so the path is known; **not built in v1.** A
`google_logging_project_sink` with an audit-log filter → a `google_pubsub_topic`
→ a `google_pubsub_subscription` the ingest service **pulls** (still no public
port — pull, not push endpoint). This buys real-time + a durable 7-day buffer.
**IAM delta it would add:**
- the sink's auto-created **writer identity** → `roles/pubsub.publisher` on the
  topic (a `google_pubsub_topic_iam_member`, scoped to the one topic);
- the VM SA → `roles/pubsub.subscriber` on the subscription (one
  `google_pubsub_subscription_iam_member`, scoped to the one subscription).

Both are resource-scoped, not project-wide, so even the v2 upgrade stays
least-privilege. Take it only if a real-time correlation requirement appears.

---

## 5. Change store — SQLite on the VM

**Choice: SQLite** (single file, WAL mode) at `/var/lib/self-healing/changes.db`,
owned by `joblander`. Rationale against the alternatives:

- **vs JSONL append log:** the core query is *"entities of type T with id X in
  the last N hours"* — a filtered range scan. SQLite serves it from an index in
  µs; JSONL forces a full re-parse on every query. JSONL wins only on
  append-simplicity, which the idempotent-upsert requirement (dedupe on restart)
  erases anyway.
- **vs Prometheus:** Prometheus is a numeric time-series TSDB — it cannot store
  or query the categorical/relational shape of a ChangeEvent (actor strings,
  entity joins). Wrong tool, as the brief notes.
- **vs Postgres:** operationally heavier (a daemon, a data dir, backups) for a
  single-VM single-writer workload SQLite handles at zero ops cost. Postgres is
  the multi-tenant-future choice (§8), not now.

**Schema:** the three tables in §2 (`change_event`, `change_entity`,
`ingest_cursor`), plus indexes `change_event(ts)`, `change_entity(type,id)`.
Access from Node via `better-sqlite3` (synchronous, embedded, no server).

**Retention:** a daily prune (internal cron in the ingest service) deletes rows
`ts < now-90d`. 90 days is generous for hours-scale correlation and keeps the DB
tiny (a few thousand rows). The file is included in the existing
`gs://joblander-agent-logs/backups/` snapshot flow if durability is wanted;
losing it is non-fatal (a re-poll rebuilds recent history from the sources'
own retention).

---

## 6. Serving — read-only query API on localhost

The `change-ingest` service (single writer) also **exposes the read API** on
`127.0.0.1:4200` — so the same process that owns the DB serves it, no second
SQLite opener, no file-lock contention across processes. Consumers are
cross-language (the **monitor is Python**, the **dispatcher is Node**), so a
localhost HTTP contract is the clean seam both can hit with a plain GET (Python
`urllib`, already used in `triage.py`; Node `fetch`).

```
GET  http://127.0.0.1:4200/changes
       ?since=<epoch-ms>          -- required, lower bound on ts (inclusive)
       &until=<epoch-ms>          -- optional, upper bound on ts (inclusive); window is [since, until]
       &entity=<type>:<id>        -- optional, REPEATABLE — multiple = OR (ANY-match)
       &source=<source>           -- optional
       &kind=<kind>               -- optional
       &limit=<n=200>
     → 200 [ ChangeEvent … ]  ordered by ts DESC   (incl. intent_text + raw_ref, NOT raw payload)
GET  http://127.0.0.1:4200/healthz  → 200 {ok,lastPollBySource,rowCount}
```

**Bounded window `[since, until]`.** `until` is first-class (not just `since`):
the core windows on *both* ends — a correlation runs over `[detectedAt −
LOOKBACK, detectedAt + FWD]`, and a bounded upper edge is what makes the
deterministic AU-replay tests reproducible. Omitting `until` means "up to now".

**Repeated `entity=` is OR (any-match), resolved server-side in one round-trip.**
An anomaly carries several entities (the deleted instance *and* its region *and*
the affected service); the core sends them all —
`?entity=gcp_instance:lk-au-southeast1&entity=region:australia-southeast1&since=…&until=…`
— and gets the union back, rather than issuing N calls and unioning client-side.
Server-side this is a single `change_entity` lookup with an `IN`/`OR` over the
`(type,id)` pairs.

Correlation's core Stage-A candidate-gather becomes exactly:
`GET /changes?entity=…&entity=…&since=<detectedAt−72h>&until=<detectedAt+FWD>`.
Each row carries `intent_text` (the LLM's input) inline and `raw_ref` (a pointer)
for the rare human-escalation deep-link — the full raw payload is **never** on
this hot path. No auth on :4200 — it's localhost-only behind the same firewall
invariant as the dispatcher's :4100, Prometheus :9090, Grafana :3000.

The core maps `(source, kind)` → a coarse category (`deploy|infra|decision|doc`)
in its own engine for fail-safe logic; the store does not carry that category —
`kind` stays fine-grained here.

**Alternative considered:** the dispatcher opens the SQLite file read-only
itself. Rejected — it couples the dispatcher's release to the store schema and
gives the Python monitor no path in. A tiny HTTP seam decouples both consumers.

---

## 7. Terraform + init deltas

Reproducible-first, security posture unchanged. **v1 adds NO GCP resources and
NO IAM** — it reuses the SA, `logging.viewer`, `self-healing-gh-token`,
`linear-api-key`. Everything is VM-local.

**`init/init.sh`** — inside the existing `if [ -d "$SH_DIR" ]` block, alongside
the dispatcher build (§ step 9–10):
- `mkdir -p /var/lib/self-healing && chown joblander:joblander /var/lib/self-healing`
  (the SQLite data dir);
- build the ingest service: `(cd $SH_DIR/change-ingest && npm ci && npx tsc)`,
  fail-soft with an `add_todo` like the dispatcher;
- render `change-ingest/.env` from a Secret Manager secret (only if webhooks/
  Notion introduce secrets — v1 reuses the ambient `gcloud` ADC + reads
  `linear-api-key`/gh-token like the rest, so a `.env` may be unneeded);
- install + enable + start `self-healing-change-ingest.service`.

**`deploy/systemd/self-healing-change-ingest.service`** (new) — a `Type=simple`
unit, `User=joblander`, `ExecStart=/usr/bin/node
/home/joblander/self-healing/change-ingest/dist/index.js`, `Restart=always`,
`EnvironmentFile=…/.env` (if any) — cloned from the existing
`claude-code-vm-job-dispatcher.service`.

**No crontab change** — the pollers are internal `node-cron` in the service.

**Terraform:** unchanged for v1. The only place v1 *could* touch Terraform is if
Notion needs a new secret — then append `notion-api-key` to
`var.extra_secret_ids` in `modules/self-healing-vm/variables.tf` (per-secret
`secretAccessor`, the existing pattern). **v2 (push)** adds, all in the module:
`google_pubsub_topic`, `google_pubsub_subscription`,
`google_logging_project_sink`, the two resource-scoped IAM members from §4.3,
and (for GitHub webhooks) a `handle_path /ingest/github/*` block in
`deploy/caddy/Caddyfile` + the `self-healing-gh-webhook-secret` secret.

**Scrape note:** the ingest service can expose `selfheal_ingest_*` metrics
(rows, last-poll-age per source, poll errors) for the existing Prometheus, by
adding a `change-ingest` target on `localhost:4200` to
`deploy/prometheus/prometheus.yml` — a poll that silently stops is then visible
on the console. Recommended, cheap.

---

## 8. Secrets

| Secret | v1? | Flow |
|---|---|---|
| `self-healing-gh-token` | **reused** | already rendered by init; GitHub PR poll |
| `linear-api-key` | **reused** | already granted; Linear poll |
| (gcloud ADC) | **reused** | VM SA, no secret; audit-log poll |
| `notion-api-key` | only if Notion in v1 cut | Secret Manager → init → ingest `.env`; add to `extra_secret_ids` |
| `self-healing-gh-webhook-secret` | **v2 only** | Secret Manager → init; HMAC-verify GitHub webhooks behind Caddy |

Net new secrets for v1: **zero** (or one, `notion-api-key`, if Notion ships in
the first cut). Same Secret-Manager-→-init flow as everything else; no new
mechanism.

---

## 9. Failure modes & cost

**Failure modes**
- **Missed poll tick** (VM reboot, service crash) → next tick's `timestamp >
  cursor` / `merged_at > cursor` window catches up; idempotent `id` upsert
  dedupes overlap. No data loss within source retention.
- **Poller wedged / silent** → `selfheal_ingest_last_poll_age{source}` metric
  crosses a threshold → Prometheus/console shows it; optionally a dead-man
  metric like the watcher's `WATCHER_HEARTBEAT`. The ingest service must never
  block the dispatcher — separate process, separate failure domain.
- **Cursor corruption / clock skew** → cursors are advisory; the `id` PK is the
  real dedupe. A reset cursor re-ingests a window harmlessly.
- **GitHub rate limit** → 60 calls/hr vs 5000 budget; back-off on `403
  X-RateLimit-Remaining: 0` and skip the tick (fail-open, like the Linear
  pre-check).
- **gcloud logging read latency/failure** → same `collection_errors` soft-fail
  `triage.py` already uses; the tick logs and retries next beat.
- **Pub/Sub backlog** (v2 only) → subscription retains 7 days; a drained pull
  clears it; no loss.
- **Store growth** → bounded by the 90-day prune; realistic volume is a few
  thousand rows, sub-MB.

**Cost:** ~**$0 added**. Admin Activity audit logs are free to generate, store,
and read. `gcloud logging read`, GitHub API (under budget), and Linear GraphQL
are free at this volume. SQLite is local disk (negligible on the existing
50 GB boot disk). No new VM, no new managed service. v2 Pub/Sub sits inside the
free tier (first 10 GB/mo) at this event rate — pennies at most.

---

## 8-bis / 10. What a future multi-tenant cloud changes (noted, not built)

The single-VM design is deliberately consumer-#1-shaped (JobLander). For N
tenants you would: replace SQLite with a shared Postgres (or per-tenant
schemas); make ingest a horizontally-scalable service behind a real ingress
(then GitHub **webhooks** and a **Pub/Sub sink** become worth their complexity —
central, real-time, replayable); scope every ChangeEvent and query by
`tenant_id`; and move secrets to per-tenant Secret Manager entries or a vault.
None of that is warranted while there is one tenant on one locked-down VM — and
the pull-first, HTTP-seam, normalized-schema choices here all port forward
unchanged when it is.

---

## 11. Contract status (reconciled with `architect`, 2026-07-18)

Locked — no open boundary questions. Resolutions folded into the doc:

1. **Join key** — entity `{type,id}` + `ts` window + `source` are the indexed/
   first-class keys; `actor` on-row-but-unindexed; no free-text index (Notion
   fanned in by `source=notion&since=`). (§2, §6)
2. **`intent_text`** — added as a distilled ~2KB inline column the LLM judges on;
   `raw_ref` stays fetch-on-demand for raw payload. (§2, §6)
3. **`type` opaque** — generic `change_entity(type,id)` join table, never
   per-type columns (multi-consumer invariant). (§2, §5)
4. **Serving** — `until` upper bound + repeated `entity=` OR-match added. (§6)
5. **`ts`** — defined as effective-time-in-prod; decisions arrive as their own
   rows. (§2)

Remaining product decision (not a boundary question): **is Notion in the
slice-0 cut?** If yes, `notion-api-key` is a v1 secret (§8); if deferred, v1 has
zero new secrets. Slice-0 (dispatcher gate) is GitHub + audit + Linear, so Notion
can land in a later slice without blocking.
