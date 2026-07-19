# DESIGN: Intent Correlation — the missing core of the self-healing loop

**Status:** proposed (design only). **Author:** architect. **Date:** 2026-07-18.
**Scope:** a new reusable layer that sits between the loop's *detection* and its
*actions* (page / file ticket / autonomously fix), and judges whether an anomaly
is *explained by a recent intentional change* before the loop reacts.

---

## REVISION 2026-07-18 — single-provider rule supersedes the "separate judge"

Owner directive, now `CLAUDE.md`: **LLM inference happens only through the same
Claude CLI already on the VM, or not at all — no external LLM API.** This changes
*how* the judgment is made (not *what* it decides), superseding the parts of §3.2 /
§4.3 / §4.4 / §7 that assumed a standalone Messages-API "judge":

- **The judgment is the dispatcher agent's own reasoning**, not a separate model
  call. The Claude CLI session that already investigates an incident reads the
  pre-gathered candidate changes as one more source (like logs / Linear) and
  concludes `explained → decline / unexplained → fix`. Same session, same token.
- **`correlate()` splits into a deterministic half and the agent's half.** The
  reusable component ships **only** the deterministic Stage-A candidate gather
  (`GET /changes` + time/scope filter) + the `Verdict` type. There is **no
  `judge.ts`, no Messages-API call, no `correlate/` inference service.** Stage-B
  judgment lives in the agent's constitution (§4.3.2, the INTENT GATE).
