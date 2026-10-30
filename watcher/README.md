# Product-output watcher

Runs once per minute. The consumer selects `WATCH_URL` (origin), `WATCH_PATH`
(default `/health/output?window_min=30`) and `WATCH_THRESHOLD` (default 3 successive
bad samples). It persists an incident and delivery outboxes, sends one page,
creates a Linear monitor issue, wakes the dispatcher and reports recovery.

The endpoint must return HTTP 200 and JSON `status: "pass"` for a healthy
sample. Any non-200 or other status is unhealthy. When there is no product input, the endpoint must explicitly decide whether
the invariant passes; do not use a distinct status to bypass the detector. Define the input/output invariant in the
consumer policy. Optional `regions` maps region names to `{verdict, reason}`.

Authorization is `HMAC <unix-seconds>:<hex-signature>`, where the signature is
HMAC-SHA256 of `GET\n<path-without-query>\n<unix-seconds>` using `WATCH_HMAC_SECRET`.
The server must verify the signature and freshness. Empty/invalid responses and
network failures are unhealthy, not proof of a particular product defect.

`DRY_RUN=true` suppresses external effects. `FORCE_BAD=1` is an explicit test hook,
never a production cron setting. The sample timeout is 90 seconds and cron uses a
lock to prevent overlapping samples. A successful tick publishes its heartbeat;
an external watchdog notices missing heartbeats independently of this process.

```sh
npm ci
npm run build
npm test
```
