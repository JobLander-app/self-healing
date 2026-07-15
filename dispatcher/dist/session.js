"use strict";
/**
 * The dispatch session — mirrors handy-daemon's executeTask/query() loop.
 *
 * A single run spawns ONE Claude Agent SDK session whose system prompt is the
 * local CLAUDE.md constitution. The agent does the whole loop autonomously:
 * pick one Linear ticket → claim it (In Progress) → investigate → reach a
 * terminal outcome (fix+merge, prove-it's-noise, or — only for genuine
 * dead-ends — return to Backlog). There is exactly one in-flight session at a
 * time, guarded by the module-level `busy` lock.
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
exports.isBusy = isBusy;
exports.getCurrentTurnId = getCurrentTurnId;
exports.runDispatchSession = runDispatchSession;
const claude_agent_sdk_1 = require("@anthropic-ai/claude-agent-sdk");
const config_1 = require("./config");
const trace_1 = require("./trace");
const pause_1 = require("./pause");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let busy = false;
let currentTurnId = null;
function isBusy() {
    return busy;
}
function getCurrentTurnId() {
    return currentTurnId;
}
function loadSystemPrompt() {
    const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
        return fs.readFileSync(claudeMdPath, "utf-8");
    }
    // Fail loud rather than run an unconstrained autonomous merger.
    throw new Error(`CLAUDE.md (dispatcher constitution) not found at ${claudeMdPath}. Refusing to run.`);
}
const RUN_INSTRUCTION = `Это автономный poll-tick claude-code-vm-job-dispatcher.

Выполни ровно ОДИН цикл по своей конституции (CLAUDE.md):
1. Выбери ОДИН тикет ТОЛЬКО с label "monitor" (To Do, затем Backlog; сортировка Urgent→High→Medium→Low, затем старейший createdAt; пропусти уже In Progress и назначенные на человека). ТИКЕТЫ БЕЗ label "monitor" (фичи/improvement/эпики) — НЕ ТВОИ, не трогай их вообще: авто-merge санкционирован только для monitor-origin.
2. Заклейми его: переведи в In Progress и назначь на себя ДО любой работы. Если заклеймить нельзя — выйди.
3. FRESHNESS GATE (Step 3.5 в конституции): тикет — это ГИПОТЕЗА о баге на момент создания, а не факт на момент починки. ПЕРЕД тем как чинить — заново подтверди, что баг ещё живой В ТЕКУЩЕМ коде (воспроизведи сигнатуру в свежем окне; проверь не пофикшено ли уже поздним деплоем/коммитом). Не воспроизводится → "stale". Уже решено другим коммитом/деплоем → "fixed-elsewhere". Не чини то, что не смог воспроизвести.
4. Иначе доведи тикет до терминального состояния СВОИМ решением (исправить+смержить, доказать что это не баг, или — только для реального тупика — вернуть в Backlog с детальным комментарием).
5. Один тикет за запуск. Заверши чисто.

В САМОМ КОНЦЕ выведи ровно одну строку машиночитаемого маркера итога:
[DISPATCH_RESULT] {"outcome":"fixed|not-a-bug|stale|fixed-elsewhere|backlogged|no-work","issue":"JOB-XXX или null","repo":"<repo или null>","pr":"<PR url или null>","note":"краткое описание (1 предложение)"}

outcome:
- "fixed" — реальный баг исправлен, PR смержен, Linear → Done
- "not-a-bug" — доказано что это шум/transient/client-side, Linear → Done или Canceled
- "stale" — баг больше не воспроизводится в свежем окне (перестал происходить), Linear → Canceled с доказательством "не наблюдается с <ts>"
- "fixed-elsewhere" — баг был реальным, но уже устранён поздним коммитом/деплоем, Linear → Done со ссылкой на коммит/ревизию
- "backlogged" — честный тупик, вернул в Backlog с деталями (единственный не-терминальный выход)
- "no-work" — нечего брать в этот тик`;
/**
 * Extract the [DISPATCH_RESULT] marker the agent is instructed to print.
 * Falls back to "unknown" if absent/unparseable so a malformed run never
 * masquerades as a clean outcome.
 */
