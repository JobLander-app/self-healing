# change-ingest

Deterministic prod-**change** ingest + store + serving for the self-healing
loop's intent-correlation gate (Linear **JOB-731**). It answers one question for
the dispatcher: *"what intentional change touched entity X in the last N hours?"*
so the loop can tell a real incident from an expected side-effect of a decision
(the `lk-au-southeast1` decommission that fired a false P0 every run).

**No LLM inference lives here.** Ingest → store → serving is 100% deterministic.
The judgment ("is this anomaly explained?") is the dispatcher's own Claude CLI
session reading these rows — never a call from this package. See the repo
`CLAUDE.md` single-provider rule and `docs/DESIGN-change-ingest-infra.md`.

## What it does

A single Node/TS process (`127.0.0.1:4200`) that:

1. **Pulls** changes on internal `node-cron` schedules (no crontab lines):
   - **GitHub** PR merges (every 5 min) — closed PRs per tracked repo, `merged_at > cursor`.
   - **GCP Cloud Audit Logs** (every 2 min) — `instances.delete/.insert`,
     Cloud Run deploys, `SetIamPolicy`, via `gcloud logging read` (the au-delete detector).
   - **Linear** (every 5 min) — issues that reached Done/Canceled, incl. the closing comment.
2. **Normalizes** each into a source-agnostic `ChangeEvent` + entity rows (pure
   mappers in `src/extract.ts` — the unit-tested heart).
3. **Stores** them idempotently in SQLite (WAL) at `/var/lib/self-healing/changes.db`.
4. **Serves** a read-only query API the dispatcher (Node) and monitor (Python) both hit.

Every network/subprocess call is **fail-open**: an error yields `[]`, never a
throw into the cron loop; a missed tick self-heals next poll (idempotent `id` upsert).

## The `GET /changes` contract

```
GET http://127.0.0.1:4200/changes
      ?since=<epoch-ms>       # REQUIRED — lower bound on ts (inclusive); 400 if missing
      &until=<epoch-ms>       # optional — upper bound on ts (inclusive); window is [since, until]
      &entity=<type>:<id>     # optional, REPEATABLE — multiple = OR (any-match)
      &source=<source>        # optional — github | gcp_audit | linear
      &kind=<kind>            # optional — pr_merged | instance_delete | run_deploy | issue_status | …
      &limit=<n=200>          # optional
  → 200 [ ChangeEvent + entities[] … ]  ordered ts DESC   (incl. intent_text + raw_ref, NOT raw payload)

GET http://127.0.0.1:4200/healthz  → 200 { ok, lastPollBySource, rowCount }
```

A served row:

```jsonc
{
  "id": "audit:au-delete-0001",
  "source": "gcp_audit",
  "kind": "instance_delete",
  "ts": 1752800000000,               // epoch ms — EFFECTIVE time in prod
  "actor": "agent@joblander.app",
  "title": "v1.compute.instances.delete projects/…/instances/lk-au-southeast1",
  "intent_text": "v1.compute.instances.delete projects/…/instances/lk-au-southeast1",
  "raw_ref": "audit:au-delete-0001",
  "ingested_at": 1752803600000,
  "entities": [
    { "type": "gcp_instance", "id": "lk-au-southeast1" },
    { "type": "region", "id": "australia-southeast1" }
  ]
}
```

`type` in `entities` is **opaque text** — no per-type columns, so a new consumer
declares its own entity types with no store migration.

### The AU-incident query (for the dispatcher's INTENT GATE)

To gather candidates that might explain an `lk-au` anomaly detected at `T`:

```
GET /changes?entity=gcp_instance:lk-au-southeast1&entity=region:australia-southeast1&since=<T-72h>&until=<T+15m>
```

That returns both the audit `instances.delete` **and** the "Decommission lk-au"
Linear close, each with `intent_text` — enough for the dispatcher session to
conclude *explained → decline the fix*.

## Entity conventions

- **gcp_audit** → `gcp_instance` + `region` (from the zone) for instance ops;
  `service` + `region` (from the location) for Cloud Run deploys.
- **github** → `repo:<repo-name>` (the GitHub repo slug verbatim, e.g. `backend`,
  `joblander.app`).
- **linear** → labels of the form `type:id` map straight to entities
  (`region:australia-southeast1`, `service:joblander-audio-engine`,
  `instance:lk-au-southeast1` → aliased to `gcp_instance`, `repo:backend`).
  Labels without a recognized `type:` prefix are ignored (v1 stays shallow-but-correct).

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `CHANGES_DB` | `/var/lib/self-healing/changes.db` | SQLite file (use `:memory:` for ephemeral) |
| `INGEST_PORT` | `4200` | serving port (bound to `127.0.0.1` only) |
| `GCP_PROJECT` | `meet-assistant-6d8ad` | audit-log project + Secret Manager project |
| `LINEAR_TEAM` | `JobLander` | team whose closed issues are ingested |
| `TRACKED_REPOS` | the 5 JobLander repos | comma-separated `owner/repo` list |
| `GITHUB_CRON` / `GCP_AUDIT_CRON` / `LINEAR_CRON` | `*/5` / `*/2` / `*/5` | poll schedules |
| `PRUNE_CRON` / `RETENTION_DAYS` | `0 3 * * *` / `90` | daily retention prune |
| `AUDIT_FRESHNESS` | `15m` | `gcloud logging read --freshness` scan bound |
| `LINEAR_API_KEY` / `GH_TOKEN` | — | override Secret Manager (`linear-api-key` / `self-healing-gh-token`) |

Secrets resolve exactly like `dispatcher/src/poller.ts`: env var wins, else
`gcloud secrets versions access` once per process. The audit poll needs no
secret (ambient VM SA ADC, `roles/logging.viewer` — zero new IAM).

## Run / test

```bash
npm ci
npm run build          # tsc → dist/
npm start              # boots the service on 127.0.0.1:4200

npm run seed           # insert the AU incident into CHANGES_DB for a manual demo
npm test               # tsc -p tsconfig.test.json && node --test (AU replay + extractor units)
```

`better-sqlite3` is a native module; `npm ci` builds it. `npm test` needs that
build to succeed. Everything else (extract mappers, routing logic) is pure TS.
