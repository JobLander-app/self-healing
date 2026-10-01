#!/usr/bin/env python3
"""Deterministic monitor collection + triage for JobLander production.

Runs BEFORE the LLM monitor session (invoked by monitor/run-monitor-session.sh).
Collects errors from GCP Logging / Cloud Run services and worker pools / Sentry, groups them
by signature with REAL counts and timestamps, assigns severity strictly by the
thresholds implemented below, diffs against the previous
report, and emits ready-made escalation items (including verbatim P0 alert
texts). The runner delivers P0 pages; the LLM session only performs Linear
dedup and filing. It never invents severities, counts, timestamps or file paths.

State directory: MONITOR_STATE_DIR or ~/.local/state/self-healing/monitor
Outputs:
  latest-report.json        — full report, including committed escalation actions
  <YYYY-MM-DDTHH>.json      — hourly archive copy
  triage-summary.json       — compact agent-facing escalation list
"""

import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import urllib.parse
import urllib.request
from topology import inspect_targets, load_targets, revision, voice_filter, worker_service_status

REGIONS = ["europe-west1", "us-central1", "australia-southeast1", "asia-south1"]
TARGETS = load_targets()
PROJECT = TARGETS["project"]
VOICE_AGENT_LOG_FILTER = voice_filter(TARGETS)
WINDOW_HOURS = 2
STATE_DIR = os.environ.get("MONITOR_STATE_DIR", str(Path.home() / ".local/state/self-healing/monitor"))
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

# Post-deploy verification of a merged fix. The dispatcher ends its run at the
# merge, so this hourly triage is what notices a fix that did not hold: a Done
# ticket with a merged GitHub PR whose signature is seen again AFTER the fix
# went live bypasses the Done cooldown and is re-filed. A Done ticket without a
# merged PR (not-a-bug, fixed-elsewhere, stale) keeps the cooldown untouched.
#
# The fix-live time is the first Cloud Run deploy of the signature's service
# after the ticket closed, read from the local change-ingest feed (the same
# CHANGE_FEED_URL the dispatcher uses). Only a TRACKED deploy counts: when the
# feed is unreachable or shows no deploy, the event may still come from the old
# revision (deploy delayed, failed, never started), so "fix did not hold" would
# be an unproven claim and the cooldown is kept.
CHANGE_FEED_URL = os.environ.get("CHANGE_FEED_URL", "http://127.0.0.1:4200").rstrip("/")
_GCP_REGION_RE = re.compile(r"^[a-z]+(?:-[a-z]+)+\d+$")
_GITHUB_PR_URL_RE = re.compile(r"^https://github\.com/[^/\s]+/[^/\s]+/pull/\d+/?$")
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)

LINEAR_API_URL = "https://api.linear.app/graphql"

# Linear priority → triage severity (monitor sets priority 1→P0, 2→P1, 3→P2).
# Used in the cooldown escalation override: if current severity is strictly
# worse than when the prior ticket was closed, the cooldown is overridden.
_LINEAR_PRIORITY_TO_SEV = {1: "P0", 2: "P1", 3: "P2", 4: "P3", 0: "P3"}
_SEV_RANK = {"P0": 3, "P1": 2, "P2": 1, "P3": 0}

# Audio-engine errors on the paid-minute ledger (backend
# src/machines/session/session.machine.ts). Slugs as produced by slugify().
BILLING_SERVICE = "joblander-audio-engine"
BILLING_FAILURE_SLUGS = frozenset({
    "failed-to-deduct-balance-atomically",
    "failed-to-record-balance-transaction",
    "failed-to-persist-final-meeting-balance",
})

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


def payload_message(entry):
    """Extract an explicit message; payload metadata alone is not a message."""
    text = entry.get("textPayload")
    if text and str(text).strip():
        return str(text)
    jp = entry.get("jsonPayload")
    msg = jp.get("message") if isinstance(jp, dict) else None
    if isinstance(msg, dict):
        msg = msg.get("message") or (json.dumps(msg) if msg else None)
    if msg and str(msg).strip():
        return str(msg)
    return None


EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
DETAIL_MAX = 200
SAMPLE_MAX = 300
# The structured error leaves Cloud Logging (triage-summary.json, the filing
# prompt, Linear), so anything credential-shaped is removed before it does.
_URL_RE = re.compile(r"([a-z][a-z0-9+.-]*://)(?:[^\s/@'\"]*@)?([^\s/?#'\"]+)([^\s?#'\"]*)"
                     r"(?:\?[^\s#'\"]*)?(?:#[^\s'\"]*)?", re.I)
