# Postmortem — six days blind: the loop lost its network and nothing could tell

**Incident window:** 2026-08-26 12:08 UTC → 2026-09-01 21:53 UTC (6 days 9 h 45 min)
**Impact:** the self-healing loop produced nothing for six days. No watcher ticks
reached Cloud Logging, no hourly monitor triage, no dispatcher runs, no tickets.
JobLander production ran unmonitored by this loop for the whole window — the
JOB-651 class of silent output failure would not have been caught.
**Detected by:** the owner, by hand. Every automated mechanism that should have
detected it was itself disabled by the failure.
**Root cause:** an uncapped dispatcher session exhausted host memory; during the
resulting stall systemd-networkd's DHCPv4 renewal timed out, the link went
`Failed`, and when the lease expired the address was removed. The host stayed
perfectly healthy — and completely unreachable.

---

## What actually happened

The VM was never frozen. Every daemon on it ran normally for six days. It simply
had no network, and every path by which it could have said so ran over that
network.

| Time (UTC) | Event | Evidence |
|---|---|---|
| 08-26 10:01 | Monitor files JOB-909 | Linear |
| 08-26 ~10:45 | Dispatcher picks it up, session grows | dispatcher logs |
| 08-26 10:50–11:30 | **Page-cache thrash: 48.4 GB read per 5 min** (~161 MB/s, PD line rate) for 40 min | `compute.googleapis.com/instance/disk/read_bytes_count` |
| 08-26 **11:09:21** | **`ens4: Could not set DHCPv4 address: Connection timed out` → `ens4: Failed`** | journal, boot -2 |
| 08-26 11:26:01 | Global OOM kill: `node`, 1.5 GB anon-rss, cgroup `/system.slice/claude-code-vm-job-dispatcher.service`, `constraint=CONSTRAINT_NONE` (no cgroup limit) | `kern.log` |
| 08-26 11:49 | Dispatcher — restarted, memory pressure gone — **merges PR #348 and fixes prod** | Linear JOB-909 |
| 08-26 12:00:48 | Dispatcher posts its verification comment | Linear |
| 08-26 12:08:07 | **Last `WATCHER_HEARTBEAT` to reach Cloud Logging** | Cloud Logging |
| 08-26 12:09:23 | `dial tcp 169.254.169.254:80: connect: network is unreachable` — the lease has expired, the address is gone | journal |
| 08-26 → 09-01 | Cron ticks every minute, watcher runs, CD timer runs, change-ingest fails open. All of it invisible. Egress: **0 bytes for six days** | journal + `network/sent_bytes_count` |
| 09-01 21:46 | Owner resets the instance | GCE operation log |
| 09-01 21:53 | Heartbeats resume | Cloud Logging |

The loop's last act before going dark was to successfully fix production. Then
it spent six days doing perfect work that nobody could see.

## Why nothing noticed

Four independent detection paths existed. All four failed, and they failed for
the same underlying reason: **every one of them lived on the VM, or reported
through the VM's network, or both.**

1. **The watcher heartbeat.** Shipped with `gcloud logging write`, which needs
   the network that had just died. The tick itself kept succeeding every minute.
   Absence of heartbeat could not distinguish "watcher broken" from "network
   broken" — and, more importantly, nothing acted on either.
2. **The Cloud Monitoring dead-man** (`WATCHER_HEARTBEAT absent 5 min`) was
   enabled and its condition was true for six days. It notified an **email**
   channel. That channel has never delivered a single alert in this project —
   a mailbox search across all time returns zero messages from
   `alerting-noreply@google.com`.
3. **The Telegram notification channel** used by five other policies is a raw
   webhook at `api.telegram.org/bot.../sendMessage`. Cloud Monitoring posts its
   own incident JSON; the Bot API requires `{chat_id, text}` and answers **400
   Bad Request** every time. Verified in the notification-channel error log
   (2026-08-31 00:13, 00:15, 00:17; 2026-09-01 16:26, 17:47).
4. **Nothing could act.** Even a delivered page only moves the problem to a
   human. Recovery required someone to notice, diagnose, and issue a reset.

A fifth, subtler point: a Cloud Monitoring *metric-absence* condition is a weak
dead-man. When the time series stops existing entirely — which is what happens
when the writer dies — the condition has nothing to evaluate and the incident
auto-closes. A dead-man switch that goes quiet when the thing it watches dies is
decoration.

## Contributing causes

- **No memory limit anywhere.** `claude-code-vm-job-dispatcher.service` ran in
  `system.slice` with no `MemoryMax`, no `MemoryHigh`, no `NODE_OPTIONS` heap
  cap. One agent session could — and did — consume the host.