function parseDispatchResult(output) {
    const markerIdx = output.lastIndexOf("[DISPATCH_RESULT]");
    if (markerIdx === -1)
        return { outcome: "unknown" };
    const after = output.slice(markerIdx + "[DISPATCH_RESULT]".length);
    const braceStart = after.indexOf("{");
    if (braceStart === -1)
        return { outcome: "unknown" };
    // Walk to the matching closing brace (handles trailing prose after JSON).
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < after.length; i++) {
        if (after[i] === "{")
            depth++;
        else if (after[i] === "}") {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end === -1)
        return { outcome: "unknown" };
    try {
        const raw = JSON.parse(after.slice(braceStart, end + 1));
        const outcome = String(raw.outcome ?? "unknown");
        const valid = ["fixed", "not-a-bug", "stale", "fixed-elsewhere", "backlogged", "no-work"];
        return {
            outcome: valid.includes(outcome) ? outcome : "unknown",
            issue: raw.issue && raw.issue !== "null" ? String(raw.issue) : undefined,
            repo: raw.repo && raw.repo !== "null" ? String(raw.repo) : undefined,
            pr: raw.pr && raw.pr !== "null" ? String(raw.pr) : undefined,
            note: raw.note ? String(raw.note) : undefined,
        };
    }
    catch {
        return { outcome: "unknown" };
    }
}
function newTurnId() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    return `dispatch-${stamp}-${rand}`;
}
/**
 * Run a single dispatch session. Returns the run summary. Never throws —
 * any failure is captured as an "error" outcome so the cron loop keeps
 * ticking.
 */