_SECRET_RES = [
    # The whole header value, whatever its scheme (Token, ApiKey, Digest, ...).
    # The optional quote before the separator covers json.dumps'd objects.
    (re.compile(r"(?i)\b((?:proxy-)?authorization)([\"']?\s*[=:]\s*[\"']?)(?:[a-z][\w-]*\s+)?[^\s\"',;&]+"),
     r"\1\2<redacted>"),
    (re.compile(r"eyJ[\w-]+\.[\w-]+\.[\w-]+"), "<redacted>"),
    (re.compile(r"(?i)\b(bearer|basic|token|apikey)\s+[\w.~+/=-]+"), r"\1 <redacted>"),
    (re.compile(r"(?i)\b([\w-]*(?:key|token|secret|password|passwd|authorization|signature|sig|credential)s?)"
                r"([\"']?\s*[=:]\s*[\"']?)[^\s\"',;&]+"), r"\1\2<redacted>"),
]


def redact_detail(text):
    text = _URL_RE.sub(lambda m: m.group(1) + m.group(2) + m.group(3), text)
    for rx, repl in _SECRET_RES:
        text = rx.sub(repl, text)
    return EMAIL_RE.sub("<email>", text)


def payload_error(entry):
    """The structured `error` a logger attached next to the message, if any.

    Evidence only, never part of the signature. Without it a ticket shows just
    "Failed to deduct balance atomically" and the filer guessed a transaction
    conflict, while the logged error was `socket hang up` (JOB-1131).
    """
    jp = entry.get("jsonPayload")
    if not isinstance(jp, dict):
        return None
    msg = jp.get("message")
    for holder in ((msg.get("metadata") if isinstance(msg, dict) else None), jp.get("metadata"), jp):
        detail = holder.get("error") if isinstance(holder, dict) else None
        if isinstance(detail, dict):
            detail = detail.get("message") or json.dumps(detail)
        if detail and str(detail).strip():
            return redact_detail(str(detail).strip())[:DETAIL_MAX]
    return None


def entry_message(entry):
    msg = payload_message(entry)
    if msg is not None:
        return msg
    request = request_context(entry)
    if request:
        return (f"HTTP {request['status']} {request['method']} {request['path']} "
                f"(revision {request['revision']})")[:300]
    jp = entry.get("jsonPayload")
    if jp is not None:
        return json.dumps(jp)[:300]
    return "No message payload"


def request_context(entry):
    """Keep request-log evidence without copying URL credentials or query data."""
    request = entry.get("httpRequest")
    if not isinstance(request, dict) or not request:
        return None
    url = str(request.get("requestUrl") or "")
    try:
        path = (urllib.parse.urlsplit(url).path or "/") if url else "unknown-route"
    except ValueError:
        path = "unknown-route"
    labels = entry.get("resource", {}).get("labels", {})
    return {
        "status": str(request.get("status") or "unknown"),
        "method": str(request.get("requestMethod") or "UNKNOWN").upper(),
        "path": path,
        "revision": labels.get("revision_name", "unknown"),
        "trace": entry.get("trace"),
        "insert_id": entry.get("insertId"),
    }


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


def request_route_signature(path):
    """Normalize volatile IDs while preserving the complete route structure."""
    if path == "/":
        return "root"
    normalized = path
    for pattern, replacement in NOISE_RES:
        normalized = pattern.sub(replacement, normalized)
    # The readable slug alone loses punctuation, case and everything beyond
    # seven words. Hash the full normalized path before that lossy conversion.
    digest = hashlib.sha256(normalized.encode()).hexdigest()[:16]
    return f"path-{slugify(normalized)}-{digest}"


def collect_cloud_run(groups):
    entries = gcloud_logging_read(
        'resource.type="cloud_run_revision" AND severity>=ERROR'
    )
    for e in entries:
        labels = e.get("resource", {}).get("labels", {})
        service = labels.get("service_name", "unknown")
        region = labels.get("location", "unknown")
        msg = entry_message(e)
        request = request_context(e)
        if request and payload_message(e) is None:
            # Status codes must not collapse to <n>, and deployments must not
            # create a new signature for an unchanged failing route.
            route = request_route_signature(request["path"])
            slug = f"http-{request['status']}-{slugify(request['method'])}-{route}"
        else:
            slug = slugify(msg)
        signature = f"{service}:{region}:{slug}"
        detail = payload_error(e)
        sample = msg
        if detail and detail not in msg:
            # Reserve room so a long message cannot truncate the evidence away.
            suffix = f" | error: {detail}"
            sample = msg.strip()[:SAMPLE_MAX - len(suffix)] + suffix
        add_to_groups(groups, signature,
                      service, region, e.get("timestamp", ""), sample)
        if sample is not msg and " | error: " not in groups[signature]["sample_message"]:
            # The first entry of the group may have been a bare one.
            groups[signature]["sample_message"] = sample
        if request:
            groups[signature].setdefault("request_context", request)
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


