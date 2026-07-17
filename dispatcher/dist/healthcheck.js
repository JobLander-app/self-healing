"use strict";
/**
 * Dispatcher dependency healthcheck (JOB-731 follow-up).
 *
 * Ported from the proven handy-daemon pattern
 * (handy-daemon/src/healthcheck.ts) but pointed INWARD: instead of alerting a
 * human to go fix a downed MCP, on failure it files a Linear ticket that the
 * dispatcher's OWN poll loop picks up (`monitor` label) and repairs — the
 * self-healing loop healing its own toolchain.
 *
 * CRITICAL: like handy's, this runs entirely OUTSIDE the agent — plain Node
 * fetch / child_process / stdio JSON-RPC, NEVER via Claude tools. A healthcheck
 * that needed the agent to run couldn't verify the agent's dependencies.
 *
 * The five dependencies the dispatch session actually leans on:
 *   1. firebase MCP  — real Firestore reads during investigation (ADC + datastore.viewer)
 *   2. sentry MCP    — Sentry issue lookups (sentry token)
 *   3. gcp/gcloud    — `gcloud logging read` is the primary investigation channel (SA log access)
 *   4. claude-oauth  — the OAuth token the agent session authenticates with
 *   5. linear        — the work queue + the durable `In Progress` claim
 *
 * Every probe is individually try/caught and time-bounded; the whole run is
 * wrapped so a hang or throw can never wedge the poll loop or crash the daemon.
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
exports.getLastHealthcheck = getLastHealthcheck;
exports.runHealthcheck = runHealthcheck;
exports.startHealthcheckCron = startHealthcheckCron;
const cron = __importStar(require("node-cron"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const config_1 = require("./config");
const notify_1 = require("./notify");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// ---------------------------------------------------------------------------
// Coupling with session.ts (NOTED, intentional).
//
// session.ts derives the vendored MCP entry paths and the child env the same
// way. Those helpers are not exported from session.ts, so we MIRROR them here
// verbatim. healthcheck.ts compiles to the same dispatcher/dist directory as
// session.js, so __dirname/../.. resolves to the repo root identically. If
// session.ts's resolution ever changes, this must change with it.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIREBASE_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "firebase", "index.js");
const SENTRY_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "sentry", "index.js");
const LINEAR_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "linear", "index.js");
function buildMcpEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string")
            env[k] = v;
    }
    env.GCP_PROJECT_ID = env.GCP_PROJECT_ID || config_1.config.gcpProject;
    // Linear MCP child auth for probeLinear — cachedLinearKey is populated by the
    // resolveLinearApiKey() awaited at the top of probeLinear before probeMcp
    // spawns the child. Harmless for the firebase/sentry children.
    if (cachedLinearKey)
        env.LINEAR_API_KEY = env.LINEAR_API_KEY || cachedLinearKey;
    return env;
}
let lastHealthcheck = null;
function getLastHealthcheck() {
    return lastHealthcheck;
}
function resultText(r) {
    if (!r || !Array.isArray(r.content))
        return "";
    return r.content
        .map((c) => (typeof c?.text === "string" ? c.text : ""))
        .join(" ")
        .trim();
}
async function probeMcp(input) {
    const deadline = Date.now() + input.budgetMs;
    const child = (0, child_process_1.spawn)("node", [input.entry], {
        env: buildMcpEnv(),
        stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let buf = "";
    let spawnErr = null;
    child.on("error", (e) => {
        spawnErr = e instanceof Error ? e : new Error(String(e));
        for (const resolve of pending.values())
            resolve({ error: { message: spawnErr.message } });
        pending.clear();
    });
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line)
                continue;
            try {
                const msg = JSON.parse(line);
                if (typeof msg.id === "number" && pending.has(msg.id)) {
                    pending.get(msg.id)(msg);
                    pending.delete(msg.id);
                }
            }
            catch {
                /* server banners / non-JSON go to stderr; ignore anything unparseable */
            }
        }
    });
    const send = (msg) => {
        try {
            child.stdin.write(JSON.stringify(msg) + "\n");
        }
        catch {
            /* write-after-end on a dead child — the request timeout handles it */
        }
    };
    const request = (id, method, params) => new Promise((resolve, reject) => {
        if (spawnErr)
            return reject(spawnErr);
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return reject(new Error(`${method}: probe budget exhausted`));
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${method}: timed out`));
        }, remaining);
        pending.set(id, (r) => {
            clearTimeout(timer);
            resolve(r);
        });
        send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
    try {
        const initRes = await request(1, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "dispatcher-healthcheck", version: "1.0.0" },
        });
        if (initRes.error)
            throw new Error(`initialize: ${initRes.error.message}`);
        // Fire-and-forget the initialized notification (no id, no response).
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const listRes = await request(2, "tools/list", {});
        if (listRes.error)
            throw new Error(`tools/list: ${listRes.error.message}`);
        const toolCount = Array.isArray(listRes.result?.tools) ? listRes.result.tools.length : 0;
        if (toolCount === 0)
            throw new Error("tools/list returned 0 tools");
        const callRes = await request(3, "tools/call", {
            name: input.smokeTool,
            arguments: input.smokeArgs,
        });
        if (callRes.error)
            throw new Error(`${input.smokeTool}: ${callRes.error.message}`);
        if (callRes.result?.isError === true) {
            throw new Error(`${input.smokeTool} isError: ${resultText(callRes.result).slice(0, 200)}`);
        }
        return { detail: `${toolCount} tools, ${input.smokeTool} smoke ok` };
    }
    finally {
        child.kill("SIGKILL");
    }
}
// ---------------------------------------------------------------------------
// Secret resolution — same subprocess mechanism the rest of the daemon uses
// (`gcloud secrets versions access`, no SDK). Env override short-circuits.
// ---------------------------------------------------------------------------
async function resolveSecret(input) {
    if (input.envVar && process.env[input.envVar]) {
        return String(process.env[input.envVar]).trim();
    }
    const { stdout } = await execFileAsync("gcloud", ["secrets", "versions", "access", "latest", `--secret=${input.secret}`, `--project=${config_1.config.gcpProject}`], { timeout: input.timeoutMs });
    return stdout.trim();
}
// Mirrors poller.ts resolveLinearApiKey (not exported there). Cached per process.
let cachedLinearKey = "";
async function resolveLinearApiKey() {
    if (cachedLinearKey)
        return cachedLinearKey;
    const key = await resolveSecret({ envVar: "LINEAR_API_KEY", secret: config_1.LINEAR_API_KEY_SECRET, timeoutMs: 15_000 });
    if (!key)
        throw new Error(`${config_1.LINEAR_API_KEY_SECRET} resolved empty`);
    cachedLinearKey = key;
    return key;
}
// ---------------------------------------------------------------------------
// The five probes. Each returns {healthy, detail}; timing + try/catch is added
// by the runner so one probe can never take down the others.
// ---------------------------------------------------------------------------
async function probeFirebase() {
    // stdio MCP: initialize → tools/list(>0) → firestore_list_collections (not
    // isError). Exercises ADC + datastore.viewer end to end — the real "can I
    // read Firestore" question, not just process liveness.
    const { detail } = await probeMcp({
        entry: FIREBASE_MCP_ENTRY,
        smokeTool: "firestore_list_collections",
        smokeArgs: {},
        budgetMs: 15_000,
    });
    return detail;
}
async function probeSentry() {
    // stdio MCP: initialize → tools/list(>0) → sentry_list_issues (not isError).
    // Exercises the sentry token (SENTRY_TOKEN env or Secret Manager).
    const { detail } = await probeMcp({
        entry: SENTRY_MCP_ENTRY,
        smokeTool: "sentry_list_issues",
        smokeArgs: { statsPeriod: "24h", limit: 1 },
        budgetMs: 15_000,
    });
    return detail;
}
async function probeGcloud() {
    // A real read against Cloud Run logs — proves the SA can read the log channel
    // the dispatcher investigates through. Exit 0 within the timeout = healthy.
    await execFileAsync("gcloud", [
        "logging",
        "read",
        'resource.type="cloud_run_revision"',
        `--project=${config_1.config.gcpProject}`,
        "--limit=1",
        "--format=value(timestamp)",
    ], { timeout: 15_000 });
    return "gcloud logging read (cloud_run_revision) exit 0";
}
async function probeClaudeOauth() {
    // Presence-only. We deliberately do NOT call the Anthropic API — token
    // EXPIRY is a known gap this probe cannot see. But an empty/absent token is
    // the exact silent failure that broke the hourly monitor when the SA lacked
    // Secret Manager access, so surfacing "present & non-empty" is worthwhile.
    const token = await resolveSecret({
        envVar: "CLAUDE_CODE_OAUTH_TOKEN",
        secret: config_1.CLAUDE_OAUTH_SECRET,
        timeoutMs: 15_000,
    });
    if (!token)
        throw new Error(`${config_1.CLAUDE_OAUTH_SECRET} resolved empty`);
    return `token present (${token.length} chars); expiry not checked (known gap)`;
}
async function probeLinear() {
    // stdio MCP: initialize → tools/list(>0) → list_teams (not isError). This
    // smokes the ACTUAL path the agent now uses — the vendored mcp/linear server
    // spawned with the never-expiring LINEAR_API_KEY — not just that the Linear
    // GraphQL API is reachable. resolveLinearApiKey() runs first so buildMcpEnv()
    // can inject the key into the child (and so an unreadable secret fails fast
    // with a clear message instead of a generic MCP isError).
    await resolveLinearApiKey();
    const { detail } = await probeMcp({
        entry: LINEAR_MCP_ENTRY,
        smokeTool: "list_teams",
        smokeArgs: {},
        budgetMs: 15_000,
    });
    return detail;
}
const PROBES = [
    { dep: "firebase", run: probeFirebase },
    { dep: "sentry", run: probeSentry },
    { dep: "gcp", run: probeGcloud },
    { dep: "claude-oauth-token", run: probeClaudeOauth },
    { dep: "linear", run: probeLinear },
];
async function runProbe(p) {
    const started = Date.now();
    try {
        const detail = await p.run();
        return { dep: p.dep, healthy: true, detail, latencyMs: Date.now() - started };
    }
    catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { dep: p.dep, healthy: false, detail, latencyMs: Date.now() - started };
    }
}
// ---------------------------------------------------------------------------
// Inward auto-repair: on a failed dep, file a `monitor`-labelled Linear ticket
// the dispatcher's own poll loop will pick up. Same issueCreate GraphQL the
// watcher uses. DEDUP first: never file a second ticket for a dep that already
// has an open [SelfHeal] ticket — and skip the Telegram too in that case, so
// the "Filing repair ticket" message stays truthful and we don't re-alert every
// 6h for a known-down dep.
// ---------------------------------------------------------------------------
function selfHealTitle(dep) {
    return `[SelfHeal] dispatcher dependency: ${dep} down`;
}
async function openSelfHealTicketExists(input) {
    const filter = {
        team: { id: { eq: config_1.LINEAR_JOB_TEAM_ID } },
        labels: { name: { eq: "monitor" } },
        title: { contains: selfHealTitle(input.dep) },
        // "open" = not completed / not canceled.
        state: { type: { in: ["triage", "backlog", "unstarted", "started"] } },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: input.key },
            body: JSON.stringify({
                query: "query($filter: IssueFilter!){ issues(filter:$filter, first:1){ nodes{ identifier } } }",
                variables: { filter },
            }),
            signal: controller.signal,
        });
        if (!res.ok)
            throw new Error(`dedup HTTP ${res.status}`);
        const body = (await res.json());
        if (body.errors && body.errors.length > 0) {
            throw new Error(`dedup GraphQL errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
        }
        const nodes = body.data?.issues?.nodes;
        return Array.isArray(nodes) && nodes.length > 0;
    }
    finally {
        clearTimeout(timer);
    }
}
async function fileSelfHealTicket(input) {
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: input.key },
        body: JSON.stringify({
            query: "mutation($i:IssueCreateInput!){ issueCreate(input:$i){ success issue{ identifier } } }",
            variables: {
                i: {
                    teamId: config_1.LINEAR_JOB_TEAM_ID,
                    title: selfHealTitle(input.dep),
                    description: `${input.detail}\n\ncheck mcp/${input.dep}/ or the SA roles / secret; fix and PR`,
                    labelIds: [config_1.LINEAR_MONITOR_LABEL_ID],
                    priority: 1,
                },
            },
        }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
        throw new Error(`issueCreate HTTP ${res.status}`);
    const body = (await res.json());
    return body.data?.issueCreate?.issue?.identifier ?? null;
}
async function handleFailure(failure) {
    // Everything here is best-effort. A Linear/Telegram outage must not throw
    // into the run loop — the healthcheck already recorded the failure in status.
    try {
        const key = await resolveLinearApiKey();
        if (await openSelfHealTicketExists({ key, dep: failure.dep })) {
            console.log(`[healthcheck] ${failure.dep} down but an open [SelfHeal] ticket already exists — dedup, no new ticket/alert`);
            return;
        }
        try {
            await (0, notify_1.sendTelegram)(`⚠️ self-heal: dependency ${failure.dep} DOWN — ${failure.detail}. Filing repair ticket.`);
        }
        catch (e) {
            console.warn("[healthcheck] Telegram send failed (ignored):", e);
        }
        const id = await fileSelfHealTicket({ key, dep: failure.dep, detail: failure.detail });
        console.log(`[healthcheck] Filed self-heal ticket for ${failure.dep}: ${id ?? "(no identifier)"}`);
    }
    catch (err) {
        console.error(`[healthcheck] Failed to file self-heal ticket for ${failure.dep}:`, err instanceof Error ? err.message : err);
    }
}
// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------
async function runHealthcheck() {
    // Probes run sequentially — no shared state, and it keeps peak resource use
    // (spawned MCP children, gcloud subprocesses) to one at a time.
    const results = [];
    for (const p of PROBES) {
        results.push(await runProbe(p));
    }
    const healthy = results.filter((r) => r.healthy).length;
    const snapshot = {
        at: new Date().toISOString(),
        results,
        healthy,
        total: results.length,
    };
    lastHealthcheck = snapshot;
    const failures = results.filter((r) => !r.healthy);
    console.log(`[healthcheck] ${healthy}/${results.length} healthy` +
        (failures.length > 0 ? ` — DOWN: ${failures.map((f) => f.dep).join(", ")}` : ""));
    for (const failure of failures) {
        await handleFailure(failure);
    }
    return snapshot;
}
function startHealthcheckCron() {
    // Every 6 hours: 00/06/12/18 UTC — same cadence as handy-daemon.
    cron.schedule("0 */6 * * *", () => {
        console.log("[healthcheck] Running scheduled dependency healthcheck");
        runHealthcheck().catch((err) => console.error("[healthcheck] scheduled run error:", err));
    });
    console.log("[healthcheck] Scheduled every 6 hours (00/06/12/18 UTC)");
}
//# sourceMappingURL=healthcheck.js.map