- **Slice 0 wires exactly one consult point: the dispatcher INTENT GATE.** The
  out-of-agent *LLM* pre-check in §4.3.1 is dropped; the pre-check that remains is
  purely deterministic (gather candidates, attach to the agent's context). If zero
  candidates → skip straight to fixing as today. The agent is always the judge.
- **Watcher (later slice) has no agent**, so it may only do the deterministic
  gather and *annotate* the page ("N recent changes touch this entity") — it never
  suppresses on an LLM verdict. Suppression judgment lives where a Claude session
  already runs: the **monitor** (`run-monitor-session.sh`) and the **dispatcher**.
- **§7 open-question #2 is resolved by the rule:** no separate judge, so no judge
  model / cost-budget decision remains. SQLite change-store stays (it is
  deterministic state, not inference).

Read the rest of this doc with that substitution in mind: wherever it says "the LLM
judge" / "Stage-B call," read "the Claude CLI agent's reasoning over the candidates."

---

## 0. Why this exists (the one incident that proves it)

`monitor/triage.py` hard-codes the world it watches:

```python
# triage.py:27-40
REGIONS = ["europe-west1", "us-central1", "australia-southeast1", "asia-south1"]
# lk-au-southeast1 removed 2026-07-18: it has no running GCE instance ...
# monitoring a phantom fired a false P0 every run.
LK_URLS = { "lk-eu-west4": ..., "lk-us-central1": ..., "lk-asia-south1": ... }
```

`lk-au-southeast1` was **intentionally decommissioned**. That decision lived in:
- a **cloud audit-log** `v1.compute.instances.delete` event (works even with no IaC),
- a **closed Linear ticket** ("decommission AU"), and
- a **Notion doc** (the regional-footprint decision).

The monitor consulted **none of them**. `check_lk_health()` polled the dead URL,
got a non-200, synthesized a `lk-server:...:down` group, and fired a **false P0
every run** until a human hand-edited the list. Worse: with the downstream region
map fixed, the **dispatcher would have autonomously "fixed" a server that does not
exist** — burning money and possibly re-provisioning something the org decided to
kill.

The comment in `triage.py` already reaches for the wrong fix:

> ROOT FIX (tracked): derive this list from reality (VMs that emit gcplogs recently).

**Reality-polling is not enough, and this is the whole thesis.** Reality tells you
*what exists*, never *what was intended*. A VM that is down for an intentional
decommission and a VM that is down because it crashed look **identical** in
reality. Deriving the watch-set from live VMs would silence *this* phantom, but a
VM intentionally stopped for maintenance would still page, and a VM that crashed
right after someone *happened* to touch it would be wrongly suppressed. Only the
**intent stream** — merges, deploys, audit logs, tickets (incl. closed), docs —
disambiguates "down because someone meant to" from "down because it broke."

Thresholds and health-checks cannot read a closed-ticket comment or a Notion doc
and judge "yes, this explains the AU removal." **An LLM can.** That judgment is the
moat, and it is missing from the loop today.

---

## 0.1 Boundary contract with change-ingest infra (devops)

Ingest + storage + serving is owned by the change-ingest infra design
(`docs/DESIGN-change-ingest-infra.md`, devops). This doc owns only the
**correlation engine that reads** it. The locked boundary (reconciled 2026-07-18):

- **Row shape:** `id` (source-prefixed), `source`, `kind` (fine-grained), `ts`
  (epoch ms = **when the change took effect in prod**), `actor`, `entities`
  (`[{type,id}]`), `title`, **`intent_text`** (bounded ~2KB NL essence — see §1.2,
  load-bearing for the moat, distilled at ingest so correlation never fetches raw
  on the hot path), `raw_ref` (provenance / off-hot-path deep-link).
- **Serving:** read-only local HTTP `GET /changes?since=&until=&entity=&source=&limit=`
  on the dispatcher; repeated `entity=` params are OR'd; results ordered `ts desc`.
- **Storage genericity:** entities live in a generic `change_entities(change_id,
  type, id)` join table indexed on `(type, id)` — `type` is **opaque text**, never
  per-type columns, so onboarding a consumer with unknown entity types needs no
  store migration (§5). Indexed query dims are `(type,id)`, `ts`, `source` only;
  `actor` and free-text are not indexed.
- **Timestamps:** a single `ts` (effective-time) per row; a decision that precedes
  its effect (closed ticket → later VM delete) is a **separate row**, so temporal
  spread comes from the stream, absorbed by the 72h candidate LOOKBACK (§3.2) — not
  from two columns. This supersedes the `decidedAt`/`effectiveAt` split sketched in
  §1 below; §1 keeps both names only as the conceptual distinction.

---

## 1. The change/intent model — `ChangeEvent`

One normalized record. Every heterogeneous source maps into it; the correlation
engine only ever sees `ChangeEvent`s, never source-specific shapes. (The
persisted/served row shape is devops's — §0.1; below is the engine's conceptual
view, which the served row satisfies.)

```ts
interface ChangeEvent {
  id: string;              // stable dedup key: `${source}:${sourceId}`
  source: string;          // "github" | "gcp-audit" | "linear" | "notion" | "cloudbuild" | "aws-cloudtrail" | ...
  kind: "deploy" | "infra" | "decision" | "doc";
  actor: string | null;    // who: git author, gcp principalEmail, ticket assignee, doc editor
  decidedAt: string;       // ISO — when the intent was recorded (merge time, ticket close, doc edit)
  effectiveAt: string | null; // ISO — when it hit prod, if distinct (deploy finish, audit-log delete ts)
  targets: EntityRef[];    // STRUCTURED scope — the join keys (see §1.1). May be [] (unknown scope).
  intentText: string;      // UNSTRUCTURED natural language — the moat's input (see §1.2)
  url: string | null;      // provenance: PR link, ticket link, audit-log resource, doc link
  raw?: unknown;           // original payload, for audit; never fed to the LLM wholesale
}

interface EntityRef {
  type: "region" | "service" | "resource" | "repo" | "host" | "endpoint" | "custom";
  value: string;           // normalized: "australia-southeast1", "joblander-audio-engine", "lk-au-southeast1"
}
```

### 1.1 `targets` — the deterministic join surface

`targets` is what lets a cheap pre-filter narrow thousands of changes to a handful
*before* the LLM is ever invoked. Sources populate it best-effort:
- **GitHub PR merge** → `repo` (always), plus `service`/`region` parsed from changed
  paths and labels (JobLander already routes tickets by repo label —
  `LINEAR.lblRepoBackend` in `watcher/src/config.ts`).
- **GCP audit log** → `resource` + `region` from the audit entry
  (`resource.labels`, `protoPayload.resourceName`) — e.g. the `instances.delete`
  on `lk-au-southeast1` yields `{resource: lk-au-southeast1}` + `{region: australia-southeast1}`.
- **Linear ticket** → `service`/`region`/`repo` from labels + title/body extraction.
- **Notion doc** → usually `[]` or coarse (`region`), because docs are prose. Docs
  lean on `intentText` matching, not `targets`.

An empty `targets` does **not** disqualify a change — it just means it can only be
matched by text similarity in the candidate stage, at higher cost.

### 1.2 `intentText` — what the LLM actually reads

The natural-language essence: PR title+body, ticket title+description+**closing
comment**, doc section text, audit-log method name (`v1.compute.instances.delete`).
This is the field thresholds can't use and the LLM can. Kept bounded (truncate to
~2k chars/change) so a candidate set of ~10 changes is one cheap LLM call.

