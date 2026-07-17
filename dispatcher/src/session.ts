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

import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config";
import {
  traceEvent,
  recordRun,
  type RunOutcome,
  type RunSummary,
} from "./trace";
import { isLimitError, pauseFromLimitError } from "./pause";
import { sendTelegram } from "./notify";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

let busy = false;
let currentTurnId: string | null = null;

// Vendored stdio MCP servers live at the repo root (self-healing/mcp/*), one
// level above the dispatcher package. __dirname at runtime is
// <repo>/dispatcher/dist, so ../.. resolves to the repo root regardless of the
// process CWD. These give the investigation session real Firestore reads
// (firebase MCP) and Sentry issue lookups (sentry MCP) instead of only Bash.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIREBASE_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "firebase", "index.js");
const SENTRY_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "sentry", "index.js");
// Vendored self-hosted Linear MCP (mcp/linear). Replaces claude.ai's managed
// Linear connector, whose OAuth login kept expiring — this reads a
// never-expiring Linear API key (Secret Manager `linear-api-key`, injected into
// the child env below). Gives the agent structured Linear access
// (list_issues/get_issue/update_issue/create_comment/…) instead of raw
// Bash+GraphQL.
const LINEAR_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "linear", "index.js");

// LINEAR_API_KEY for the vendored linear MCP child. The dispatcher process does
// NOT carry it in env (the poller resolves it from Secret Manager at runtime),
// so we resolve it ONCE here and cache it, then inject it into every MCP child's
// env via buildMcpEnv(). Mirrors poller.ts's resolveLinearApiKey (not exported
// there; importing it would create a session↔poller cycle). Injecting the key
// into the firebase/sentry children too is harmless — they ignore it.
let cachedLinearKey = "";
async function resolveLinearApiKey(): Promise<string> {
  if (cachedLinearKey) return cachedLinearKey;
  if (process.env.LINEAR_API_KEY) {
    cachedLinearKey = process.env.LINEAR_API_KEY;
    return cachedLinearKey;
  }
  const { stdout } = await execFileAsync(
    "gcloud",
    ["secrets", "versions", "access", "latest", "--secret=linear-api-key", `--project=${config.gcpProject}`],
    { timeout: 15_000 },
  );
  const key = stdout.trim();
  if (!key) throw new Error("linear-api-key resolved empty from Secret Manager");
  cachedLinearKey = key;
  return key;
}

/**
 * Env handed to the child MCP processes. Inherit the full parent env (PATH,
 * HOME, GOOGLE_* / gcloud config are all required for ADC + `gcloud secrets`),
 * then ensure GCP_PROJECT_ID is set for both servers. GCP_PRIVATE_KEY_BASE_64 /
 * GCP_CLIENT_EMAIL (firebase cert fallback) and SENTRY_TOKEN pass through
 * automatically when present in the dispatcher's own environment.
 */
function buildMcpEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.GCP_PROJECT_ID = env.GCP_PROJECT_ID || config.gcpProject;
  // Linear MCP child auth. Resolved once (resolveLinearApiKey, awaited before
  // the query() below) so cachedLinearKey is populated by the time this runs.
  // Harmless for the firebase/sentry children.
  if (cachedLinearKey) env.LINEAR_API_KEY = env.LINEAR_API_KEY || cachedLinearKey;
  return env;
}

export function isBusy(): boolean {
  return busy;
}

export function getCurrentTurnId(): string | null {
  return currentTurnId;
}

