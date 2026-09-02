#!/usr/bin/env python3
"""Deterministic monitor collection + triage for JobLander production.

Runs BEFORE the LLM monitor session (invoked by scripts/run-monitor-session.sh).
Collects errors from GCP Logging / Cloud Run / LiveKit VMs / Sentry, groups them
by signature with REAL counts and timestamps, assigns severity strictly by the
thresholds documented in agents/claude/monitor.md, diffs against the previous
report, and emits ready-made escalation items (including verbatim P0 alert
texts). The LLM session only performs Linear dedup and sends the prepared
texts — it never invents severities, counts, timestamps or file paths.

State directory (the ONLY one): teams/logs/monitoring/
Outputs:
  latest-report.json        — full report (schema of monitor.md Шаг 7)
  <YYYY-MM-DDTHH>.json      — hourly archive copy
  triage-summary.json       — compact agent-facing escalation list
"""

import datetime
import json
import os
import re
import subprocess
import sys
import urllib.request

PROJECT = "meet-assistant-6d8ad"
REGIONS = ["europe-west1", "us-central1", "australia-southeast1", "asia-south1"]
# Live LiveKit regions. lk-au-southeast1 removed 2026-07-18: it has no running
# GCE instance (daily Spot delete cycle, currently absent) and the backend does
# not serve Australia — monitoring a phantom fired a false P0 every run. If AU is
# re-provisioned, add it back here AND in agents/claude/monitor.md (see the
# config-drift note there). ROOT FIX (tracked): derive this list from reality
# (VMs that emit gcplogs recently — logging.viewer already granted) instead of a
# hand-maintained duplicate, so a decommission can never leave a phantom.
LK_URLS = {
    "lk-eu-west4": "https://lk-eu.joblander.app",
    "lk-us-central1": "https://lk-us.joblander.app",
    "lk-asia-south1": "https://lk-in.joblander.app",
}
# LK docker-log stream (JOB-731 stage 3M): the containers on all 4 LK VMs run
# docker's `gcplogs` log driver, which ships to logName=".../logs/gcplogs-
# docker-driver" with the VM name in jsonPayload.instance.name and CLEAN
# message text. The older fluentd-style ".../logs/docker" stream is a garbled
# duplicate (binary framing prefixes inside message) and lk-eu-west4 does not
# emit to it at all — collecting from it missed the entire EU VM (verified
# against live logs 2026-07-17). Requires only roles/logging.viewer — works
# under the self-healing VM's minimal SA (no ssh, no compute.instances.get).
LK_DRIVER_LOGNAME = f'logName="projects/{PROJECT}/logs/gcplogs-docker-driver"'
LK_VM_FILTER = " OR ".join(
    f'jsonPayload.instance.name="{vm}"' for vm in LK_URLS
)
WINDOW_HOURS = 2
STATE_DIR = os.environ.get("MONITOR_STATE_DIR", "teams/logs/monitoring")
SENTRY_ORG = "joblander-z2"
SENTRY_PROJECT_ID = "4511020395069520"
# Sentry issues are counted over a 7-day window (its thresholds are 7d-based),
# but a 7-day COUNT says nothing about whether the bug is still happening. An
# issue fixed on Monday still shows 53 events on Friday, so the monitor kept
# filing tickets for bugs that had already stopped.
#
# 2026-07-22: ResumeParseLlmError 524 was fixed by PR #259 (merged 04:49Z) yet
# got re-filed three times — JOB-799 at 05:0x, JOB-800 at 06:02, JOB-801 at
# 07:02, once per hourly monitor run. The dispatcher investigated all three
# ($0.65 + $0.38 + $0.52) and closed each `fixed-elsewhere`, noting: "Monitor
# re-filed on stale 7d rolling window." The signature had been silent 17.9h.
#
# So: keep the 7d window for COUNTING, but require at least one event within
# SENTRY_FRESH_HOURS to file at all. 12h mirrors the dispatcher's own
# staleAgeHrs, above which it treats a ticket as stale anyway — filing something
# the fixer will only ever close as stale is pure waste.
SENTRY_FRESH_HOURS = int(os.environ.get("SENTRY_FRESH_HOURS", "12"))

# Per-signature cooldown after a ticket is closed: suppress re-filing within
# this window so the dispatcher's adjudication (stale/not-a-bug/fixed) isn't
# immediately reversed by the next monitor run. Evidence: JOB-840 closed 07:26
# → JOB-843 filed 10:02 same day; JOB-838 closed 08:31 → JOB-844 filed 10:02.
# $7.56 burned across four tickets covering two signatures (2026-07-27).
# P0 always overrides cooldown — a DOWN server is never suppressed.
COOLDOWN_HOURS_CANCELED = int(os.environ.get("COOLDOWN_HOURS_CANCELED", "12"))
COOLDOWN_HOURS_DONE = int(os.environ.get("COOLDOWN_HOURS_DONE", "6"))

LINEAR_API_URL = "https://api.linear.app/graphql"

# Linear priority → triage severity (monitor sets priority 1→P0, 2→P1, 3→P2).
# Used in the cooldown escalation override: if current severity is strictly
# worse than when the prior ticket was closed, the cooldown is overridden.
_LINEAR_PRIORITY_TO_SEV = {1: "P0", 2: "P1", 3: "P2", 4: "P3", 0: "P3"}
_SEV_RANK = {"P0": 3, "P1": 2, "P2": 1, "P3": 0}

collection_errors = []


