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
        add_to_groups(groups, signature,
                      service, region, e.get("timestamp", ""), msg)
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
        elif sev == "P2" and status == "new":
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