### 1.3 `decidedAt` vs `effectiveAt`

A decision (ticket closed "decommission AU" at T0) and its effect (VM deleted at
T0+2d) can be days apart. Candidate gathering (§3) windows on **both**: an anomaly
at time A can be explained by a decision made well *before* A whose effect only
now surfaced. This is why "reality-polling now" fails and a *durable change log*
is required.

---

## 2. Ingest — sources, capture method, realism on one VM

Principle: **pull-first**, append into a durable local store; push (webhooks) is an
opt-in optimization, never a requirement. Pull survives a VM restart replaying
`since=lastCursor`; a missed webhook is gone. The loop already runs everything on a
single Terraform-managed VM (`self-healing-1`) with a minimal SA — the ingest plan
respects that.

| Source | Kind | Method (recommended) | Auth (already present?) | Push option |
|---|---|---|---|---|
| **GitHub PR merges** | deploy/decision | Poll `gh pr list --state merged --search "merged:>{cursor}"` per target repo, every 5–10 min | `self-healing-gh-token` secret (already used for clone + auto-merge) | GitHub App webhook → Caddy ingress (Caddy already terminates TLS) |
| **GCP Cloud Audit Logs** | infra | Poll `gcloud logging read 'logName=~"cloudaudit.googleapis.com%2Factivity"' --freshness` | SA already has `roles/logging.viewer` — **nothing new to grant** | Log sink → Pub/Sub push |
| **CI/CD deploys (Cloud Build)** | deploy | Poll `gcloud builds list --filter "status=SUCCESS" ` (or treat the merge event as the proxy — JobLander deploys on main merge) | same SA `logging.viewer` / `cloudbuild.builds.viewer` | Cloud Build Pub/Sub |
| **Linear (incl. closed)** | decision | Vendored `mcp/linear` — `list_issues`/`search_issues` with state incl. `Done`/`Canceled` + `list_comments`; poll updatedAt cursor | `linear-api-key` (never-expires) — **already wired** in `dispatcher/src/session.ts` | Linear webhook |
| **Notion / Confluence** | doc | Notion MCP — `search` recently-edited pages + `fetch`; poll last-edited cursor | Notion connector (available per brief) | Notion has no robust push |

**Realism on the current deployment.** GitHub-poll, GCP-audit-poll, and
Linear-poll need **zero new infrastructure and zero new IAM** — they reuse the
exact credentials the loop already holds. That is deliberate: the first slice (§6)
is buildable this week without touching Terraform. Notion-poll adds one connector.
Webhooks are deferred; the poll cadence (5–10 min) is far finer than the decision
horizon that matters (decommissions are decided hours-to-days ahead), so latency is
a non-issue.