def log(msg):
    print(f"[triage] {msg}", file=sys.stderr)


def run_cmd(cmd, timeout=180, optional=False):
    """Run a command, recording a failure instead of raising.

    optional=True marks the recorded failure `informational`, which keeps it out
    of the hard-fail count. Use it for lookups the run can proceed without: six
    genuine collector failures trigger the hard-fail path that discards every
    escalation, and an optional secret being unavailable must never be the sixth.
    """
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip()[:300])
        return res.stdout
    except Exception as e:  # noqa: BLE001 — record and continue, never crash collection
        entry = {"cmd": " ".join(cmd[:4]), "error": str(e)[:300]}
        if optional:
            entry["informational"] = True
        collection_errors.append(entry)
        log(f"FAILED{' (optional)' if optional else ''}: {' '.join(cmd[:4])}: {e}")
        return None


# Must stay ABOVE the P0 threshold in assign_severity() (count > 1000) — a
# lower cap would make true P0 spikes unobservable. When a query hits the cap,
# the result is recorded in collection_errors as a truncation note.
QUERY_LIMIT = 2000


def gcloud_logging_read(log_filter, limit=QUERY_LIMIT, freshness=f"{WINDOW_HOURS}h"):
    out = run_cmd([
        "gcloud", "logging", "read", log_filter,
        f"--project={PROJECT}", f"--limit={limit}",
        f"--freshness={freshness}", "--format=json",
    ])
    if out is None:
        return []
    try:
        entries = json.loads(out)
    except json.JSONDecodeError as e:
        collection_errors.append({"cmd": "gcloud logging read", "error": f"bad json: {e}"})
        return []
    if len(entries) >= limit:
        # Informational, not a collector failure — must not count toward
        # the hard_fail threshold in main().
        collection_errors.append({
            "cmd": "gcloud logging read",
            "error": f"TRUNCATED at limit={limit} for filter {log_filter[:80]} — "
                     f"real counts may be higher",
            "truncated": True,
        })
    return entries


def entry_message(entry):
    if entry.get("textPayload"):
        return str(entry["textPayload"])
    jp = entry.get("jsonPayload", {})
    msg = jp.get("message")
    if isinstance(msg, dict):
        msg = msg.get("message") or json.dumps(msg)
    return str(msg) if msg else json.dumps(jp)[:300]


NOISE_RES = [
    (re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "<uuid>"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "<email>"),
    (re.compile(r"https?://\S+"), "<url>"),
    (re.compile(r"\b\d+(\.\d+)?(ms|s|%)?\b"), "<n>"),
    (re.compile(r"[0-9a-f]{16,}", re.I), "<hex>"),
]


def slugify(message):
    """Stable signature slug from an error message (first line, noise stripped)."""
    line = message.strip().splitlines()[0][:160]
    for rx, repl in NOISE_RES:
        line = rx.sub(repl, line)
    words = re.sub(r"[^a-zA-Z<>_-]+", " ", line).split()
    return "-".join(w.lower() for w in words[:7]) or "unknown-error"


def add_to_groups(groups, signature, service, region, ts, message):
    g = groups.setdefault(signature, {
        "signature": signature,
        "service": service,
        "region": region,
        "count": 0,
        "first_seen": ts,
        "last_seen": ts,
        "sample_message": message.strip()[:300],
    })
    g["count"] += 1
    if ts < g["first_seen"]:
        g["first_seen"] = ts
    if ts > g["last_seen"]:
        g["last_seen"] = ts


def collect_cloud_run(groups):
    entries = gcloud_logging_read(
        'resource.type="cloud_run_revision" AND severity>=ERROR'
    )
    for e in entries:
        labels = e.get("resource", {}).get("labels", {})
        service = labels.get("service_name", "unknown")
        region = labels.get("location", "unknown")
        msg = entry_message(e)
        add_to_groups(groups, f"{service}:{region}:{slugify(msg)}",
                      service, region, e.get("timestamp", ""), msg)
    log(f"cloud run: {len(entries)} error entries")


def collect_cloud_functions(groups):
    entries = gcloud_logging_read('resource.type="cloud_function" AND severity>=ERROR', limit=QUERY_LIMIT)
    for e in entries:
        fn = e.get("resource", {}).get("labels", {}).get("function_name", "unknown")
        msg = entry_message(e)
        # service tag = "email-service" (Cloud Functions ARE the email
        # pipeline) so service_status() in the report reflects real email
        # health; the signature keeps the cloud-function prefix.
        add_to_groups(groups, f"cloud-function:{fn}:{slugify(msg)}",
                      "email-service", fn, e.get("timestamp", ""), msg)
    log(f"cloud functions: {len(entries)} error entries")


def lk_entry_vm(entry):
    """VM name of a gcplogs-docker-driver entry (jsonPayload.instance.name)."""
    inst = entry.get("jsonPayload", {}).get("instance")
    return inst.get("name", "unknown") if isinstance(inst, dict) else "unknown"


def collect_lk_docker(groups):
    entries = gcloud_logging_read(
        f'{LK_DRIVER_LOGNAME} AND resource.type="gce_instance" '
        f'AND jsonPayload.message=~"ERROR" AND ({LK_VM_FILTER})', limit=QUERY_LIMIT
    )
    for e in entries:
        vm = lk_entry_vm(e)
        msg = entry_message(e)
        add_to_groups(groups, f"voice-agent:{vm}:{slugify(msg)}",
                      "ai-voice-agent-python", vm, e.get("timestamp", ""), msg)
    log(f"lk docker: {len(entries)} error entries")


