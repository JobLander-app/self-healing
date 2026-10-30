# Change feed

Deterministically ingest GitHub PR merges, GCP audit changes and closed Linear
issues into a local SQLite database. The dispatcher queries this feed to check
whether an anomaly follows an intentional deployment or retirement. Ingestion
and normalization make no model calls.

Configuration comes from the consumer profile: `TRACKED_REPOS`, `GCP_PROJECT`,
`LINEAR_TEAM`. Credentials are scoped GitHub/Linear keys or GCP service identity.
The API binds to localhost:4200. SQLite requires no separate database service;
back up its file using SQLite's backup facility, not a partial copy during writes.

```sh
npm ci
npm run build
npm test
```

The seed command is a synthetic retirement fixture for development, not a
production migration. Never seed sample events into a production change feed.
