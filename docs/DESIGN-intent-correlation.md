# Intent correlation

An error after a deployment, region retirement or service shutdown may be an
expected change. Deterministic ingestion records GitHub merges, GCP audit events
and closed Linear decisions with timestamps and entity keys. The dispatcher's
existing investigation uses that evidence before proposing a repair. There is
no extra inference stage.

Use the canonical service/region/instance/repository keys and inspect source
records. Temporal proximity alone does not prove intent. An unavailable or
ambiguous feed does not authorize restoring a retired resource. Report a blocker
or gather explicit read-only source evidence. See [change-ingest](../change-ingest/README.md).