def collect_stage_errors(groups):
    entries = gcloud_logging_read(
        'resource.type="gce_instance" AND jsonPayload.message=~"STAGE_ERROR"', limit=QUERY_LIMIT
    )
    by_code = {}
    for e in entries:
        msg = entry_message(e)
        m = re.search(r"status_code=(\d{3})", msg)
        code = m.group(1) if m else "unknown"
        by_code.setdefault(code, []).append((e.get("timestamp", ""), msg))
    for code, items in by_code.items():
        items.sort()
        sig = f"voice-agent:all:stage-error-{code}"
        for ts, msg in items:
            add_to_groups(groups, sig, "ai-voice-agent-python", "all", ts, msg)
    log(f"stage errors: {len(entries)} entries")
    return {code: len(items) for code, items in by_code.items()}


def collect_audio_timeouts(groups):
    entries = gcloud_logging_read(
        'resource.type="gce_instance" AND jsonPayload.message=~"Audio Timeout Error"', limit=QUERY_LIMIT
    )
    for e in entries:
        msg = entry_message(e)
        add_to_groups(groups, "voice-agent:all:audio-timeout-error",
                      "ai-voice-agent-python", "all", e.get("timestamp", ""), msg)
    log(f"audio timeouts: {len(entries)} entries")
    return len(entries)


def collect_geo_misroutes(groups):
    """monitor.md §1.5: `country=IN → eu` in geo logs = Indian users misrouted
    (defeats the purpose of the asia-south1 region) → P1."""
    entries = gcloud_logging_read(
        'resource.type="cloud_run_revision" AND resource.labels.service_name="joblander-app" '
        'AND textPayload=~"\\[geo\\]"', limit=QUERY_LIMIT
    )
    misroutes = []
    for e in entries:
        msg = entry_message(e)
        m = re.search(r"country=(\w+).*→\s*(\S+)", msg)
        if m and m.group(1) == "IN" and m.group(2) != "india":
            misroutes.append((e.get("timestamp", ""), msg))
    for ts, msg in sorted(misroutes):
        add_to_groups(groups, "joblander-app:geo:in-users-misrouted",
                      "joblander-app", "geo-routing", ts, msg)
    # Severity floor (P1) is applied in assign_severity via raise_to so the
    # generic count thresholds can still escalate a massive spike to P0.
    log(f"geo: {len(entries)} entries, {len(misroutes)} IN misroutes")
    return len(misroutes)


def collect_anam_failures(groups):
    """monitor.md §1.5: Anam `Failed to start avatar` > 3/2h → P2."""
    entries = gcloud_logging_read(
        f'{LK_DRIVER_LOGNAME} AND resource.type="gce_instance" '
        f'AND jsonPayload.message=~"Failed to start avatar" AND ({LK_VM_FILTER})',
        limit=QUERY_LIMIT,
    )
    for e in entries:
        vm = lk_entry_vm(e)
        add_to_groups(groups, "voice-agent:all:anam-avatar-start-failed",
                      "ai-voice-agent-python", vm, e.get("timestamp", ""), entry_message(e))
    # Severity floor (P2 when >3/2h) is applied in assign_severity via
    # raise_to so the generic thresholds can still escalate to P1/P0.
    log(f"anam failures: {len(entries)} entries")
    return len(entries)


TURN_LATENCY_RE = re.compile(
    r"TURN_LATENCY EOUMetrics (\{[^}]*\})(?: counts=\{[^}]*\})? ctx=(\{[^}]*\})"
)


def percentile(values, p):
    s = sorted(values)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)


def collect_transcription_delay(groups):
    """monitor.md §1.6.3 thresholds. Values are already in ms — voice-agent's
    metrics_service multiplies by 1000 before logging (verified in source).
    p50 EU/en > 1500 → P2; p50 IN/en > 2500 → P2; p99 > 30000 → P3 (P2 if
    >= 2 such outliers in the same region/lang within the window)."""
    import ast
    entries = gcloud_logging_read(
        'resource.type="gce_instance" AND jsonPayload.message=~"TURN_LATENCY EOUMetrics"',
        limit=QUERY_LIMIT,
    )
    rows = {}
    for e in entries:
        m = TURN_LATENCY_RE.search(entry_message(e))
        if not m:
            continue
        try:
            metrics = ast.literal_eval(m.group(1))
            ctx = ast.literal_eval(m.group(2))
        except (ValueError, SyntaxError):
            continue
        td = metrics.get("transcription_delay")
        if not td or td <= 0:
            continue
        # logs are duplicated across two streams — dedupe by speech_id+session
        rows[(ctx.get("speech_id"), ctx.get("session"))] = (
            ctx.get("region") or "?", ctx.get("language") or "?",
            td, e.get("timestamp", ""))
    by_rl = {}
    for region, lang, td, ts in rows.values():
        by_rl.setdefault((region, lang), []).append((td, ts))
    p50_limits = {("eu", "en"): 1500, ("india", "en"): 2500}
    now = utcnow_iso()
    for (region, lang), vals in by_rl.items():
        tds = [v[0] for v in vals]
        p50, p99 = percentile(tds, 0.5), percentile(tds, 0.99)
        limit_p50 = p50_limits.get((region, lang))
        outliers = len([t for t in tds if t > 30000])
        sev = None
        if limit_p50 and p50 > limit_p50:
            sev = "P2"
        elif outliers >= 2:
            sev = "P2"
        elif outliers == 1:
            sev = "P3"
        if sev:
            sig = f"voice-agent:{region}:transcription-delay-regression-{lang}"
            ts_sorted = sorted(v[1] for v in vals)
            groups[sig] = {
                "signature": sig, "service": "ai-voice-agent-python",
                "region": region, "count": len(tds),
                "first_seen": ts_sorted[0], "last_seen": ts_sorted[-1],
                "severity": sev,
                "sample_message": (f"transcription_delay {region}/{lang}: "
                                   f"p50={p50:.0f}ms p99={p99:.0f}ms n={len(tds)} "
                                   f"(p50 limit {limit_p50}, >30s outliers: {outliers})"),
            }
    log(f"turn latency: {len(entries)} entries, {len(rows)} turns, "
        f"{len(by_rl)} region/lang groups")