def voice_agent_region(entry):
    return entry.get("resource", {}).get("labels", {}).get("location", "unknown")


def collect_voice_agent_errors(groups):
    # The worker's JSON logger supplies level, not always GCP severity.
    entries = gcloud_logging_read(
        f'{VOICE_AGENT_LOG_FILTER} AND (severity>=ERROR OR '
        'jsonPayload.level=~"(?i)^(error|critical|fatal)$")', limit=QUERY_LIMIT
    )
    for e in entries:
        region = voice_agent_region(e)
        msg = entry_message(e)
        add_to_groups(groups, f"voice-agent:{region}:{slugify(msg)}",
                      "ai-voice-agent-python", region, e.get("timestamp", ""), msg)
    log(f"voice agent workers: {len(entries)} error entries")


def collect_stage_errors(groups):
    entries = gcloud_logging_read(
        f'{VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"STAGE_ERROR"', limit=QUERY_LIMIT
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
        f'{VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"Audio Timeout Error"', limit=QUERY_LIMIT
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
        f'{VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"Failed to start avatar"',
        limit=QUERY_LIMIT,
    )
    for e in entries:
        add_to_groups(groups, "voice-agent:all:anam-avatar-start-failed",
                      "ai-voice-agent-python", "all", e.get("timestamp", ""), entry_message(e))
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
        f'{VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"TURN_LATENCY EOUMetrics"',
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


def collect_sentry(groups):
    token = os.environ.get("SENTRY_TOKEN", "").strip()
    if not token:
        out = run_cmd(["gcloud", "secrets", "versions", "access", "latest",
                       "--secret=joblander-sentry-monitor-token", f"--project={PROJECT}"])
        token = (out or "").strip()
    if not token:
        collection_errors.append({"cmd": "sentry", "error": "no SENTRY_TOKEN available"})
        return
    # Classify locally: a server-side category filter would also exclude issues
    # without a category before the missing-classification guard can retain them.
    query = urllib.parse.urlencode({"project": SENTRY_PROJECT_ID,
                                    "query": "is:unresolved",
                                    "sort": "freq", "limit": 100, "statsPeriod": "7d"})
    url = f"https://sentry.io/api/0/organizations/{SENTRY_ORG}/issues/?{query}"
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            issues = json.loads(resp.read().decode())
    except Exception as e:  # noqa: BLE001
        collection_errors.append({"cmd": "sentry", "error": str(e)[:300]})
        return
    kept = 0
    stale = []
    non_errors = []
    fresh_cutoff = (datetime.datetime.now(datetime.timezone.utc)
                    - datetime.timedelta(hours=SENTRY_FRESH_HOURS))
    for issue in issues:
        category = str(issue.get("issueCategory") or "").lower()
        level = str(issue.get("level") or "").lower()
        issue_type = str(issue.get("issueType") or issue.get("type") or "").lower()
        # Check the response too: older API payloads may omit category, and
        # error-category log messages may still be informational. Missing fields
        # are not proof of noise, so retain them without inventing an error type.
        if ((category and category != "error") or issue_type.startswith("performance")
                or level in {"debug", "info", "log", "warning", "sample"}):
            non_errors.append({"id": issue.get("id"), "category": category, "level": level})
            continue
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
        meta = issue.get("metadata") or {}
        culprit = (issue.get("culprit") or "unknown").split("/")[-1] or "unknown"
        title = str(issue.get("title") or meta.get("title") or "Untyped Sentry issue")
        error_type = str(meta.get("type") or title)
        sig = f"sentry:joblander-app:{slugify(culprit)}:{slugify(error_type)}"
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
            "sentry_title": title,
            "sentry_level": level or None,
            "sentry_category": category or None,
            "first_seen": issue.get("firstSeen", ""),
            "last_seen": issue.get("lastSeen", ""),
            "severity": sev,
            "sample_message": (f"{error_type}: {meta['value']}" if meta.get("value") else title)[:300],
        }
        kept += 1
    if stale:
        log(f"sentry: {len(stale)} issue(s) skipped as stale "
            f"(no event in {SENTRY_FRESH_HOURS}h): {stale}")
    if non_errors:
        log(f"sentry: {len(non_errors)} non-error issue(s) excluded: {non_errors}")
    log(f"sentry: {len(issues)} issues, {kept} after noise + freshness filters")


