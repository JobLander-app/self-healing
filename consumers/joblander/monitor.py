"""JobLander-specific product signals; loaded only by its consumer profile."""
import datetime
import json
import os
import re
import statistics
import urllib.request

core = None


def configure(api):
    global core
    core = api


BILLING_SERVICE = "joblander-audio-engine"
BILLING_FAILURE_SLUGS = frozenset({
    "failed-to-deduct-balance-atomically",
    "failed-to-record-balance-transaction",
    "failed-to-persist-final-meeting-balance",
})

def voice_agent_region(entry):
    return entry.get("resource", {}).get("labels", {}).get("location", "unknown")


def collect_voice_agent_errors(groups):
    # The worker's JSON logger supplies level, not always GCP severity.
    entries = core.gcloud_logging_read(
        f'{core.VOICE_AGENT_LOG_FILTER} AND (severity>=ERROR OR '
        'jsonPayload.level=~"(?i)^(error|critical|fatal)$")', limit=core.QUERY_LIMIT
    )
    for e in entries:
        region = voice_agent_region(e)
        msg = core.entry_message(e)
        core.add_to_groups(groups, f"voice-agent:{region}:{core.slugify(msg)}",
                      "ai-voice-agent-python", region, e.get("timestamp", ""), msg)
    core.log(f"voice agent workers: {len(entries)} error entries")


def collect_stage_errors(groups):
    entries = core.gcloud_logging_read(
        f'{core.VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"STAGE_ERROR"', limit=core.QUERY_LIMIT
    )
    by_code = {}
    for e in entries:
        msg = core.entry_message(e)
        m = re.search(r"status_code=(\d{3})", msg)
        code = m.group(1) if m else "unknown"
        by_code.setdefault(code, []).append((e.get("timestamp", ""), msg))
    for code, items in by_code.items():
        items.sort()
        sig = f"voice-agent:all:stage-error-{code}"
        for ts, msg in items:
            core.add_to_groups(groups, sig, "ai-voice-agent-python", "all", ts, msg)
    core.log(f"stage errors: {len(entries)} entries")
    return {code: len(items) for code, items in by_code.items()}


def collect_audio_timeouts(groups):
    entries = core.gcloud_logging_read(
        f'{core.VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"Audio Timeout Error"', limit=core.QUERY_LIMIT
    )
    for e in entries:
        msg = core.entry_message(e)
        core.add_to_groups(groups, "voice-agent:all:audio-timeout-error",
                      "ai-voice-agent-python", "all", e.get("timestamp", ""), msg)
    core.log(f"audio timeouts: {len(entries)} entries")
    return len(entries)


def collect_geo_misroutes(groups):
    """monitor.md §1.5: `country=IN → eu` in geo logs = Indian users misrouted
    (defeats the purpose of the asia-south1 region) → P1."""
    entries = core.gcloud_logging_read(
        'resource.type="cloud_run_revision" AND resource.labels.service_name="joblander-app" '
        'AND textPayload=~"\\[geo\\]"', limit=core.QUERY_LIMIT
    )
    misroutes = []
    for e in entries:
        msg = core.entry_message(e)
        m = re.search(r"country=(\w+).*→\s*(\S+)", msg)
        if m and m.group(1) == "IN" and m.group(2) != "india":
            misroutes.append((e.get("timestamp", ""), msg))
    for ts, msg in sorted(misroutes):
        core.add_to_groups(groups, "joblander-app:geo:in-users-misrouted",
                      "joblander-app", "geo-routing", ts, msg)
    # Severity floor (P1) is applied in assign_severity via raise_to so the
    # generic count thresholds can still escalate a massive spike to P0.
    core.log(f"geo: {len(entries)} entries, {len(misroutes)} IN misroutes")
    return len(misroutes)