def check_lk_health():
    statuses = {}
    for vm, url in LK_URLS.items():
        out = run_cmd(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                       "--connect-timeout", "5", url + "/"], timeout=15)
        statuses[vm] = int(out) if out and out.strip().isdigit() else 0
    log(f"lk health: {statuses}")
    return statuses


LK_ZONES = {
    "lk-eu-west4": "europe-west4-b",
    "lk-us-central1": "us-central1-a",
    "lk-asia-south1": "asia-south1-a",
    "lk-au-southeast1": "australia-southeast1-a",
}


# ssh failure modes that mean "these credentials cannot ssh AT ALL" (the
# self-healing VM's minimal SA: no compute.instances.get, no ssh keys —
# JOB-731 stage 3M). Identical for every VM, so the first hit skips the rest.
SSH_UNAVAILABLE_RE = re.compile(
    r"compute\.instances\.get|PERMISSION_DENIED|does not have permission|"
    r"Permission denied \(publickey", re.I)


def check_vm_disk(groups):
    """LK VM disk usage: >70% → P2, >85% → P1 (PR #72 incident).

    Needs ssh — disk % has NO ssh-free source: the LK VMs run no ops agent
    (no agent.googleapis.com/disk/percent_used series exists) and nothing
    logs disk usage to Cloud Logging (both verified 2026-07-17); the
    self-healing VM's SA has no monitoring.viewer either. So the check is
    best-effort: where credentials cannot ssh it is skipped with ONE
    informational note (never counted toward hard_fail) instead of failing
    4x every run.
    """
    if os.environ.get("MONITOR_SKIP_VM_DISK") == "1":
        return
    now = utcnow_iso()
    for vm, zone in LK_ZONES.items():
        cmd = ["gcloud", "compute", "ssh", vm, f"--zone={zone}",
               f"--project={PROJECT}", "--ssh-flag=-o ConnectTimeout=10",
               "--command=df / | tail -1 | awk '{print $5}' | tr -d '%'"]
        try:
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except Exception as e:  # noqa: BLE001 — timeout etc: real failure
            collection_errors.append({"cmd": f"vm disk ssh {vm}", "error": str(e)[:300]})
            log(f"FAILED: vm disk ssh {vm}: {e}")
            continue
        if res.returncode != 0:
            err = res.stderr.strip()[:300]
            if SSH_UNAVAILABLE_RE.search(err):
                collection_errors.append({
                    "cmd": "vm disk check",
                    "error": f"ssh unavailable for these credentials ({vm}: "
                             f"{err[:120]}) — disk checks skipped; needs "
                             f"ssh-capable creds or MONITOR_SKIP_VM_DISK=1",
                    "informational": True,
                })
                log("vm disk: ssh unavailable in this environment — skipping")
                return
            collection_errors.append({"cmd": f"vm disk ssh {vm}", "error": err})
            log(f"FAILED: vm disk ssh {vm}: {err}")
            continue
        out = res.stdout
        if not out.strip().isdigit():
            continue
        used = int(out.strip())
        log(f"{vm} disk: {used}%")
        if used > 70:
            sig = f"lk-vm:{vm}:disk-usage-high"
            groups[sig] = {
                "signature": sig, "service": "livekit", "region": vm,
                "count": 1, "first_seen": now, "last_seen": now,
                "severity": "P1" if used > 85 else "P2",
                "sample_message": f"{vm} root disk at {used}% (P2 >70%, P1 >85%)",
            }