async function runDispatchSession(reason) {
    if (busy) {
        throw new Error("runDispatchSession called while busy");
    }
    busy = true;
    const turnId = newTurnId();
    currentTurnId = turnId;
    const startedAt = new Date();
    console.log(`[session] Dispatch run ${turnId} starting (reason: ${reason})`);
    (0, trace_1.traceEvent)(turnId, "run_started", { reason, model: config_1.config.claudeModel, dryRun: config_1.config.dryRun });
    let systemPrompt;
    try {
        systemPrompt = loadSystemPrompt();
    }
    catch (err) {
        busy = false;
        currentTurnId = null;
        const msg = err instanceof Error ? err.message : String(err);
        const summary = {
            turnId,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationSec: 0,
            outcome: "error",
            costUsd: 0,
            numTurns: 0,
            dryRun: config_1.config.dryRun,
            summary: `Startup error: ${msg}`,
        };
        (0, trace_1.recordRun)(summary);
        return summary;
    }
    const dryRunBanner = config_1.config.dryRun
        ? "\n\n## DRY_RUN ACTIVE (строго read-only, первый прогон)\nDRY_RUN=true. Это первый безопасный прогон — НИКАКИХ записей наружу. ЗАПРЕЩЕНО: `git push`, `gh pr create`, `gh pr merge`, любые Linear-мутации (update_issue/create_comment — в т.ч. claim в In Progress: НЕ клейми, просто укажи какой тикет ВЗЯЛ БЫ), любые правки known-errors.json. РАЗРЕШЕНО и ТРЕБУЕТСЯ: полностью расследовать (читать Linear, gcloud-логи `--project=meet-assistant-6d8ad`, код обеих сторон, при нужде воспроизвести локально), и если фикс нужен — написать его в локальном scratch-чекауте и показать `git diff`, но НЕ публиковать. В конце выведи подробно: выбранный тикет, вердикт (баг/не-баг + доказательство), какой фикс/PR ты СОЗДАЛ БЫ (с diff) либо почему это не баг. Итоговый [DISPATCH_RESULT] маркер обязателен.\n"
        : "";
    // Freshness policy — concrete numbers from config so they stay tunable via
    // env without editing the constitution. The PROCEDURE lives in CLAUDE.md
    // ("Step 3.5 FRESHNESS GATE"); these are the current thresholds.
    const freshnessPolicy = `\n\n## FRESHNESS THRESHOLDS (current values for Step 3.5)\n` +
        `- staleAgeHrs = ${config_1.config.staleAgeHrs}h — if the ticket is OLDER than this (now − createdAt), the FULL freshness gate is MANDATORY; when you cannot reproduce it live, default to "stale".\n` +
        `- freshnessWindowHrs = ${config_1.config.freshnessWindowHrs}h — re-confirm the signature still occurs within this recent window (e.g. \`gcloud logging read ... --freshness=${config_1.config.freshnessWindowHrs}h\`). Zero hits / metric back within threshold ⇒ "stale".\n`;
    const prompt = `${systemPrompt}${freshnessPolicy}${dryRunBanner}\n\n---\n\n${RUN_INSTRUCTION}`;
    let output = "";
    let costUsd = 0;
    let numTurns = 0;
    let sessionError = null;
    // Watchdog. config.claudeMaxTurns bounds the turn COUNT but not wall-clock
    // time. A single hung turn would block the `for await` forever and leave
    // `busy` stuck true — wedging the whole self-poll loop (it happened: a run
    // hung ~5 days and the dispatcher picked up zero tickets). The abortController
    // ends the session after MAX_RUN_MS; the `finally` guarantees `busy` is always
    // released so the next tick can proceed no matter how the run ends.
    const abortController = new AbortController();
    let timedOut = false;
    const watchdog = setTimeout(() => {
        timedOut = true;
        abortController.abort();
    }, config_1.config.maxRunMs);
    try {
        for await (const msg of (0, claude_agent_sdk_1.query)({
            prompt,
            options: {
                model: config_1.config.claudeModel,
                maxTurns: config_1.config.claudeMaxTurns,
                allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent"],
                permissionMode: "bypassPermissions",
                abortController,
            },
        })) {
            const m = msg;
            if (m.type === "result") {
                output = m.result || "";
                costUsd = m.total_cost_usd || 0;
                numTurns = m.num_turns || 0;
            }
            if (m.type === "tool_use") {
                (0, trace_1.traceEvent)(turnId, "tool_use", { tool: m.name });
            }
        }
    }
    catch (err) {
        sessionError = timedOut
            ? `watchdog: dispatch exceeded MAX_RUN_MS (${Math.round(config_1.config.maxRunMs / 60000)}m) — aborted to release the busy lock and unwedge the poll loop`
            : err instanceof Error
                ? err.message
                : String(err);
        (0, trace_1.traceEvent)(turnId, "session_error", { error: sessionError, timedOut });
    }
    finally {
        clearTimeout(watchdog);
        busy = false;
        currentTurnId = null;
    }
    const finishedAt = new Date();
    const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    // Determine outcome. Prefer the agent's explicit marker; fall back to
    // PR-URL heuristics and the session-error state.
    const parsed = parseDispatchResult(output);
    let outcome = sessionError ? "error" : parsed.outcome;
    // Subscription rate-limit: don't burn ticks against a wall. Record the
    // work-in-progress and pause until the reset time the error gives us; the
    // index.ts watcher resumes automatically right after the window clears.
    if (sessionError && (0, pause_1.isLimitError)(sessionError)) {
        const p = (0, pause_1.pauseFromLimitError)(sessionError, parsed.issue ?? null);
        (0, trace_1.traceEvent)(turnId, "rate_limited", { until: p.until, inProgressIssue: p.inProgressIssue });
    }
    const prMatch = output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    const prUrl = parsed.pr || prMatch?.[0];
    const note = parsed.note ||
        (sessionError ? `session error: ${sessionError}` : output.slice(0, 280).replace(/\s+/g, " ").trim());
    const summary = {
        turnId,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationSec,
        outcome,
        issueId: parsed.issue,
        repo: parsed.repo,
        prUrl,
        costUsd,
        numTurns,
        dryRun: config_1.config.dryRun,
        summary: note,
    };
    (0, trace_1.traceEvent)(turnId, "run_finished", { ...summary });
    (0, trace_1.recordRun)(summary);
    // NO Telegram. The "Joblander Alerts" channel is reserved for P0 "on fire"
    // emergencies only — not per-run dispatcher logs. Dispatcher activity lives
    // in the JSONL traces and is surfaced on demand via /self-healing-report.
    // (Owner directive 2026-06-08: stop logging to the alerts channel.)
    console.log(`[session] Dispatch run ${turnId} done: ${outcome} (${durationSec}s, $${costUsd.toFixed(2)})`);
    return summary;
}
//# sourceMappingURL=session.js.map