def assign_severity(groups, stage_counts, audio_timeouts,
                    geo_misroutes=0, anam_count=0):
    """Thresholds from agents/claude/monitor.md Шаг 4 + §1.5/§1.6 triage rules."""
    for g in groups.values():
        c = g["count"]
        if c > 1000:
            new_sev = "P0"
        elif c > 100:
            new_sev = "P1"
        elif c >= 10:
            new_sev = "P2"
        else:
            new_sev = "P3"
        if "severity" not in g:
            g["severity"] = new_sev
        elif _SEV_RANK.get(new_sev, 0) > _SEV_RANK.get(g["severity"], 0):
            # Generic count thresholds act as a floor-raise: never lower a
            # severity already set by a caller (Sentry/duplicate-worker), but
            # DO raise it if the spike is severe enough (e.g. errors=1001 → P0).
            g["severity"] = new_sev
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
    # Billing-ledger failures: every occurrence is a paid minute lost or a ledger
    # row left wrong, so the count thresholds do not apply. They happen once per
    # affected session — a few a day — which kept them at P3/report_only forever:
    # "Failed to deduct balance atomically" was collected 17 times (26–29.09,
    # asia-south1/us-central1) and never filed, while the backend paged the
    # owner in Telegram for each one (JOB-1114).
    for sig, g in groups.items():
        if (g.get("service") == BILLING_SERVICE
                and sig.rsplit(":", 1)[-1] in BILLING_FAILURE_SLUGS):
            raise_to(sig, "P2")
            g["billing_floor"] = True


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