def collect_sentry(groups):
    token = os.environ.get("SENTRY_TOKEN", "").strip()
    if not token:
        out = run_cmd(["gcloud", "secrets", "versions", "access", "latest",
                       "--secret=joblander-sentry-monitor-token", f"--project={PROJECT}"])
        token = (out or "").strip()
    if not token:
        collection_errors.append({"cmd": "sentry", "error": "no SENTRY_TOKEN available"})
        return
    url = (f"https://sentry.io/api/0/organizations/{SENTRY_ORG}/issues/"
           f"?project={SENTRY_PROJECT_ID}&query=is%3Aunresolved&sort=freq&limit=100&statsPeriod=7d")
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            issues = json.loads(resp.read().decode())
    except Exception as e:  # noqa: BLE001
        collection_errors.append({"cmd": "sentry", "error": str(e)[:300]})
        return
    kept = 0
    stale = []
    fresh_cutoff = (datetime.datetime.now(datetime.timezone.utc)
                    - datetime.timedelta(hours=SENTRY_FRESH_HOURS))
    for issue in issues:
        raw = json.dumps(issue)
        if "inpage.js" in raw or "posthog-recorder.js" in raw \
                or "Failed to connect to MetaMask" in raw \
                or "Blocked a frame with origin" in raw:
            continue
        count = int(issue.get("count", 0))
        if count == 0:
            continue
        # Freshness gate — a 7d count is not evidence the bug still happens.
        # Unparseable/absent lastSeen fails OPEN (keep the issue): losing a real
        # regression to a date-format change is far worse than one stale ticket.
        last_seen_raw = issue.get("lastSeen") or ""
        try:
            last_seen = datetime.datetime.fromisoformat(last_seen_raw.replace("Z", "+00:00"))
            if last_seen.tzinfo is None:
                last_seen = last_seen.replace(tzinfo=datetime.timezone.utc)
            if last_seen < fresh_cutoff:
                age_h = round((datetime.datetime.now(datetime.timezone.utc) - last_seen).total_seconds() / 3600, 1)
                stale.append(f"{(issue.get('culprit') or 'unknown').split('/')[-1]}({age_h}h)")
                continue
        except ValueError:
            pass
        uc = int(issue.get("userCount", 0))
        meta = issue.get("metadata", {})
        culprit = (issue.get("culprit") or "unknown").split("/")[-1] or "unknown"
        sig = f"sentry:joblander-app:{slugify(culprit)}:{slugify(str(meta.get('type', 'error')))}"
        if count >= 50 or uc >= 5:
            sev = "P1"
        elif count >= 10 or uc >= 2:
            sev = "P2"
        else:
            sev = "P3"
        groups[sig] = {
            "signature": sig,
            "service": "joblander-app",
            "region": "frontend",
            "count": count,
            # Sentry counts use a 7-day window per monitor.md §1.8 (its
            # thresholds are 7d-based), unlike the 2h log collectors —
            # annotated so the mixed windows aren't misleading in reports.
            "window": "7d",
            "user_count": uc,
            "sentry_id": issue.get("id"),
            "sentry_url": issue.get("permalink"),
            "first_seen": issue.get("firstSeen", ""),
            "last_seen": issue.get("lastSeen", ""),
            "severity": sev,
            "sample_message": f"{meta.get('type', '')}: {str(meta.get('value', ''))[:200]}",
        }
        kept += 1
    if stale:
        log(f"sentry: {len(stale)} issue(s) skipped as stale "
            f"(no event in {SENTRY_FRESH_HOURS}h): {stale}")
    log(f"sentry: {len(issues)} issues, {kept} after noise + freshness filters")


def assign_severity(groups, lk_statuses, stage_counts, audio_timeouts,
                    geo_misroutes=0, anam_count=0):
    """Thresholds from agents/claude/monitor.md Шаг 4 + §1.5/§1.6 triage rules."""
    for g in groups.values():
        if "severity" in g:  # sentry groups already classified
            continue
        c = g["count"]
        if c > 1000:
            g["severity"] = "P0"
        elif c > 100:
            g["severity"] = "P1"
        elif c >= 10:
            g["severity"] = "P2"
        else:
            g["severity"] = "P3"
    # voice-agent specific rules — only ever RAISE severity, never lower what
    # the generic count thresholds already assigned.
    rank = {"P3": 0, "P2": 1, "P1": 2, "P0": 3}

    def raise_to(sig, sev):
        if sig in groups and rank[sev] > rank[groups[sig]["severity"]]:
            groups[sig]["severity"] = sev

    # "STAGE_ERROR total > 20/2h → P2 (elevated provider error rate)" — with
    # mixed status codes each per-code group can stay under the generic P3
    # bar, so the overall spike must escalate every stage-error group.
    stage_total = sum(stage_counts.values())
    for code, n in stage_counts.items():
        sig = f"voice-agent:all:stage-error-{code}"
        if code == "402":
            raise_to(sig, "P1")
        elif code == "429" and n >= 5:
            raise_to(sig, "P2")
        elif code.startswith("5") and n >= 5:
            raise_to(sig, "P2")
        if stage_total > 20:
            raise_to(sig, "P2")
    if audio_timeouts >= 5:
        raise_to("voice-agent:all:audio-timeout-error", "P1")
    # §1.5 floors — raise_to keeps generic count thresholds able to escalate
    # a massive spike to P1/P0 (Codex P1 on PR #59).
    if geo_misroutes > 0:
        raise_to("joblander-app:geo:in-users-misrouted", "P1")
    if anam_count > 3:
        raise_to("voice-agent:all:anam-avatar-start-failed", "P2")
    # LiveKit server down = P0, regardless of log volume
    now = utcnow_iso()
    for vm, status in lk_statuses.items():
        if status != 200:
            sig = f"lk-server:{vm}:down"
            groups[sig] = {
                "signature": sig, "service": "livekit", "region": vm,
                "count": 1, "first_seen": now, "last_seen": now,
                "severity": "P0",
                "sample_message": f"LiveKit server {vm} HTTP {status} (expected 200)",
            }


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def filter_known(groups, state_dir):
    known = load_json(os.path.join(state_dir, "known-errors.json"), {}).get("patterns", [])
    today = datetime.date.today().isoformat()
    kept, skipped = {}, []
    for sig, g in groups.items():
        is_known = False
        for k in known:
            if k.get("expires") and k["expires"] < today:
                continue
            pat = "^" + re.escape(k.get("signature_match", "")).replace("\\*", ".*") + "$"
            if re.match(pat, sig):
                is_known = True
                skipped.append(sig)
                break
        if not is_known:
            kept[sig] = g
    if skipped:
        log(f"known-errors filtered: {skipped}")
    return kept