def collect_anam_failures(groups):
    """monitor.md §1.5: Anam `Failed to start avatar` > 3/2h → P2."""
    entries = core.gcloud_logging_read(
        f'{core.VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"Failed to start avatar"',
        limit=core.QUERY_LIMIT,
    )
    for e in entries:
        core.add_to_groups(groups, "voice-agent:all:anam-avatar-start-failed",
                      "ai-voice-agent-python", "all", e.get("timestamp", ""), core.entry_message(e))
    # Severity floor (P2 when >3/2h) is applied in assign_severity via
    # raise_to so the generic thresholds can still escalate to P1/P0.
    core.log(f"anam failures: {len(entries)} entries")
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
    entries = core.gcloud_logging_read(
        f'{core.VOICE_AGENT_LOG_FILTER} AND jsonPayload.message=~"TURN_LATENCY EOUMetrics"',
        limit=core.QUERY_LIMIT,
    )
    rows = {}
    for e in entries:
        m = TURN_LATENCY_RE.search(core.entry_message(e))
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
    now = core.utcnow_iso()
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
    core.log(f"turn latency: {len(entries)} entries, {len(rows)} turns, "
        f"{len(by_rl)} region/lang groups")


def _firestore_doc_fields(collection, doc_id, token):
    """Fetch a Firestore document via REST and return its fields dict.

    Returns {} on 404 (document absent) or returns None on HTTP errors / network
    failures.  Authentication uses the supplied bearer token.
    """
    url = (f"https://firestore.googleapis.com/v1/projects/{core.PROJECT}"
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
    """Monitor the daily duplicate-free-grant worker and report invalid run results."""
    mode = os.environ.get("DUPLICATE_WORKER_MODE", "off").strip()
    if mode == "off":
        return

    # Obtain an access token via ADC (Application Default Credentials).
    token_raw = core.run_cmd(["gcloud", "auth", "print-access-token"], optional=True)
    token = (token_raw or "").strip()
    if not token:
        core.collection_errors.append({
            "cmd": "check_duplicate_worker",
            "error": "no GCP access token — duplicate worker check skipped",
            "informational": True,
        })
        return

    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    now = core.utcnow_iso()

    # --- Fetch yesterday's run record ---
    try:
        fields = _firestore_doc_fields("duplicate_worker_runs", yesterday, token)
    except Exception as e:  # noqa: BLE001
        core.collection_errors.append({
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
        core.log(f"duplicate worker check: {yesterday} — run record MISSING")
        return

    errors_count = _fs_int(fields, "errors")
    purchased_reduced = _fs_int(fields, "purchasedMinutesReduced")
    revoked_minutes = _fs_int(fields, "revokedMinutes")
    doc_mode = _fs_str(fields, "mode")

    core.log(f"duplicate worker check: {yesterday} mode={doc_mode!r} errors={errors_count} "
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
            core.collection_errors.append({
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



def collect(groups, topology):
    collect_voice_agent_errors(groups)
    stage = collect_stage_errors(groups)
    audio = collect_audio_timeouts(groups)
    geo = collect_geo_misroutes(groups)
    anam = collect_anam_failures(groups)
    collect_transcription_delay(groups)
    check_duplicate_worker(groups)
    return stage, audio, geo, anam


def severity(groups, stage_counts=None, audio_timeouts=0, geo_misroutes=0, anam_count=0):
    stage_counts = stage_counts or {}
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
    for sig, g in groups.items():
        if (g.get("service") == BILLING_SERVICE
                and sig.rsplit(":", 1)[-1] in BILLING_FAILURE_SLUGS):
            raise_to(sig, "P2")
            g["ensure_open_issue"] = True


def services(service_status, topology):
    livekit = next((o for o in topology if o.get("kind") == "livekit-config"), None)
    return {
        "ai-voice-agent-python": {"status": core.worker_service_status(service_status("ai-voice-agent-python"), topology),
                                  "hosting": "cloud-run-worker-pools"},
        "livekit": {"hosting": "cloud", "status": "COVERAGE_ENDED" if livekit is None else
                    "MANAGED" if livekit["status"] == "MATCH" else livekit["status"]},
    }


def page(group):
    if group.get("severity") == "P1" and group.get("signature") == "duplicate-worker:purchased-minutes-reduced":
        return f"URGENT P1 — PURCHASED MINUTES REDUCED: {group.get('sample_message', '')[:200]}"
    return None