**The store.** Correlation needs a change log that is *queryable by time window and
scope* — reality-polling explicitly cannot satisfy this (see §1.3). Recommend
**SQLite on the VM** (`/var/lib/self-healing/changes.db`): one file, reproducible
from `init/init.sh`, cheap indexed queries on `(effectiveAt, decidedAt)` and a
`change_targets(change_id, type, value)` join table. This is a deliberate,
scoped exception to the dispatcher's "no DB" ethos (`dispatcher/src/config.ts`
header) — the dispatcher stays stateless; **correlation is a distinct component**
whose entire job is remembering intent over time, which is inherently stateful.
Retention: 30–90 days (decommission decisions rarely need a longer lookback).
See open question #2.

Each puller is a small module: `pull({ since }) → ChangeEvent[]`, plus a persisted
cursor. Pullers are **independent and fail-isolated** — a Notion outage must never
stall the GitHub puller (same discipline as `runSafely` in `processSample.ts`).

---

## 3. The correlation engine

One entry point, consumed by all three loop stages:

```ts
correlate({ anomaly }): Promise<Verdict>
```

### 3.1 The anomaly (normalized input)

```ts
interface Anomaly {
  source: "watcher" | "monitor" | "dispatcher";
  signal: string;          // "lk-au down" | "output dropped region=... " | "5xx signature X"
  entities: EntityRef[];   // the scope to join on — region/service/resource/host
  detectedAt: string;      // ISO
  severity?: "P0" | "P1" | "P2";
}
```

All three stages already have this data in hand: the watcher has the failing
region from `renderRegions(sample.bodyText)`; `triage.py` groups carry
`service`/`region`/`signature`; the dispatcher has the ticket's service/region.

### 3.2 Two-stage judgment — cheap filter, then LLM

**Stage A — candidate gathering (deterministic, no LLM).**
1. **Time window:** changes with `decidedAt` OR `effectiveAt` in
   `[detectedAt − LOOKBACK, detectedAt + FORWARD]`. Defaults: `LOOKBACK=72h`
   (a decommission is decided before it surfaces), `FORWARD=15m` (a change landing
   just after detection). Tunable per consumer.
2. **Scope match:** any `anomaly.entities` overlaps a `ChangeEvent.targets` value
   (region/service/resource/host), OR — for zero-`targets` changes (docs) — a
   lightweight text-contains on the entity values. Narrows thousands → typically
   <20 candidates.

If **zero candidates** → short-circuit to `verdict: "unexplained"` with no LLM
call (cheap, and the correct answer — nothing intentional is on record). This is
the analog of `poller.ts`'s pre-check that skips the agent when there's no work.

**Stage B — LLM judgment (the moat).** Feed the anomaly + the candidate
`intentText`s (with `source`, `kind`, `decidedAt`, `url`) to a single bounded LLM
call. Strict output contract:

```jsonc
{
  "verdict": "explained" | "unexplained" | "needs-human",
  "confidence": 0.0,                 // 0..1
  "explainingChangeIds": ["gcp-audit:...","linear:JOB-741"],  // [] unless explained
  "rationale": "one sentence: why this change accounts for (or fails to account for) the anomaly",
  "consultedSources": ["github","gcp-audit","linear"]         // provenance / degradation (see §5)
}
```

- **explained** — a recent intentional change accounts for the anomaly. *(AU: closed
  ticket "decommission lk-au" + audit `instances.delete` on the AU VM → "lk-au down"
  is expected, confidence high.)*
- **unexplained** — candidates exist but none plausibly account for it → treat as a
  genuine incident.
- **needs-human** — candidates are partial/ambiguous/conflicting; the model is not
  confident either way.

The judge is **read-only and bounded** (no autonomous tools required — candidates
are pre-gathered). Recommend a single-turn Messages-API call (cheapest, fast,
deterministic to reason about) rather than a tool-wielding Agent-SDK session; if a
consultation needs to pull a *fresh* Notion page mid-judgment, that's a Stage-A
gap to fix, not a reason to give the judge write-capable tools. See open
question #2 for the model/authority choice.