def diff_with_previous(groups, state_dir):
    prev = load_json(os.path.join(state_dir, "latest-report.json"), {"error_groups": []})
    old = {g["signature"]: g for g in prev.get("error_groups", [])
           if g.get("diff_status") != "resolved"}
    final = []
    summary = {"total_errors": 0, "by_severity": {"P0": 0, "P1": 0, "P2": 0, "P3": 0},
               "by_region": {}, "new_errors": 0, "resolved_errors": 0, "worsened_errors": 0}
    bump = {"P3": "P2", "P2": "P1", "P1": "P0", "P0": "P0"}
    for sig, g in groups.items():
        if sig not in old:
            g["diff_status"] = "new"
            summary["new_errors"] += 1
        else:
            oc = old[sig].get("count", 0)
            if oc > 0 and g["count"] > oc * 2:
                g["diff_status"] = "worsened"
                g["severity"] = bump[g["severity"]]
                summary["worsened_errors"] += 1
            elif g["count"] <= oc * 0.5:
                g["diff_status"] = "improved"
            else:
                g["diff_status"] = "recurring"
            g["linear_issue"] = old[sig].get("linear_issue")
        g.setdefault("linear_issue", None)
        summary["total_errors"] += g["count"]
        summary["by_region"][g["region"]] = summary["by_region"].get(g["region"], 0) + g["count"]
        summary["by_severity"][g["severity"]] += 1
        final.append(g)
    for sig, og in old.items():
        if sig not in groups:
            og = dict(og, diff_status="resolved", count=0)
            final.append(og)
            summary["resolved_errors"] += 1
    return final, summary


def _iso_or_min(value):
    """Parse a Linear ISO timestamp; an unparseable one sorts oldest.

    Used to pick the newest closure among duplicate signatures — a comparison
    that must never raise, because the whole gate is fail-open.
    """
    try:
        return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)