- **No swap and no early OOM handler.** The kernel's own OOM killer only fires
  after the machine has already spent 40 minutes thrashing. Those 40 minutes are
  what killed the DHCP renewal.
- **`KeepConfiguration` unset.** systemd-networkd's default is to surrender the
  address when a lease expires. On GCE the internal IP is reserved for the
  instance's lifetime, so surrendering it buys nothing and costs everything.

## What changed

Each layer is independent; each one alone would have prevented or ended this
outage.

| Layer | Change | Where |
|---|---|---|
| **Prevent** | `selfheal.slice` (MemoryHigh 3G / Max 3.5G); dispatcher capped at 2G/3G with `OOMPolicy=continue`; change-ingest at 384M/512M; `user-1001.slice` (cron, monitor session) capped at 2G/2.5G | `deploy/systemd/`, `deploy/bin/self-healing-harden.sh` |
| **Prevent** | `earlyoom` — kills the largest offender while the host is merely low, instead of after 40 minutes of thrash; `--avoid` sshd/networkd/guest-agent, `--prefer` node/claude | `deploy/bin/self-healing-harden.sh` |
| **Prevent** | `KeepConfiguration=dhcp` drop-in — a failed renewal can no longer remove the address | `deploy/bin/self-healing-harden.sh` |
| **Self-repair** | `selfheal-netwatch.timer` — probes the metadata server every 2 min; escalates `networkctl reconfigure` → `systemctl restart systemd-networkd` → reboot (max once per hour) | `deploy/bin/selfheal-netwatch.sh` |
| **Detect (off-box)** | Cloud Scheduler → `self-healing-watchdog` function reads heartbeat age from Cloud Logging every 5 min | `watchdog/`, `infra/terraform/modules/self-healing-watchdog/` |
| **Recover (off-box)** | The same function holds `compute.instanceAdmin.v1` **on this one instance** and resets it — budgeted: 30 min cooldown, max 3 per 6 h, and never on a heartbeat stream it has never observed | `watchdog/decide.js` |
| **Deliver** | Pub/Sub notification channel → `self-healing-alert-relay` function → Telegram. Replaces the webhook channel that answers 400. Existing policies now notify email **and** this channel | `infra/terraform/modules/self-healing-watchdog/`, `.../self-healing-vm/alerts.tf` |
| **Observe** | Dispatcher liveness heartbeat every 5 min (the watcher heartbeat proves the VM is alive, not that the fixer is); local `~/.watcher-last-ok` marker that does not need the network | `deploy/cron/self-healing.crontab` |
| **Watch the watcher** | `WATCHDOG_HEARTBEAT` + an absence policy delivered by the *relay* function — a separate deployment, so the watchdog dying does not silence its own alarm | `infra/terraform/modules/self-healing-watchdog/` |

Detection goes from "a human eventually looks" to **≤5 minutes**; recovery from
"a human issues a reset" to **≤15 minutes, unattended**.

## Two guards worth stating explicitly

Automatic recovery is a machine for amplifying its own bugs. Two invariants keep
this one from becoming the next incident:

1. **Never reset on a signal that has never been seen.** If no heartbeat has
   ever been observed on a stream, the likeliest cause is a misconfigured log
   id, not a dead VM. Power-cycling production every 30 minutes because of a
   Terraform typo would be a worse outage than the one being fixed. The
   watchdog pages and says so instead. (Verified live on first deploy: the
   dispatcher heartbeat did not exist yet, the watchdog reported
   `dispatcher-dead`, refused to reset, and explained why.)
2. **Every reset is budgeted.** Cooldown 30 min, at most 3 in 6 h. Past the
   budget it stops resetting and escalates that it has stopped, in those words.

## Lessons

- **A monitor that reports through the thing it monitors is not a monitor.**
  This is the same shape as JOB-651, the incident that created this project:
  everything watched errors, nothing watched output. Here, everything watched
  from inside, nothing watched from outside.
- **An alert channel is not working until a message has arrived through it.**
  Two channels were configured, enabled, green in the console, and neither had
  ever delivered anything. Terraform declaring a channel proves nothing.
- **Detection without the power to act still needs a human.** The brief was
  "don't rely on a human in the loop"; that means the recovery layer needs
  credentials, not just a phone number.
- **Bound the agent, not the machine.** The fix for "an agent session ate the
  host" is a cgroup, not a bigger instance. Unbounded, a bigger instance only
  buys a longer thrash.
