"use strict";
/**
 * Disk-backed run state — the only persistence layer this daemon has.
 *
 * Per the stateless design (see config.ts), we do NOT use a database.
 * Instead, every dispatch run appends newline-delimited JSON events to
 * {logDir}/{turn_id}.jsonl, and we keep a small in-memory ring of recent
 * run summaries to serve /status and /feed. On restart the in-memory ring
 * is repopulated by reading the most recent JSONL files off disk, so the
 * HTTP surface survives a daemon bounce without needing a DB.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.traceEvent = traceEvent;
exports.recordRun = recordRun;
exports.getRecentRuns = getRecentRuns;
exports.getLastRun = getLastRun;
exports.hydrateFromDisk = hydrateFromDisk;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("./config");
const metrics_1 = require("./metrics");
const RING_SIZE = 50;
const ring = [];
function ensureLogDir() {
    try {
        fs.mkdirSync(config_1.config.logDir, { recursive: true });
        return true;
    }
    catch (err) {
        console.error(`[trace] Cannot create logDir ${config_1.config.logDir}:`, err);
        return false;
    }
}
function traceFile(turnId) {
    return path.join(config_1.config.logDir, `${turnId}.jsonl`);
}
/** Append one structured event to the run's JSONL trace. Best-effort. */
function traceEvent(turnId, kind, data) {
    if (!ensureLogDir())
        return;
    const event = { ts: new Date().toISOString(), turnId, kind, data };
    try {
        fs.appendFileSync(traceFile(turnId), JSON.stringify(event) + "\n");
    }
    catch (err) {
        console.error(`[trace] Failed to append event for ${turnId}:`, err);
    }
}
/** Record a completed run: append a final event and push to the ring. */
function recordRun(summary) {
    traceEvent(summary.turnId, "run_summary", { ...summary });
    ring.unshift(summary);
    if (ring.length > RING_SIZE)
        ring.length = RING_SIZE;
    // JOB-731: feed the monotonic Prometheus run counters (runs_total, cost_usd).
    (0, metrics_1.incrementRunCounters)({ outcome: summary.outcome, costUsd: summary.costUsd });
}
function getRecentRuns(limit = 20) {
    return ring.slice(0, limit);
}
function getLastRun() {
    return ring[0] ?? null;
}
/**
 * Repopulate the in-memory ring from disk on startup, so /status and /feed
 * are meaningful immediately after a restart. Reads the most recent
 * RING_SIZE trace files and extracts their `run_summary` event if present.
 */
function hydrateFromDisk() {
    if (!ensureLogDir())
        return;
    let files;
    try {
        files = fs
            .readdirSync(config_1.config.logDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, m: fs.statSync(path.join(config_1.config.logDir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m)
            .slice(0, RING_SIZE)
            .map((x) => x.f);
    }
    catch (err) {
        console.error("[trace] hydrateFromDisk readdir failed:", err);
        return;
    }
    // Oldest-first so the ring ends up newest-first after unshift.
    for (const file of files.reverse()) {
        try {
            const lines = fs.readFileSync(path.join(config_1.config.logDir, file), "utf-8").trim().split("\n");
            for (const line of lines) {
                const ev = JSON.parse(line);
                if (ev.kind === "run_summary" && ev.data) {
                    ring.unshift(ev.data);
                    if (ring.length > RING_SIZE)
                        ring.length = RING_SIZE;
                    // JOB-731: best-effort rehydrate the monotonic run counters so a
                    // daemon bounce doesn't zero recent history. hydrateFromDisk is not
                    // routed through recordRun, so increment here directly (no double
                    // count). An unrecognised outcome buckets to `unknown`.
                    (0, metrics_1.incrementRunCounters)({
                        outcome: ev.data.outcome,
                        costUsd: typeof ev.data.costUsd === "number" ? ev.data.costUsd : 0,
                    });
                }
            }
        }
        catch {
            // Skip malformed/partial trace files.
        }
    }
}
//# sourceMappingURL=trace.js.map