### 3.3 Fail-safe — the asymmetry (this is the crux)

The brief's central tension: *when uncertain, suppress or escalate?* The answer is
**different for a human page than for an autonomous fixer**, and conflating them is
the trap.

- A **human page** exists to catch the unknown. The catastrophic failure is a
  **missed real outage** (JOB-651: 19h silent). A false page costs a human 10
  seconds. Therefore paging **fails toward firing**: it is suppressed *only* on
  `explained` **with high confidence**. `unexplained` and `needs-human` both page.
- An **autonomous fixer** performs near-irreversible actions (writes code,
  auto-merges to prod, could re-provision a killed server, burns money). The
  catastrophic failure is **acting on a change that was intentional**. Therefore
  fixing **fails toward NOT acting**: it proceeds *only* on `unexplained` **with
  high confidence** (positively confirmed nothing intentional explains it) — AND
  only after the existing freshness gate. `explained`, `needs-human`, and any
  low-confidence verdict → **do not fix, escalate to a human**.

> **One line:** the page fails open (fire on doubt); the fixer fails closed (freeze
> on doubt). Correlation feeds both from the same verdict; each applies its own bar.

This also answers the sharpest risk (open question #1): correlation must **never
fully silence a page on its own judgment**, because a wrong `explained` would
re-create the exact silent-failure the product exists to kill. Recommended concrete
rule for the watcher: a high-confidence `explained` **downgrades** the page (mute
the P0 Telegram, still record a low-priority "likely-explained by X" line + still
run the RECOVERED path), rather than deleting it. The owner sets where that bar
sits per consumer.

Confidence thresholds are **config, not code** — defaults `PAGE_SUPPRESS=0.85`,
`FIX_PROCEED=0.85`; a consumer can set `FIX_PROCEED=1.01` to make the fixer
*never* auto-act and always escalate (pure advisory mode) during onboarding.

**Correlation itself fails open.** If the engine errors or times out, every stage
behaves exactly as it does today (page / file / the fixer's own freshness gate
decides). Correlation may only ever *add* a suppression/annotation; it can never
*blind* the loop — same contract as `poller.ts` pre-check and `processSample.ts`
best-effort effects.

---

## 4. Integration into the existing loop (minimal changes)

Three consult points, each an **additive, injected, fail-open** effect. No stage's
core logic changes.

### 4.1 Watcher — before paging (`watcher/src/processSample.ts`)

The pure `decide()` core stays byte-for-byte identical. The watcher must stay fast,
so correlation is a **new injected effect with a tight timeout**, consulted only on
the `decision.shouldPage` branch, *before* `notifyOwner`:

```ts
// new TickEffects member (best-effort, timeout ~5s, fail-open):
correlate?: (input: { anomaly: Anomaly }) => Promise<Verdict>;
```

On `shouldPage`: call `correlate`. If it returns `explained` with confidence ≥
`PAGE_SUPPRESS` → emit the downgraded line (§3.3) instead of the P0 page; still
file/annotate as low-priority per §4.2. Otherwise page exactly as today, attaching
the one-line rationale to the P0 text ("no intentional change on record"). State
persistence, ordering, and the RECOVERED path are untouched. On timeout/error →
page as today.

*Prevents:* the AU false-P0-every-run.

### 4.2 Monitor — before filing a ticket (`monitor/triage.py` → escalations)

`triage.py` stays a deterministic collector. Add a **correlation pass between
triage and escalation**: after `build_escalations()` produces items with an
`action` (`telegram_p0_and_linear`, `linear_create_if_no_dup`, …), correlate each
non-`report_only` escalation and attach a `correlation` field. Simplest wiring: a
small `correlate` call (HTTP to the local engine, or a `correlate.py` shim) that
annotates `triage-summary.json`. The LLM monitor session
(`run-monitor-session.sh`) then reads that field and, per its runbook step C,
**downgrades `explained`-high escalations to `report_only`** (no Linear create,
no P0 Telegram) while still paging/filing everything else. The AU synthetic
`lk-server:...:down` P0 group would carry `explained` and never escalate.

*Minimal change:* one new field on each escalation + one runbook clause; the P0
alert-text path (`build_escalations`, verbatim `alert_text`) is otherwise intact.

### 4.3 Dispatcher — before autonomously fixing (highest stakes)

Two layers, defense-in-depth:

1. **Out-of-agent pre-check (like the cost pre-check in `poller.ts`).** Before
   spawning the fixer on a claimed ticket, `correlate({anomaly=<ticket's signal>})`.
   If `explained`-high → the dispatcher **does not fix**: it comments the verdict on
   the Linear ticket, closes it `not-a-bug`/`stale` ("explained by intentional
   change JOB-741 + audit delete"), and sends the `✅ investigated` Telegram. No LLM
   fixer run, no money burned. This is the concrete AU win.
2. **In-agent INTENT GATE (constitution).** Extend `dispatcher/CLAUDE.md` Step 3.5
   (FRESHNESS GATE) with a mandatory **Step 3.6 INTENT GATE**: before writing any
   fix, the agent must confirm the anomaly is `unexplained` (query the change log /
   run the audit-log lookup) — it may fix **only** on high-confidence `unexplained`;
   any `explained`/`needs-human` → close without a code change and escalate. Wired
   the same way the freshness thresholds are injected today
   (`session.ts` `freshnessPolicy` string) — thresholds stay tunable via env.

*Prevents:* the fixer "repairing" a decommissioned server.

### 4.4 New component footprint

```
correlate/            new package (TS): ingest pullers, SQLite store, correlate() engine,
                      HTTP :4200 (/correlate, /changes, /health) + a thin CLI for triage.py.
  src/model.ts        ChangeEvent / EntityRef / Anomaly / Verdict types
  src/store.ts        SQLite: changes + change_targets, cursors; time+scope queries
  src/ingest/*.ts     github.ts gcpAudit.ts linear.ts cloudbuild.ts notion.ts (one pull() each)
  src/candidates.ts   Stage-A deterministic filter
  src/judge.ts        Stage-B bounded LLM call + strict Verdict parse (mirror parseDispatchResult)
  src/routes.ts       /correlate consumed by watcher, monitor shim, dispatcher pre-check
```

Runs as one more systemd unit + a poll cron on the same VM, provisioned by
`init/init.sh` and Terraform — identical operational model to `dispatcher/` and
`watcher/`.

---

## 5. Consumer-agnostic by construction

The loop is already consumer-pluggable via the **detector** contract (README). This
design adds a second pluggable surface — **intent sources** — and keeps everything
else generic.

- **Onboarding = "connect your intent sources."** A consumer declares, in a small
  config, which sources exist and how to reach them (tokens in their secret store)
  plus an **entity map**: how their anomaly scope names line up with change target
  names (JobLander's reference map: Cloud Run service ↔ repo label ↔ region ↔ LK
  host). Everything else — the ChangeEvent shape, the candidate filter, the LLM
  judge, the three consult points — is consumer-independent.
- **Every source is optional; the design degrades gracefully.** A customer with
  **only GitHub + cloud audit logs** (no Linear, no Notion, no IaC) still works:
  fewer candidate sources simply yields more `unexplained`/`needs-human` verdicts,
  never a crash. The `consultedSources` field in every `Verdict` makes the
  degradation **auditable** — "explained by GitHub PR #262" vs "no doc source
  connected; could not check design decisions." A consumer with **zero** intent
  sources gets `unexplained` always → the loop behaves **exactly as it does today**
  (page + file + fix). Correlation is strictly additive: it can only ever *withhold*
  a reaction, and only when it has positive evidence.
- **Nothing JobLander-specific leaks into the engine.** JobLander's region list,
  LK hosts, and repo labels live entirely in the consumer's entity-map config and
  the pullers' scope-extraction — never in `correlate/src/{judge,candidates,model}.ts`.
- **Bonus, same primitive:** intent can also *seed the watch-set*, retiring the
  hard-coded `REGIONS`/`LK_URLS` in `triage.py`. A region with a recent
  decommission decision + audit delete is dropped from monitoring automatically —
  the "derive from reality" comment's real fix is "derive from reality **filtered by
  intent**." Out of scope for slice 0, but the model supports it for free.

---

## 6. Build phasing — smallest slice that kills the AU class first

**Slice 0 — prevent the AU class end-to-end, minimum surface (ships first).**
Buildable now with **zero new infra/IAM** — reuses `self-healing-gh-token`,
`linear-api-key`, and the SA's `logging.viewer`.
1. `ChangeEvent` model + SQLite store.
2. Three pullers: **GitHub merged PRs**, **GCP Cloud Audit Logs**, **Linear
   (incl. closed)**.
3. `correlate()` = Stage-A filter + Stage-B single LLM call.
4. Wire **one** consult point: the **dispatcher out-of-agent pre-check** (§4.3.1) —
   the highest-stakes, most concrete win. The fixer now refuses to act on a
   confidently-explained ticket (lk-au down → explained by audit delete + closed
   ticket → close `not-a-bug`, no money burned).

Slice 0 is demonstrably testable against the real AU incident: replay the ticket +
the audit-log delete + the closed Linear ticket → expect `explained`-high → fixer
declines. This one slice proves the thesis.

**Slice 1 — stop crying wolf at the source.** Add the **watcher** consult (§4.1):
high-confidence `explained` downgrades the P0 page. Kills the false-P0-every-run.

**Slice 2 — quiet the monitor.** Add the **monitor** escalation annotation (§4.2):
`explained`-high P1/P2 escalations drop to `report_only`.

**Slice 3 — broaden sources & generalize.** Notion + Cloud Build deploy + AWS
CloudTrail pullers; the onboarding entity-map config; provenance surfaced in the
Grafana console. This is where the product becomes genuinely multi-consumer.

Each slice is independently shippable and independently valuable; each only ever
*adds* a fail-open consult.

---

## 7. Open questions / risks for the coordinator

1. **The suppression bar (the load-bearing risk).** Correlation can *withhold* a
   reaction — a **wrong `explained` re-introduces the JOB-651 silent failure**, the
   very thing this product exists to prevent. My strong recommendation: the watcher
   **never fully deletes a page** on its own judgment (only downgrades P0→logged
   line), and only the **fixer** truly suppresses action (because *there* the safe
   default is inaction). Does the owner accept "page always fires on non-explained,
   fixer freezes on non-unexplained," and where exactly do the confidence bars sit
   (defaults 0.85 / 0.85)?

2. **Store + judge authority, against the "no-DB" ethos.** Correlation is
   inherently stateful (remembering intent over days) — it needs a queryable change
   log, which reality-polling cannot be. I recommend **SQLite on the VM** (a scoped
   exception; the dispatcher stays stateless) and a **bounded single-turn Messages
   judge** (cheapest, no autonomous tools). Owner sign-off needed on both, and on
   the judge model/cost budget (this call runs on every P0 page and every fixer
   pickup).

3. **Notion/Linear scope & lookback.** Closed tickets and docs are large and
   unstructured. Do we index **everything** or only **recently-updated + scope-tagged**
   pages/tickets, and how far back is "recent enough" (decommission decisions can be
   weeks old, arguing for a longer lookback than the 72h candidate window — i.e. the
   *store* retention and the *candidate* window are different knobs)? This decides
   ingest cost and how much of the AU-class we actually catch.