def collect_closed_signature_cooldowns():
    """Query Linear for recently-closed [Monitor] tickets and extract their signatures.

    Returns a dict keyed by signature:
      {signature: {"state_type": "canceled"|"completed", "closed_at": ISO, "issue": "JOB-XXX"}}

    Fails open: any error (no API key, network, bad response) → returns {} so
    the monitor behaves exactly as it did before this gate existed.  The gate
    may only ever *add* suppression; it never blocks a real filing when the
    feed is down.
    """
    # optional=True: the gate fails open by design, so a missing key is not a
    # collector failure. Counting it as one could make it the sixth error and
    # trigger the hard-fail path, discarding every escalation of the run.
    token_raw = run_cmd([
        "gcloud", "secrets", "versions", "access", "latest",
        "--secret=linear-api-key", f"--project={PROJECT}",
    ], optional=True)
    token = (token_raw or "").strip()
    if not token:
        log("cooldown: linear-api-key unavailable — skipping cooldown gate (fail open)")
        return {}

    # Look back far enough to cover both cooldown windows.
    lookback_hours = max(COOLDOWN_HOURS_CANCELED, COOLDOWN_HOURS_DONE) + 1
    since = (datetime.datetime.now(datetime.timezone.utc)
             - datetime.timedelta(hours=lookback_hours)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    # We query by title prefix so we don't need to hard-code a label ID.
    # The description body carries the canonical signature in the "Observed
    # signal" section: **Signature:** `<service>:<region>:<slug>`
    # completedAt / canceledAt, not updatedAt: editing a ticket after it was
    # closed advances updatedAt, which would restart the cooldown and could
    # suppress a live P1/P2 whose real closure window had already expired.
    # change-ingest/src/ingest/linear.ts makes the same distinction.
    query = """
query CooldownCheck($since: DateTimeOrDuration!, $after: String) {
  issues(
    filter: {
      team: { name: { eq: "JobLander" } }
      title: { startsWith: "[Monitor]" }
      state: { type: { in: [canceled, completed] } }
      updatedAt: { gt: $since }
    }
    first: 50
    after: $after
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      priority
      state { type }
      updatedAt
      completedAt
      canceledAt
      description
    }
  }
}
"""
    # Drain every page. A single page is 50 issues; on a busy week the tickets
    # beyond it would silently bypass the gate — which is exactly the refiling
    # this gate exists to stop. MAX_PAGES bounds a runaway cursor.
    MAX_PAGES = 20
    nodes = []
    after = None
    try:
        for _ in range(MAX_PAGES):
            payload = json.dumps({
                "query": query,
                "variables": {"since": since, "after": after},
            }).encode()
            req = urllib.request.Request(
                LINEAR_API_URL,
                data=payload,
                headers={"Content-Type": "application/json", "Authorization": token},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode())

            if result.get("errors"):
                log(f"cooldown: Linear GraphQL errors (fail open): {result['errors']}")
                return {}

            issues = (result.get("data") or {}).get("issues", {}) or {}
            nodes.extend(issues.get("nodes", []) or [])
            page = issues.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
            if not after:
                break
        else:
            log(f"cooldown: stopped after {MAX_PAGES} pages — more closed tickets exist")
    except Exception as e:  # noqa: BLE001 — fail open, never block monitoring
        log(f"cooldown: Linear API error (fail open): {e}")
        return {}

    cooldowns = {}
    for node in nodes:
        desc = node.get("description") or ""
        # Extract the exact signature from the factory-ready ticket body:
        # "**Signature:** `service:region:slug`"
        m = re.search(r"\*\*Signature:\*\*\s*`([^`\n]+)`", desc)
        if not m:
            continue
        sig = m.group(1).strip()
        state_type = (node.get("state") or {}).get("type", "")
        # The timestamp of the ACTUAL terminal transition.
        closed_at = node.get("canceledAt") if state_type == "canceled" else node.get("completedAt")
        if not closed_at:
            # Older tickets closed before Linear recorded the field; updatedAt
            # is the only thing left, and is at worst too recent (suppresses
            # slightly longer), never too old (never suppresses a live signal
            # for longer than it should).
            closed_at = node.get("updatedAt", "")

        # Several closed tickets can carry the same signature — that is the
        # refiling pattern this gate is built for. Keep the NEWEST closure;
        # otherwise the cooldown's age and prior severity depend on the order
        # Linear happened to return rows in.
        prev = cooldowns.get(sig)
        if prev and _iso_or_min(prev.get("closed_at")) >= _iso_or_min(closed_at):
            continue

        cooldowns[sig] = {
            "state_type": state_type,
            "closed_at": closed_at,
            "issue": node.get("identifier", ""),
            # Severity the ticket was filed at — used in the escalation override:
            # if current severity is strictly worse, the cooldown is bypassed.
            "prior_severity": _LINEAR_PRIORITY_TO_SEV.get(
                node.get("priority", 0), "P3"),
        }
    log(f"cooldown: {len(nodes)} recently-closed [Monitor] tickets, "
        f"{len(cooldowns)} distinct signatures")
    return cooldowns


def build_escalations(final_groups, cooldowns=None):
    """Шаг 6 monitor.md, encoded. Telegram ONLY for P0; text prepared verbatim.

    cooldowns: dict returned by collect_closed_signature_cooldowns().  Signatures
    present in the cooldown map and within the suppression window are downgraded to
    action="cooldown_suppressed" so the monitor LLM does not refile them.  P0 is
    always exempt — a DOWN server must never be silenced.
    """
    if cooldowns is None:
        cooldowns = {}
    now_dt = datetime.datetime.now(datetime.timezone.utc)
    p0_alerts, escalations = [], []
    for g in final_groups:
        sev, status = g.get("severity"), g.get("diff_status")
        if status == "resolved":
            continue
        item = {k: g.get(k) for k in ("signature", "service", "region", "count",
                                      "first_seen", "last_seen", "severity",
                                      "diff_status", "sample_message", "linear_issue",
                                      "sentry_url", "user_count")}
        item["suggested_title"] = f"[Monitor] {g['service']} {g['region']}: {g['signature'].split(':')[-1]}"

        # --- Cooldown gate (JOB-858) ---
        # P0 is always exempt: a DOWN server or a massive spike must never be
        # silenced by a cooldown.  For all other severities, if this signature's
        # prior Linear ticket was recently closed (Canceled within
        # COOLDOWN_HOURS_CANCELED, Done within COOLDOWN_HOURS_DONE), suppress
        # re-filing so the dispatcher's adjudication isn't reversed an hour later.
        if sev != "P0":
            cd = cooldowns.get(g.get("signature", ""))
            if cd:
                try:
                    closed_at = datetime.datetime.fromisoformat(
                        cd["closed_at"].replace("Z", "+00:00"))
                    if closed_at.tzinfo is None:
                        closed_at = closed_at.replace(tzinfo=datetime.timezone.utc)
                    age_h = (now_dt - closed_at).total_seconds() / 3600
                    state_type = cd.get("state_type", "")
                    limit_h = (COOLDOWN_HOURS_CANCELED if state_type == "canceled"
                               else COOLDOWN_HOURS_DONE)
                    if age_h < limit_h:
                        # Escalation override: if current severity is strictly
                        # worse than when the ticket was closed (P2→P1, P1→P0,
                        # etc.), the cooldown is bypassed — a genuine escalation
                        # must never be silenced.
                        prior_sev = cd.get("prior_severity", "P3")
                        if _SEV_RANK.get(sev, 0) > _SEV_RANK.get(prior_sev, 0):
                            log(f"cooldown: OVERRIDE for {g['signature']} — "
                                f"severity escalated {prior_sev}→{sev} "
                                f"(prior {cd['issue']} {state_type} {age_h:.1f}h ago)")
                            item["cooldown_override"] = {
                                "prior_issue": cd["issue"],
                                "prior_severity": prior_sev,
                                "current_severity": sev,
                            }
                            # Fall through to normal escalation path.
                        else:
                            log(f"cooldown: suppressing {g['signature']} — "
                                f"{cd['issue']} {state_type} {age_h:.1f}h ago "
                                f"(limit {limit_h}h, sev={sev})")
                            item["action"] = "cooldown_suppressed"
                            item["cooldown"] = {
                                "prior_issue": cd["issue"],
                                "state": state_type,
                                "age_h": round(age_h, 1),
                                "limit_h": limit_h,
                            }
                            escalations.append(item)
                            continue
                except (ValueError, TypeError):
                    pass  # bad date → fail open, treat as no cooldown
        # --- end cooldown gate ---

        if sev == "P0":
            if g["signature"].startswith("lk-server:") and g["signature"].endswith(":down"):
                # Synthetic outage group (count=1 by construction) — say DOWN,
                # not "1 errors/2h".
                text = (f"URGENT P0: {g['sample_message'][:150]} — "
                        f"detected {g['first_seen']}")
            else:
                text = (f"URGENT P0: {g['signature']} — {g['count']} errors/{WINDOW_HOURS}h, "
                        f"first {g['first_seen']}, last {g['last_seen']}. "
                        f"Sample: {g['sample_message'][:150]}")
            p0_alerts.append(text)
            item["action"] = "telegram_p0_and_linear"
            item["alert_text"] = text
        elif sev == "P1" and status in ("new", "worsened"):
            item["action"] = "linear_create_if_no_dup"
        elif sev == "P1" and status == "recurring":
            item["action"] = "linear_ensure_open_issue"
        elif sev == "P2" and status == "new":
            item["action"] = "linear_create_if_no_dup"
        else:
            item["action"] = "report_only"
        escalations.append(item)
    return p0_alerts, escalations


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    groups = {}
    collect_cloud_run(groups)
    collect_cloud_functions(groups)
    collect_lk_docker(groups)
    stage_counts = collect_stage_errors(groups)
    audio_timeouts = collect_audio_timeouts(groups)
    geo_misroutes = collect_geo_misroutes(groups)
    anam_count = collect_anam_failures(groups)
    collect_transcription_delay(groups)
    lk_statuses = check_lk_health()
    collect_sentry(groups)

    assign_severity(groups, lk_statuses, stage_counts, audio_timeouts,
                    geo_misroutes, anam_count)
    check_vm_disk(groups)  # after assign_severity: sets its own severity
    groups = filter_known(groups, STATE_DIR)
    final_groups, summary = diff_with_previous(groups, STATE_DIR)
    # Cooldown gate (JOB-858): query Linear for recently-closed [Monitor] tickets
    # and suppress re-filing within the adjudication window.  Fails open — if the
    # Linear API is unreachable the monitor behaves exactly as before.
    cooldowns = collect_closed_signature_cooldowns()
    p0_alerts, escalations = build_escalations(final_groups, cooldowns)

    now = utcnow_iso()
    # Hard fail: collection is severely broken. Do NOT overwrite the baseline
    # (latest-report.json) or write an archive — an empty report would make the
    # next run treat everything as NEW, the exact failure mode of JOB-558.
    # Truncation and informational notes do not count toward the threshold.
    hard_fail = len([e for e in collection_errors
                     if not e.get("truncated") and not e.get("informational")]) >= 6

    latest_path = os.path.join(STATE_DIR, "latest-report.json")
    archive_path = os.path.join(STATE_DIR, now[:13] + ".json")  # YYYY-MM-DDTHH
    if not hard_fail:
        # Per-service status (monitor.md Шаг 7 schema): derived from collected
        # error groups — DEGRADED if any active P0/P1 group, else HEALTHY.
        def service_status(svc_name):
            sev = {g.get("severity") for g in final_groups
                   if g.get("service") == svc_name and g.get("diff_status") != "resolved"}
            return "DEGRADED" if sev & {"P0", "P1"} else "HEALTHY"

        services = {
            svc: {"status": service_status(svc)}
            for svc in ("joblander-app", "joblander-audio-engine", "email-service")
        }
        services["livekit-vms"] = {
            vm: {"http": st, "status": "RUNNING" if st == 200 else "DOWN"}
            for vm, st in lk_statuses.items()
        }
        report = {
            "timestamp": now,
            "window_hours": WINDOW_HOURS,
            "generated_by": "scripts/monitor/triage.py",
            "services": services,
            "error_groups": final_groups,
            "summary": summary,
            "collection_errors": collection_errors,
            "actions": {"telegram_sent": [], "linear_created": [], "linear_commented": []},
        }
        with open(latest_path, "w") as f:
            json.dump(report, f, indent=2)
        with open(archive_path, "w") as f:
            json.dump(report, f, indent=2)

    # Build the cooldown_suppressed list for the summary: these are signatures
    # the monitor adjudicated recently and must not be re-filed this run.
    cooldown_suppressed = [] if hard_fail else [
        {"signature": e["signature"], **e["cooldown"]}
        for e in escalations if e.get("action") == "cooldown_suppressed"
    ]
    summary_out = {
        "timestamp": now,
        "triage_failed": hard_fail,
        "p0_alerts": [] if hard_fail else p0_alerts,
        "escalations": [] if hard_fail else
            [e for e in escalations
             if e["action"] not in ("report_only", "cooldown_suppressed")],
        "report_only": [] if hard_fail else
            [e["signature"] for e in escalations if e["action"] == "report_only"],
        # Signatures suppressed by the cooldown gate — logged for auditability,
        # never silently discarded (JOB-858 acceptance criterion).
        "cooldown_suppressed": cooldown_suppressed,
        "summary": summary,
        "collection_errors": collection_errors,
        "state_files": None if hard_fail else {"latest": latest_path, "archive": archive_path},
    }
    summary_path = os.path.join(STATE_DIR, "triage-summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary_out, f, indent=2)

    log(f"done: {summary['by_severity']}, {len(p0_alerts)} P0 alerts, "
        f"{len(summary_out['escalations'])} escalations, "
        f"{len(cooldown_suppressed)} cooldown-suppressed, "
        f"{len(collection_errors)} collection errors, hard_fail={hard_fail}")
    print(json.dumps(summary_out, indent=2))
    # Exit 3 on hard fail — the agent must report triage failure, not improvise
    # its own collection. Baseline is left untouched (see above).
    if hard_fail:
        sys.exit(3)


if __name__ == "__main__":
    main()