function loadSystemPrompt(): string {
  const claudeMdPath = path.join(process.cwd(), "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    return fs.readFileSync(claudeMdPath, "utf-8");
  }
  // Fail loud rather than run an unconstrained autonomous merger.
  throw new Error(
    `CLAUDE.md (dispatcher constitution) not found at ${claudeMdPath}. Refusing to run.`,
  );
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

interface DispatchResult {
  outcome: RunOutcome;
  issue?: string;
  repo?: string;
  pr?: string;
  note?: string;
}

/**
 * Extract the [DISPATCH_RESULT] marker the agent is instructed to print.
 * Falls back to "unknown" if absent/unparseable so a malformed run never
 * masquerades as a clean outcome.
 */
function parseDispatchResult(output: string): DispatchResult {
  const markerIdx = output.lastIndexOf("[DISPATCH_RESULT]");
  if (markerIdx === -1) return { outcome: "unknown" };

  const after = output.slice(markerIdx + "[DISPATCH_RESULT]".length);
  const braceStart = after.indexOf("{");
  if (braceStart === -1) return { outcome: "unknown" };

  // Walk to the matching closing brace (handles trailing prose after JSON).
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < after.length; i++) {
    if (after[i] === "{") depth++;
    else if (after[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { outcome: "unknown" };

  try {
    const raw = JSON.parse(after.slice(braceStart, end + 1)) as Record<string, unknown>;
    const outcome = String(raw.outcome ?? "unknown") as RunOutcome;
    const valid: RunOutcome[] = ["fixed", "not-a-bug", "stale", "fixed-elsewhere", "backlogged", "no-work"];
    return {
      outcome: valid.includes(outcome) ? outcome : "unknown",
      issue: raw.issue && raw.issue !== "null" ? String(raw.issue) : undefined,
      repo: raw.repo && raw.repo !== "null" ? String(raw.repo) : undefined,
      pr: raw.pr && raw.pr !== "null" ? String(raw.pr) : undefined,
      note: raw.note ? String(raw.note) : undefined,
    };
  } catch {
    return { outcome: "unknown" };
  }
}

function newTurnId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `dispatch-${stamp}-${rand}`;
}

/**
 * Build the lifecycle-observability Telegram for a completed run (JOB-731).
 * Returns null when the run should stay silent:
 *   - "no-work" ticks (a message every ~10 min would be spam; the poller
 *     pre-check already suppresses most of these before they even run), and
 *   - runs that never picked a ticket (no issueId) — e.g. a startup error —
 *     which would otherwise spam ⚠️ on every tick.
 *
 * Three visible outcomes, keyed off the structured RunSummary fields only
 * (no free-text parsing beyond what the run already structured):
 *   🚀 in prod   — fixed+merged (auto-merge → Cloud Build deploys main).
 *   ✅ investigated — closed without a prod code change (not-a-bug/stale/
 *                    fixed-elsewhere).
 *   ⚠️ needs eyes — dead-end (backlogged) / error / timeout / unknown.
 * DRY_RUN runs are prefixed with "[DRY_RUN] ".
 */
export function buildRunNotification(s: RunSummary): string | null {
  if (s.outcome === "no-work") return null;
  if (!s.issueId) return null; // no ticket picked → not a lifecycle event

  const ticket = s.issueId;
  const summary = s.summary.trim().length > 0 ? s.summary.trim() : "no summary";
  const cost = `$${s.costUsd.toFixed(2)}`;

  let line: string;
  switch (s.outcome) {
    case "fixed": {
      const pr = s.prUrl ? `${s.prUrl} merged` : "merged";
      line = `🚀 in prod: ${ticket} FIXED — ${pr}, deploy pipeline running. ${summary}. ${cost}, ${s.durationSec}s`;
      break;
    }
    case "not-a-bug":
      line = `✅ ${ticket}: investigated — not a bug. ${summary}. ${cost}`;
      break;
    case "stale":
      line = `✅ ${ticket}: investigated — stale, no longer reproduces. ${summary}. ${cost}`;
      break;
    case "fixed-elsewhere":
      line = `✅ ${ticket}: investigated — already fixed by a later change. ${summary}. ${cost}`;
      break;
    default: // backlogged | error | unknown (watchdog timeout surfaces as "error")
      line = `⚠️ ${ticket}: ${s.outcome}. ${summary}`;
      break;
  }

  return s.dryRun ? `[DRY_RUN] ${line}` : line;
}

/**
 * Run a single dispatch session. Returns the run summary. Never throws —
 * any failure is captured as an "error" outcome so the cron loop keeps
 * ticking.
 */
export async function runDispatchSession(reason: string): Promise<RunSummary> {
  if (busy) {
    throw new Error("runDispatchSession called while busy");
  }

  busy = true;
  const turnId = newTurnId();
  currentTurnId = turnId;
  const startedAt = new Date();

  console.log(`[session] Dispatch run ${turnId} starting (reason: ${reason})`);
  traceEvent(turnId, "run_started", { reason, model: config.claudeModel, dryRun: config.dryRun });

  let systemPrompt: string;
  try {
    systemPrompt = loadSystemPrompt();
  } catch (err) {
    busy = false;
    currentTurnId = null;
    const msg = err instanceof Error ? err.message : String(err);
    const summary: RunSummary = {
      turnId,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationSec: 0,
      outcome: "error",
      costUsd: 0,
      numTurns: 0,
      dryRun: config.dryRun,
      summary: `Startup error: ${msg}`,
    };
    recordRun(summary);
    return summary;
  }

  const dryRunBanner = config.dryRun
    ? "\n\n## DRY_RUN ACTIVE (строго read-only, первый прогон)\nDRY_RUN=true. Это первый безопасный прогон — НИКАКИХ записей наружу. ЗАПРЕЩЕНО: `git push`, `gh pr create`, `gh pr merge`, любые Linear-мутации (update_issue/create_comment — в т.ч. claim в In Progress: НЕ клейми, просто укажи какой тикет ВЗЯЛ БЫ), любые правки known-errors.json. РАЗРЕШЕНО и ТРЕБУЕТСЯ: полностью расследовать (читать Linear, gcloud-логи `--project=meet-assistant-6d8ad`, код обеих сторон, при нужде воспроизвести локально), и если фикс нужен — написать его в локальном scratch-чекауте и показать `git diff`, но НЕ публиковать. В конце выведи подробно: выбранный тикет, вердикт (баг/не-баг + доказательство), какой фикс/PR ты СОЗДАЛ БЫ (с diff) либо почему это не баг. Итоговый [DISPATCH_RESULT] маркер обязателен.\n"
    : "";

  // Freshness policy — concrete numbers from config so they stay tunable via
  // env without editing the constitution. The PROCEDURE lives in CLAUDE.md
  // ("Step 3.5 FRESHNESS GATE"); these are the current thresholds.
  const freshnessPolicy =
    `\n\n## FRESHNESS THRESHOLDS (current values for Step 3.5)\n` +
    `- staleAgeHrs = ${config.staleAgeHrs}h — if the ticket is OLDER than this (now − createdAt), the FULL freshness gate is MANDATORY; when you cannot reproduce it live, default to "stale".\n` +
    `- freshnessWindowHrs = ${config.freshnessWindowHrs}h — re-confirm the signature still occurs within this recent window (e.g. \`gcloud logging read ... --freshness=${config.freshnessWindowHrs}h\`). Zero hits / metric back within threshold ⇒ "stale".\n`;

  const prompt = `${systemPrompt}${freshnessPolicy}${dryRunBanner}\n\n---\n\n${RUN_INSTRUCTION}`;

  // Resolve LINEAR_API_KEY once before spawning the MCP children so
  // buildMcpEnv() can inject it into the linear MCP child. Fail-soft: if the key
  // can't be resolved, the linear MCP still starts but its tool calls fail —
  // the rest of the session (firebase/sentry/Bash) is unaffected.
  try {
    await resolveLinearApiKey();
  } catch (err) {
    console.warn(
      "[session] LINEAR_API_KEY resolve failed — linear MCP tools will be unavailable this run:",
      err instanceof Error ? err.message : err,
    );
  }

  let output = "";
  let costUsd = 0;
  let numTurns = 0;
  let sessionError: string | null = null;

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
  }, config.maxRunMs);

  try {
    for await (const msg of query({
      prompt,
      options: {
        model: config.claudeModel,
        maxTurns: config.claudeMaxTurns,
        allowedTools: [
          "Bash",
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          "Agent",
          // Vendored MCP servers (see mcpServers below). Wildcard grants every
          // tool the server exposes; the SDK validates `mcp__<server>__*`.
          "mcp__firebase__*",
          "mcp__sentry__*",
          "mcp__linear__*",
        ],
        mcpServers: {
          firebase: { command: "node", args: [FIREBASE_MCP_ENTRY], env: buildMcpEnv() },
          sentry: { command: "node", args: [SENTRY_MCP_ENTRY], env: buildMcpEnv() },
          linear: { command: "node", args: [LINEAR_MCP_ENTRY], env: buildMcpEnv() },
        },
        permissionMode: "bypassPermissions",
        abortController,
      },
    })) {
      const m = msg as Record<string, unknown>;

      if (m.type === "result") {
        output = (m.result as string) || "";
        costUsd = (m.total_cost_usd as number) || 0;
        numTurns = (m.num_turns as number) || 0;
      }

      if (m.type === "tool_use") {
        traceEvent(turnId, "tool_use", { tool: m.name });
      }
    }
  } catch (err) {
    sessionError = timedOut
      ? `watchdog: dispatch exceeded MAX_RUN_MS (${Math.round(config.maxRunMs / 60000)}m) — aborted to release the busy lock and unwedge the poll loop`
      : err instanceof Error
        ? err.message
        : String(err);
    traceEvent(turnId, "session_error", { error: sessionError, timedOut });
  } finally {
    clearTimeout(watchdog);
    busy = false;
    currentTurnId = null;
  }

  const finishedAt = new Date();
  const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);

  // Determine outcome. Prefer the agent's explicit marker; fall back to
  // PR-URL heuristics and the session-error state.
  const parsed = parseDispatchResult(output);
  let outcome: RunOutcome = sessionError ? "error" : parsed.outcome;

  // Subscription rate-limit: don't burn ticks against a wall. Record the
  // work-in-progress and pause until the reset time the error gives us; the
  // index.ts watcher resumes automatically right after the window clears.
  if (sessionError && isLimitError(sessionError)) {
    const p = pauseFromLimitError(sessionError, parsed.issue ?? null);
    traceEvent(turnId, "rate_limited", { until: p.until, inProgressIssue: p.inProgressIssue });
  }

  const prMatch = output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  const prUrl = parsed.pr || prMatch?.[0];

  const note =
    parsed.note ||
    (sessionError ? `session error: ${sessionError}` : output.slice(0, 280).replace(/\s+/g, " ").trim());

  const summary: RunSummary = {
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
    dryRun: config.dryRun,
    summary: note,
  };

  traceEvent(turnId, "run_finished", { ...summary });
  recordRun(summary);

  // Lifecycle observability (JOB-731, supersedes the 2026-06-08 "no Telegram"
  // policy): one Telegram per run that actually did work — "acted upon" /
  // "in prod". no-work / no-ticket runs stay silent (see buildRunNotification).
  // Fail-soft: sendTelegram already swallows its own errors, and we belt-and-
  // suspenders around it so a TG failure can NEVER throw into the poll loop.
  const notification = buildRunNotification(summary);
  if (notification !== null) {
    try {
      await sendTelegram(notification);
    } catch (err) {
      console.warn("[session] lifecycle Telegram send failed (ignored):", err);
    }
  }

  console.log(`[session] Dispatch run ${turnId} done: ${outcome} (${durationSec}s, $${costUsd.toFixed(2)})`);

  return summary;
}
