# Validation

Run `npm ci`, `npm run build` and `npm test` in dispatcher, watcher and
change-ingest. Run `npm ci && npm test` in watchdog. Check vendored MCP JavaScript syntax
with `node --check`; these packages do not currently have test scripts.
Run Python tests in monitor, config and deploy/test, plus selected consumer tests.
Run shellcheck on deploy/bin/*.sh and the Terraform apply wrapper; render units
before systemd-analyze verify. Initialize Terraform with `-backend=false` and
validate both the generic root and any changed consumer root. Do not apply.

The false-positive tests cover exact signatures, severity overrides, archived
pagination, removed labels, queue exclusion, atomic ticket updates and interrupted
delivery, 24-hour/30-day boundaries, independent confirmation counts, duplicate
rejection, cycle reset and stable retry timestamps. Harness tests use synthetic executables/events and do not consume paid
model access. Deployment tests inject failures and verify exact rollback.

Before production enablement separately demonstrate actual provider authentication,
a test-ticket lifecycle, alert delivery, console auth, telemetry and restart
recovery on the target VM. Keep that evidence distinct from local unit tests.
