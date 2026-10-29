# Change-feed infrastructure

The change feed runs as the consumer's Linux account on localhost:4200 and stores
normalized events in local SQLite. It shares scoped log-read access and named
GitHub/Linear secrets. There is no public database or endpoint and no model call.

A separate SQLite process is not required. Persistent disk, consistent database
backups and ingestion coverage markers are required for recovery. Source failures
must not advance coverage, because doing so would present a missing interval as
proof that no intentional change occurred. See the source-adapter regression tests
and [operations](OPERATIONS.md).