def _parse_ts(value):
    """Parse an ISO-8601 timestamp into an aware UTC datetime, or None.

    The VM runs Python 3.10, whose fromisoformat() rejects a trailing "Z" and
    any fraction that is not exactly 3 or 6 digits, while Cloud Logging stamps
    entries with nanoseconds. Normalize the fraction to 6 digits first.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    text = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), text, count=1)
    try:
        parsed = datetime.datetime.fromisoformat(text)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def _iso_z(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def merged_pr_url(attachments):
    """URL of the merged GitHub pull request linked to a Linear issue, or None.

    Linear's GitHub integration attaches linked PRs as Attachment rows whose
    `url` is the PR and whose `metadata` carries `status` ("merged") and
    `mergedAt` (verified live on JOB-1109, JOB-1131, JOB-1138, 2026-10-01). An
    open or closed-unmerged PR fixed nothing, so it does not count. With several
    merged PRs the most recently merged one is reported.
    """
    best, best_at = None, None
    nodes = attachments.get("nodes") if isinstance(attachments, dict) else None
    for node in nodes if isinstance(nodes, list) else []:
        if not isinstance(node, dict):
            continue
        url = str(node.get("url") or "").strip()
        meta = node.get("metadata")
        if not _GITHUB_PR_URL_RE.match(url) or not isinstance(meta, dict):
            continue
        if meta.get("status") != "merged" and not meta.get("mergedAt"):
            continue
        merged_at = _parse_ts(meta.get("mergedAt")) or _EPOCH
        if best is None or merged_at > best_at:
            best, best_at = url, merged_at
    return best


def deploy_service(signature, group_service):
    """The Cloud Run service whose deploy puts a fix for this signal live, or None.

    Only two signal families qualify, and for both `last_seen` is a real event
    time: Cloud Run log groups (`<service>:<region>:<slug>`, where the prefix IS
    the group's service) and Sentry (`sentry:<service>:...`, lastSeen). Every
    other prefix is a signal namespace, not a service the change feed tracks:
    `voice-agent:` (worker pools), `cloud-function:`, and the snapshot signals
    `duplicate-worker:` / `monitor-topology:`, which stamp `last_seen` with the
    collection time and would look like a recurrence on every run. Those return
    None and keep the cooldown.
    """
    parts = str(signature).split(":")
    if parts[0] == "sentry" and len(parts) > 2:
        return parts[1]
    if len(parts) > 2 and parts[0] and parts[0] == group_service:
        return parts[0]
    return None


def fix_live_time(service, signature, region, closed_at, now_dt):
    """When the fix for a closed ticket went live: (datetime, source), or None.

    The first `run_deploy` row of the signature's service at or after the
    closure, from change-ingest `GET /changes` (rows: `kind`, `ts` epoch ms,
    `entities` [{type, id}], region as a `region` entity when the audit entry
    named one). Services roll out region by region, so for a signature in a
    real GCP region only a deploy recorded in THAT region counts: another region
    going live, or a row with no region, says nothing about the one that
    errored. A synthetic region (Sentry's "frontend") cannot be pinned to one
    deployment, so the fix counts as live only once every production region in
    REGIONS has deployed after the closure: the latest of those first deploys. If the
    feed is unreachable, unhealthy (503) or holds no qualifying deploy, there
    is no evidence the fix is live: returns None and the caller keeps the
    cooldown.
    """
    since_ms = int((closed_at - _EPOCH).total_seconds() * 1000)
    until_ms = int((now_dt - _EPOCH).total_seconds() * 1000)
    query = urllib.parse.urlencode([
        ("since", since_ms), ("until", until_ms), ("kind", "run_deploy"),
        ("entity", f"service:{service}"), ("limit", 200),
    ])
    try:
        with urllib.request.urlopen(f"{CHANGE_FEED_URL}/changes?{query}", timeout=5) as resp:
            rows = json.loads(resp.read().decode())
    except Exception as e:  # noqa: BLE001 — no deploy evidence: the cooldown is kept
        log(f"fix-check: change feed unavailable for {signature} ({str(e)[:120]}) "
            f"— no deploy evidence, cooldown kept")
        return None
    deploys = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("kind") != "run_deploy":
            continue
        ts = row.get("ts")
        if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts < since_ms:
            continue
        entities = [e for e in row.get("entities") or [] if isinstance(e, dict)]
        if not any(e.get("type") == "service" and e.get("id") == service for e in entities):
            continue
        regions = {e.get("id") for e in entities if e.get("type") == "region"}
        deploys.append((ts, regions))
    if not deploys:
        log(f"fix-check: no {service} deploy in the change feed since the closure "
            f"for {signature} — fix not confirmed live, cooldown kept")
        return None
    deploys.sort(key=lambda d: d[0])
    if region and _GCP_REGION_RE.match(region):
        matching = [d for d in deploys if region in d[1]]
        if not matching:
            log(f"fix-check: no {service} deploy recorded in {region} since the closure for "
                f"{signature} — that region may still serve the old revision, cooldown kept")
            return None
        ts = matching[0][0]
        source = f"change-feed:run_deploy:{service}:{region}"
    else:
        # Not just the regions that happen to have deployed already: during a
        # staggered rollout that subset says nothing about the rest. Require every
        # production region (joblander-app, the Sentry service, runs in exactly
        # REGIONS and each deploy reaches all four, verified 2026-10-01).
        first_per_region = {}
        for d_ts, d_regions in deploys:
            for r in d_regions:
                first_per_region.setdefault(r, d_ts)
        missing = [r for r in REGIONS if r not in first_per_region]
        if missing:
            log(f"fix-check: {service} not yet deployed in {', '.join(missing)} since the "
                f"closure for {signature} — fix not live everywhere, cooldown kept")
            return None
        ts = max(first_per_region[r] for r in REGIONS)
        source = f"change-feed:run_deploy:{service}:all-regions"
    live = _EPOCH + datetime.timedelta(milliseconds=ts)
    log(f"fix-check: {signature} fix live at {_iso_z(live)} ({source})")
    return live, source


def recurred_after_fix(group, cooldown, closed_at, now_dt):
    """The cooldown override for a fix that did not hold, or None.

    Applies only to a Done ticket with a merged PR whose signature was last
    seen after the fix went live. Recurrence before the deploy is expected (the
    old revision is still serving) and keeps the cooldown. Any error returns
    None, which keeps today's behavior: the cooldown applies.
    """
    try:
        pr = cooldown.get("fixed_by_pr")
        if cooldown.get("state_type") != "completed" or not pr:
            return None
        signature = group.get("signature", "")
        service = deploy_service(signature, group.get("service"))
        if service is None:
            log(f"fix-check: {signature} has no deploy tracked by the change feed "
                f"— cooldown kept")
            return None
        last_seen = _parse_ts(group.get("last_seen"))
        if last_seen is None:
            return None
        live = fix_live_time(service, signature, group.get("region"), closed_at, now_dt)
        if live is None:
            return None
        live_at, source = live
        if last_seen <= live_at:
            log(f"fix-check: {group.get('signature')} last seen {_iso_z(last_seen)}, "
                f"before the fix went live {_iso_z(live_at)} — cooldown kept")
            return None
        return {
            "prior_issue": cooldown.get("issue", ""),
            "reason": "recurred-after-fix",
            "fixed_by_pr": pr,
            "fix_live_at": _iso_z(live_at),
            "fix_live_source": source,
        }
    except Exception as e:  # noqa: BLE001 — fail open: the cooldown still applies
        log(f"fix-check: error for {group.get('signature')} (cooldown kept): {str(e)[:200]}")
        return None


def fix_did_not_hold_text(override, last_seen):
    """The sentence the re-filed ticket must carry (title + Problem section)."""
    return (f"fix did not hold: {override['prior_issue']} ({override['fixed_by_pr']}) "
            f"deployed {override['fix_live_at']}, signature seen again at {last_seen}")


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

    # Look back far enough to cover both cooldown windows. This also bounds the
    # fix-did-not-hold check: a fixed ticket is only seen here for 13h, and the
    # override only matters inside the 6h Done cooldown anyway. That is enough
    # because the monitor runs hourly and a merged fix deploys within ~15 min.
    # Do not widen it for the fix check.
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
      state: { type: { in: ["canceled", "completed"] } }
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
      attachments(first: 20) { nodes { url metadata } }
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
                collection_errors.append({"cmd": "linear cooldown", "informational": True,
                                          "error": str(result["errors"])[:300]})
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
        collection_errors.append({"cmd": "linear cooldown", "informational": True,
                                  "error": str(e)[:300]})
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
            # A merged GitHub PR linked to the ticket: it was closed by a fix,
            # so a recurrence after that fix deployed must not stay silent.
            "fixed_by_pr": merged_pr_url(node.get("attachments")),
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
                                      "sentry_url", "user_count", "sentry_title",
                                      "sentry_level", "sentry_category", "request_context")}
        item["window"] = g.get("window", f"{WINDOW_HOURS}h")
        item["suggested_title"] = f"[Monitor] {g['service']} {g['region']}: {g['signature'].split(':')[-1]}"

        # --- Cooldown gate (JOB-858) ---
        # P0 is always exempt: a DOWN server or a massive spike must never be
        # silenced by a cooldown.  For all other severities, if this signature's
        # prior Linear ticket was recently closed (Canceled within
        # COOLDOWN_HOURS_CANCELED, Done within COOLDOWN_HOURS_DONE), suppress
        # re-filing so the dispatcher's adjudication isn't reversed an hour later.
        # Exception: a Done ticket fixed by a merged PR whose signature is seen
        # again after that fix deployed — the fix did not hold, so re-file.
        refile_after_fix = False
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
                        fix_override = recurred_after_fix(g, cd, closed_at, now_dt)
                        if fix_override:
                            text = fix_did_not_hold_text(fix_override, g.get("last_seen"))
                            log(f"cooldown: OVERRIDE for {g['signature']} — {text} "
                                f"(source {fix_override['fix_live_source']})")
                            item["cooldown_override"] = {
                                **fix_override,
                                "prior_severity": prior_sev,
                                "current_severity": sev,
                            }
                            item["fix_did_not_hold"] = text
                            # Keep the [Monitor] prefix: the cooldown query
                            # selects tickets by it.
                            item["suggested_title"] = (
                                f"{item['suggested_title']} — fix did not hold "
                                f"({fix_override['prior_issue']})")
                            refile_after_fix = True
                            # Fall through to normal escalation path.
                        elif _SEV_RANK.get(sev, 0) > _SEV_RANK.get(prior_sev, 0):
                            log(f"cooldown: OVERRIDE for {g['signature']} — "
                                f"severity escalated {prior_sev}→{sev} "
                                f"(prior {cd['issue']} {state_type} {age_h:.1f}h ago)")
                            item["cooldown_override"] = {
                                "prior_issue": cd["issue"],
                                "reason": "severity-escalated",
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
        elif (sev == "P1"
              and g.get("signature") == "duplicate-worker:purchased-minutes-reduced"):
            # Financial-integrity signal: purchased minutes were reduced — must
            # NEVER happen per the spec (JOB-1010).  Emit immediate Telegram even
            # though this is P1, not P0, because the constitition mandates it.
            text = (f"URGENT P1 — PURCHASED MINUTES REDUCED: "
                    f"{g.get('sample_message', g.get('signature', ''))[:200]}")
            p0_alerts.append(text)
            item["action"] = "telegram_p1_financial_and_linear"
            item["alert_text"] = text
        elif sev == "P1" and status in ("new", "worsened"):
            item["action"] = "linear_create_if_no_dup"
        elif sev == "P1" and status == "recurring":
            item["action"] = "linear_ensure_open_issue"
        elif refile_after_fix and sev in ("P1", "P2"):
            # A recurrence right after the deploy is usually still in the
            # previous report (pre-fix events share the 2h window), so its
            # diff_status is `recurring`/`improved`, which would otherwise be
            # report_only. The prior ticket is Done, so this files a new one.
            # P3 stays report_only, as for any other P3 signal.
            item["action"] = "linear_create_if_no_dup"
        elif sev == "P2" and status == "new":
            item["action"] = "linear_create_if_no_dup"
        elif sev == "P2" and g.get("billing_floor") and not g.get("linear_issue"):
            # A billing failure already in the previous report (e.g. as the
            # former P3, or a filing that did not land) is `recurring`, not
            # `new`; without this it stays report_only until it ages out of
            # the window unfiled. The session dedups against open issues.
            item["action"] = "linear_create_if_no_dup"
        else:
            item["action"] = "report_only"
        escalations.append(item)
    return p0_alerts, escalations


def _firestore_doc_fields(collection, doc_id, token):
    """Fetch a Firestore document via REST and return its fields dict.

    Returns {} on 404 (document absent) or returns None on HTTP errors / network
    failures.  Authentication uses the supplied bearer token.
    """
    url = (f"https://firestore.googleapis.com/v1/projects/{PROJECT}"
           f"/databases/(default)/documents/{collection}/{doc_id}")
    try:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode()).get("fields", {})
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {}   # document does not exist
        raise
    except Exception:  # noqa: BLE001
        raise


def _fs_int(fields, name):
    """Extract an integer from a Firestore typed-value field."""
    f = fields.get(name, {})
    v = f.get("integerValue") or f.get("doubleValue")
    return int(float(v)) if v is not None else 0


def _fs_str(fields, name):
    """Extract a string from a Firestore typed-value field."""
    return fields.get(name, {}).get("stringValue") or ""


def check_duplicate_worker(groups):
    """Monitor the daily duplicate-free-grant worker (JOB-1007/JOB-1010).

    Checks Firestore: `duplicate_worker_runs/{yesterday}`:
    - Document missing or errors > 0 → P2 (worker did not complete cleanly).
    - purchasedMinutesReduced > 0 → P1 (must never happen; immediate Telegram).
    - mode in doc != DUPLICATE_WORKER_MODE env var → P2 (config drift).
    - revokedMinutes/day > 3× trailing 7-day median → P2 (false-positive wave).

    Skipped when DUPLICATE_WORKER_MODE=off (worker not yet live).
    All Firestore failures are informational — never count toward hard_fail.
    """
    mode = os.environ.get("DUPLICATE_WORKER_MODE", "off").strip()
    if mode == "off":
        return

    # Obtain an access token via ADC (Application Default Credentials).
    token_raw = run_cmd(["gcloud", "auth", "print-access-token"], optional=True)
    token = (token_raw or "").strip()
    if not token:
        collection_errors.append({
            "cmd": "check_duplicate_worker",
            "error": "no GCP access token — duplicate worker check skipped",
            "informational": True,
        })
        return

    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    now = utcnow_iso()

    # --- Fetch yesterday's run record ---
    try:
        fields = _firestore_doc_fields("duplicate_worker_runs", yesterday, token)
    except Exception as e:  # noqa: BLE001
        collection_errors.append({
            "cmd": "check_duplicate_worker",
            "error": f"Firestore error fetching duplicate_worker_runs/{yesterday}: {str(e)[:200]}",
            "informational": True,
        })
        return

    if not fields:
        # Document absent → worker did not run or failed before persisting.
        sig = "duplicate-worker:missing-run"
        groups[sig] = {
            "signature": sig,
            "service": "backend",
            "region": "europe-west1",
            "count": 1,
            "first_seen": now,
            "last_seen": now,
            "severity": "P2",
            "sample_message": (
                f"duplicate_worker_runs/{yesterday} not found in Firestore — "
                f"daily duplicate-free-grant worker (DUPLICATE_WORKER_MODE={mode}) "
                f"did not run or failed to persist its run record."
            ),
        }
        log(f"duplicate worker check: {yesterday} — run record MISSING")
        return

    errors_count = _fs_int(fields, "errors")
    purchased_reduced = _fs_int(fields, "purchasedMinutesReduced")
    revoked_minutes = _fs_int(fields, "revokedMinutes")
    doc_mode = _fs_str(fields, "mode")

    log(f"duplicate worker check: {yesterday} mode={doc_mode!r} errors={errors_count} "
        f"purchasedReduced={purchased_reduced} revokedMinutes={revoked_minutes}")

    # --- Check 1: errors > 0 → P2 ---
    if errors_count > 0:
        sig = "duplicate-worker:run-errors"
        groups[sig] = {
            "signature": sig,
            "service": "backend",
            "region": "europe-west1",
            "count": errors_count,
            "first_seen": now,
            "last_seen": now,
            "severity": "P2",
            "sample_message": (
                f"duplicate_worker_runs/{yesterday}: errors={errors_count} "
                f"(mode={doc_mode}). Daily duplicate worker completed with errors."
            ),
        }

    # --- Check 2: purchasedMinutesReduced > 0 → P1 (must NEVER happen) ---
    if purchased_reduced > 0:
        sig = "duplicate-worker:purchased-minutes-reduced"
        groups[sig] = {
            "signature": sig,
            "service": "backend",
            "region": "europe-west1",
            "count": purchased_reduced,
            "first_seen": now,
            "last_seen": now,
            "severity": "P1",
            "sample_message": (
                f"CRITICAL: duplicate_worker_runs/{yesterday}: "
                f"purchasedMinutesReduced={purchased_reduced} — "
                "the duplicate worker reduced purchased minutes, which must never happen."
            ),
        }

    # --- Check 3: mode mismatch → P2 ---
    if doc_mode and doc_mode != mode:
        sig = "duplicate-worker:mode-mismatch"
        groups[sig] = {
            "signature": sig,
            "service": "backend",
            "region": "europe-west1",
            "count": 1,
            "first_seen": now,
            "last_seen": now,
            "severity": "P2",
            "sample_message": (
                f"duplicate_worker_runs/{yesterday}: mode={doc_mode!r} but "
                f"DUPLICATE_WORKER_MODE env={mode!r}. Configuration drift?"
            ),
        }

    # --- Check 4: revocation spike → P2 ---
    # revokedMinutes/day > 3× trailing 7-day median (possible false-positive wave).
    if revoked_minutes > 0:
        _check_duplicate_worker_spike(groups, revoked_minutes, token, now)


def _check_duplicate_worker_spike(groups, today_revoked, token, now):
    """P2 when today's revokedMinutes > 3× the trailing 7-day median.

    Needs ≥3 prior data points; skips silently if Firestore is unavailable or
    history is too thin.  All fetch failures are informational.
    """
    prior = []
    # Offsets 2–8 give the 7 days BEFORE yesterday (the monitored date).
    # Offset 1 would be yesterday itself — that's what we're comparing against,
    # so it must not appear in the baseline history.
    for offset in range(2, 9):
        day = (datetime.date.today() - datetime.timedelta(days=offset)).isoformat()
        try:
            f = _firestore_doc_fields("duplicate_worker_runs", day, token)
            if f:
                prior.append(_fs_int(f, "revokedMinutes"))
        except Exception as e:  # noqa: BLE001
            collection_errors.append({
                "cmd": f"check_duplicate_worker_spike/{day}",
                "error": str(e)[:200],
                "informational": True,
            })

    if len(prior) < 3:
        return  # insufficient history

    median = statistics.median(prior)
    if median > 0 and today_revoked > 3 * median:
        sig = "duplicate-worker:revocation-spike"
        groups[sig] = {
            "signature": sig,
            "service": "backend",
            "region": "europe-west1",
            "count": today_revoked,
            "first_seen": now,
            "last_seen": now,
            "severity": "P2",
            "sample_message": (
                f"Duplicate worker revoked {today_revoked} free minutes today — "
                f">3× trailing 7-day median ({median}). "
                "Possible false-positive wave (e.g. new campus NAT)."
            ),
        }


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    groups = {}
    topology = inspect_targets(TARGETS)
    for target in topology:
        if target["status"] in {"READY", "MATCH"}:
            continue
        sig = f'monitor-topology:{target["region"]}:{target["name"]}'
        groups[sig] = {"signature": sig, "service": "ai-voice-agent-python", "region": target["region"],
                       "count": 1, "severity": "P2", "first_seen": utcnow_iso(), "last_seen": utcnow_iso(),
                       "sample_message": f'Monitoring target {target["name"]}: {target["status"]}. Verify targets.json against deployment intent; do not restore retired infrastructure.'}
    collect_cloud_run(groups)
    collect_cloud_functions(groups)
    collect_voice_agent_errors(groups)
    stage_counts = collect_stage_errors(groups)
    audio_timeouts = collect_audio_timeouts(groups)
    geo_misroutes = collect_geo_misroutes(groups)
    anam_count = collect_anam_failures(groups)
    collect_transcription_delay(groups)
    collect_sentry(groups)

    # JOB-1010: check that the daily duplicate-free-grant worker ran and
    # produced no errors. Skipped when DUPLICATE_WORKER_MODE=off.
    # Must run BEFORE assign_severity so severity can be adjusted by the
    # generic count thresholds like any other group.
    check_duplicate_worker(groups)

    assign_severity(groups, stage_counts, audio_timeouts,
                    geo_misroutes, anam_count)
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
        # Per-service status: derived from collected
        # error groups — DEGRADED if any active P0/P1 group, else HEALTHY.
        def service_status(svc_name):
            sev = {g.get("severity") for g in final_groups
                   if g.get("service") == svc_name and g.get("diff_status") != "resolved"}
            return "DEGRADED" if sev & {"P0", "P1"} else "HEALTHY"

        services = {
            svc: {"status": service_status(svc)}
            for svc in ("joblander-app", "joblander-audio-engine", "email-service")
        }
        services["ai-voice-agent-python"] = {
            "status": worker_service_status(service_status("ai-voice-agent-python"), topology),
            "hosting": "cloud-run-worker-pools",
        }
        services["livekit"] = {
            "hosting": "cloud", "status": "MANAGED" if topology[-1]["status"] == "MATCH" else topology[-1]["status"],
        }
        report = {
            "timestamp": now,
            "window_hours": WINDOW_HOURS,
            "generated_by": "self-healing/monitor/triage.py",
            "services": services,
            "monitoring_topology": {"revision": revision(TARGETS), "observations": topology},
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
