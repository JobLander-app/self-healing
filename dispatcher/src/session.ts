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

import { closeFalsePositive } from "./falsePositives";
import { accountingStatus } from "./accountingState";
import { alertAccounting, alertProviderReadiness } from "./healthAlerts";
import { executeClaude } from "./claude";
import { executeOpenCode } from "./opencode";
import { executeCodex } from "./codex";
import { executeWithFallback } from "./fallback";
import { availableToAttempt, providerOrder, updateProvider } from "./providerState";
import type { ProviderAttempt } from "./providerTypes";
import { config, providerModel } from "./config";
import { assertSelectedCandidate, CandidateEligibilityError, candidateInstruction, queuePolicy, type SelectedCandidate } from "./queue";
import {
  traceEvent,
  recordRun,
  recordAttempt,
  recordAttemptStarted,
  type RunOutcome,
  type RunSummary,
} from "./trace";

import { sendTelegram } from "./notify";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FIREBASE_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "firebase", "index.js");
const SENTRY_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "sentry", "index.js");
const LINEAR_MCP_ENTRY = path.join(REPO_ROOT, "mcp", "linear", "index.js");

let busy = false;
let currentTurnId: string | null = null;

function pickEnv(keys: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string") env[k] = v;
  }
  return env;
}


function baseMcpEnv(): Record<string, string> {
  const env = pickEnv([
    "PATH",
    "HOME",
    "LANG",
    "LOGNAME",
    "USER",
    "SHELL",
    "NODE_ENV",
    "GCP_PROJECT_ID",
    "LINEAR_API_KEY_SECRET",
    "SENTRY_ORG",
    "SENTRY_PROJECT_ID",
    "SENTRY_TOKEN_SECRET",
  ]);
  // Always ensure GCP_PROJECT_ID is set (ADC project override).
  env.GCP_PROJECT_ID = env.GCP_PROJECT_ID || config.gcpProject;
  // Forward any GOOGLE_* vars present (e.g. GOOGLE_APPLICATION_CREDENTIALS).
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GOOGLE_") && typeof v === "string") env[k] = v;
  }
  return env;
}


export function buildFirebaseMcpEnv(): Record<string, string> {
  return baseMcpEnv();
}

export function buildSentryMcpEnv(): Record<string, string> {
  return baseMcpEnv();
}

export function buildLinearMcpEnv(): Record<string, string> {
  return baseMcpEnv();
}

export function mcpEntries(): Record<string, string> {
  return { linear: LINEAR_MCP_ENTRY,
    ...(config.firebaseEnabled ? { firebase: FIREBASE_MCP_ENTRY } : {}),
    ...(config.sentryEnabled ? { sentry: SENTRY_MCP_ENTRY } : {}) };
}
export function mcpServers(): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  return Object.fromEntries(Object.entries(mcpEntries()).map(([name, entry]) =>
    [name, { command: "node", args: [entry], env: baseMcpEnv() }]));
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
    const policy = config.consumerPolicyFile ? fs.readFileSync(config.consumerPolicyFile, "utf-8") : "No consumer policy supplied.";
    return fs.readFileSync(claudeMdPath, "utf-8") + `

## Consumer policy
${policy}

Approved repositories: ${config.trackedRepos.join(", ")}
AUTO_MERGE=${config.autoMerge}. When false, leave the PR for human review and report backlogged; never merge or deploy.
`;
  }
  // Fail loud rather than run an unconstrained autonomous merger.
  throw new Error(
    `CLAUDE.md (dispatcher constitution) not found at ${claudeMdPath}. Refusing to run.`,
  );
}

function runInstruction(dryRun: boolean): string {
  return `Run exactly one investigation according to the constitution and selected candidate.
${dryRun ? "DRY_RUN: investigate read-only; do not claim or write externally." : "Re-read and claim the selected ticket once, preserving labels."}
Confirm freshness and intent before changing code. Obey AUTO_MERGE and the consumer policy.
For proven false positives, return not-a-bug with concrete note and nonempty evidence; the host owns labeling and closure.
Finish with [DISPATCH_RESULT] and valid JSON containing outcome, issue, repo, pr, note and evidence.
Outcomes: fixed (merged), not-a-bug (proven noise), stale (no longer observed), fixed-elsewhere,
intentional (explained change), backlogged (blocked or PR awaiting approval), no-work (candidate no longer eligible).`;
}

export function buildDispatchPrompt(input: {
  systemPrompt: string; freshnessPolicy: string; changeFeedPolicy: string;
  dryRunBanner: string; staleClaimMinutes: number; dryRun: boolean; candidate?: SelectedCandidate;
}): string {
  const queueInstructions = `\n\n## MONITOR QUEUE CONTRACT\n${queuePolicy(input.staleClaimMinutes, input.dryRun)}\n\n## SELECTED CANDIDATE\n${candidateInstruction(input.candidate, input.dryRun)}`;
  const override = input.dryRun
    ? "\n\nFINAL DRY_RUN OVERRIDE: do not claim, assign, add labels, comment, push, merge, or write known-errors.json. Investigate locally and report what you WOULD do. This overrides every mutation instruction above."
    : "";
  return `${input.systemPrompt}${input.freshnessPolicy}${input.changeFeedPolicy}\n\n---\n\n${runInstruction(input.dryRun)}${queueInstructions}${input.dryRunBanner}${override}`;
}

interface DispatchResult {
  outcome: RunOutcome;
  issue?: string;
  repo?: string;
  pr?: string;
  note?: string;
  evidence?: string[];
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
    const valid: RunOutcome[] = ["fixed", "not-a-bug", "stale", "fixed-elsewhere", "intentional", "backlogged", "no-work"];
    return {
      outcome: valid.includes(outcome) ? outcome : "unknown",
      issue: raw.issue && raw.issue !== "null" ? String(raw.issue) : undefined,
      repo: raw.repo && raw.repo !== "null" ? String(raw.repo) : undefined,
      pr: raw.pr && raw.pr !== "null" ? String(raw.pr) : undefined,
      note: raw.note ? String(raw.note) : undefined,
      evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e): e is string => typeof e === "string") : undefined,
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


export function buildRunNotification(s: RunSummary): string | null {
  if (s.outcome === "no-work") return null;

  if (s.outcome !== "error" && !s.issueId) return null;
  if (s.outcome === "error") {
    const ticket = s.issueId ? `${s.issueId}: ` : "";
    const detail = s.summary.trim().replace(/\.+$/, "") || "no detail";
    const cost = s.costUsd === null ? ["cost unknown"] : s.costUsd > 0 ? [`$${s.costUsd.toFixed(2)}`] : [];
    const stats = [...cost, `${s.durationSec}s`, `${s.numTurns} turns`];
    return `${s.dryRun ? "[DRY_RUN] " : ""}⚠️ ${ticket}run FAILED — ${detail}. ${stats.join(", ")}`;
  }

  const ticket = s.issueId;
  const summary = s.summary.trim().length > 0 ? s.summary.trim() : "no summary";
  const cost = s.costUsd === null ? "cost estimate unavailable" : `estimated $${s.costUsd.toFixed(2)}`;

  let line: string;
  switch (s.outcome) {
    case "fixed": {
      const pr = s.prUrl ? `${s.prUrl} merged` : "merged";
      // The run ends at merge (CLAUDE.md Step 4a.11): the deploy has not been
      // confirmed, so never say "in prod". The monitor re-files on recurrence.
      line = `🚀 merged: ${ticket} FIXED — ${pr}, deploy pending. ${summary}. ${cost}, ${s.durationSec}s`;
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
    case "intentional":
      line = `✅ ${ticket}: investigated — explained by an intentional change, no fix needed. ${summary}. ${cost}`;
      break;
    default: // backlogged | error | unknown (watchdog timeout surfaces as "error")
      line = `⚠️ ${ticket}: ${s.outcome}. ${summary}`;
      break;
  }

  return s.dryRun ? `[DRY_RUN] ${line}` : line;
}

/**
 * Tool calls made in one SDK message, for the run trace.
 *
 * The SDK has NO top-level `tool_use` message — tool calls arrive as content
 * blocks inside `SDKAssistantMessage.message.content[]` (see
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts`: the union contains `assistant`,
 * `user`, `result`, `system`… and no `tool_use`). The daemon used to check
 * `msg.type === "tool_use"`, which can never be true: across 143 recorded runs,
 * ZERO trace events of that kind were ever written. Every trace held only
 * started/finished/outcome, so when a run burned $5.24 over 121 turns and
 * failed there was nothing to say what it had been doing.
 *
 * Only the tool NAME is recorded, plus — for Bash — the leading command word.
 * Arguments are deliberately excluded: a Bash line here can carry a token from
 * `gcloud secrets versions access`, and a run trace is not a place for
 * credentials. The command word alone still answers the diagnostic question
 * ("80 Bash(gcloud), 30 Read, 6 mcp__linear__update_issue") without carrying
 * anything sensitive.
 */
export function toolUsesFrom(msg: unknown): Array<{ tool: string; cmd?: string }> {
  const m = msg as { type?: string; message?: { content?: unknown } };
  if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) return [];
  const out: Array<{ tool: string; cmd?: string }> = [];
  for (const raw of m.message.content as unknown[]) {
    const block = raw as { type?: string; name?: string; input?: Record<string, unknown> };
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
    const entry: { tool: string; cmd?: string } = { tool: block.name };
    const command = block.input?.command;
    if (block.name === "Bash" && typeof command === "string") {
      const word = command.trim().split(/\s+/)[0];
      // A leading `NAME=value` is a shell assignment, not a binary — and the
      // value is routinely a credential (`LINEAR_API_KEY=... gcloud ...`).
      // Truncating to 40 chars does NOT make that safe, it just ships a shorter
      // secret. When the command starts with an assignment we record no `cmd`
      // at all: the tool name still shows the run used Bash, and no run is
      // worth leaking a token to diagnose.
      if (word && !word.includes("=")) entry.cmd = word.slice(0, 40);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Run one selected recent ticket. Eligibility failures throw so durable
 * triggers remain pending; provider failures are recorded in the run summary.
 */
export async function runDispatchSession(reason: string, candidate?: SelectedCandidate): Promise<RunSummary> {
  if (busy) {
    throw new Error("runDispatchSession called while busy");
  }

  assertSelectedCandidate(candidate);
  if (!accountingStatus().healthy) throw new Error("Accounting unavailable; no provider attempt started");
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
    ? "\n\n## DRY_RUN ACTIVE\nRead-only external access. Do not claim, assign, label, comment, push, create PRs, merge or write suppressions. Investigate the selected issue using the configured project and approved repositories. Local scratch changes/tests are allowed; report the proposed diff and evidence without publishing. Emit DISPATCH_RESULT.\n"
    : "";

  // Freshness policy — concrete numbers from config so they stay tunable via
  // env without editing the constitution. The PROCEDURE lives in CLAUDE.md
  // ("Step 3.5 FRESHNESS GATE"); these are the current thresholds.
  const freshnessPolicy =
    `\n\n## FRESHNESS THRESHOLDS (current values for Step 3.5)\n` +
    `- staleAgeHrs = ${config.staleAgeHrs}h — if the ticket is OLDER than this (now − createdAt), the FULL freshness gate is MANDATORY; when you cannot reproduce it live, default to "stale".\n` +
    `- freshnessWindowHrs = ${config.freshnessWindowHrs}h — re-confirm the signature still occurs within this recent window (e.g. \`gcloud logging read ... --freshness=${config.freshnessWindowHrs}h\`). Zero hits / metric back within threshold ⇒ "stale".\n`;

  // CHANGE FEED — the change-ingest base URL + lookback for the Step 3.6 INTENT
  // GATE, injected so the port/lookback stay tunable via env without editing the
  // constitution. The PROCEDURE (name entities → query → judge → fail closed on
  // intent, open on availability) lives in CLAUDE.md Step 3.6.
  const changeFeedPolicy =
    `\n\n## CHANGE FEED (base URL + lookback for Step 3.6 INTENT GATE)\n` +
    `- CHANGE_FEED_URL = ${config.changeFeedUrl} — localhost-only change-ingest service. Query recent prod changes (merged PRs, cloud audit events incl. instance deletes & deploys, closed/updated Linear tickets) touching the anomaly's entities:\n` +
    `  \`curl -s "${config.changeFeedUrl}/changes?entity=<type>:<id>&entity=<type>:<id>&since=<epoch_ms>&until=<epoch_ms>"\`\n` +
    `  entity types: gcp_instance | region | service | repo (repeat entity= per scope, OR-matched). Each row has an intent_text you judge over.\n` +
    `- intentLookbackHrs = ${config.intentLookbackHrs}h — set since = now − ${config.intentLookbackHrs}h (epoch ms), until = now (epoch ms).\n` +
    `- If the feed returns HTTP 503, missing/stale source coverage, or cannot be reached, continue read-only investigation and repair feed/credential reachability itself. Do not create/delete/restore resources, roll infrastructure back, or reverse potential intentional changes without fresh corroborating intent evidence. Fresh authoritative GitHub, GCP audit and Linear evidence may substitute for the unavailable feed; otherwise backlogged with the explicit coverage failure. If a returned change explains the anomaly, do NOT fix (outcome "intentional").\n`;

  const prompt = buildDispatchPrompt({ systemPrompt, freshnessPolicy, changeFeedPolicy, dryRunBanner,
    staleClaimMinutes: config.staleClaimMinutes, dryRun: config.dryRun, candidate });

  let output = "";
  let costUsd: number | null = null;
  let attempts: ProviderAttempt[] = [];
  let numTurns = 0;
  let sessionError: string | null = null;
  let eligibilityError: CandidateEligibilityError | null = null;
  let claimedOutsideCandidate: string[] = [];

  // Watchdog. config.claudeMaxTurns bounds the turn COUNT but not wall-clock
  // time. A single hung turn would block the `for await` forever and leave
  // `busy` stuck true — wedging the whole self-poll loop (it happened: a run
  // hung ~5 days and the dispatcher picked up zero tickets). The abortController
  // ends the session after MAX_RUN_MS; the `finally` guarantees `busy` is always
  // released so the next tick can proceed no matter how the run ends.
  const abortController = new AbortController();
  let timedOut = false;
  // The abort surfaces from executeWithFallback as a generic "run aborted"
  // error; name the limit that fired so the alert says why.
  const watchdogError = `watchdog: run exceeded MAX_RUN_MS (${Math.round(config.maxRunMs / 60000)}m) and was aborted`;
  const watchdog = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, config.maxRunMs);

  try {
    const result = await executeWithFallback({
      providers: providerOrder(), allowedIssueIds: [candidate.id, candidate.identifier], prompt, signal: abortController.signal,
      canAttempt: availableToAttempt,
      execute: (provider, attemptPrompt) => {
        const id = `${turnId}-${provider}`;
        assertSelectedCandidate(candidate);
        const beforeStart = () => {
          assertSelectedCandidate(candidate);
          recordAttemptStarted(turnId, provider, providerModel(provider));
          traceEvent(turnId, "attempt_started", { id, provider, model: providerModel(provider) });
        };
        if (provider === "opencode") return executeOpenCode({ id, beforeStart, prompt: attemptPrompt, model: config.openCodeModel,
          entries: mcpEntries(), signal: abortController.signal, onTool: use => traceEvent(turnId, "tool_use", { provider, ...use }) });
        return provider === "codex"
          ? executeCodex({ id, beforeStart, prompt: attemptPrompt, model: config.codexModel,
              signal: abortController.signal,
              entries: mcpEntries(),
              onTool: use => traceEvent(turnId, "tool_use", { provider, ...use }) })
          : executeClaude({ id, beforeStart, prompt: attemptPrompt, abortController,
              mcpServers: mcpServers(),
              onMessage: msg => { for (const use of toolUsesFrom(msg)) traceEvent(turnId, "tool_use", { provider, ...use }); } });
      },
      record: attempt => {
        attempts.push(attempt);
        recordAttempt(turnId, attempt);
        updateProvider(attempt);
      },
    });
    output = result.output;
    sessionError = timedOut && result.error?.startsWith("watchdog:") ? watchdogError : result.error;
    const allowed: readonly string[] = [candidate.id, candidate.identifier];
    claimedOutsideCandidate = [...new Set(result.results.flatMap(r => r.issueIds).filter(id => !allowed.includes(id)))];
  } catch (err) {
    if (err instanceof CandidateEligibilityError) eligibilityError = err;
    sessionError = timedOut
      ? watchdogError
      : err instanceof Error
        ? err.message
        : String(err);
    traceEvent(turnId, "session_error", { error: sessionError, timedOut });
  } finally {
    clearTimeout(watchdog);
    busy = false;
    currentTurnId = null;
  }

  numTurns = attempts.reduce((sum, a) => sum + a.turns, 0);
  costUsd = attempts.length && attempts.every(a => a.estimatedCostUsd !== null)
    ? attempts.reduce((sum, a) => sum + a.estimatedCostUsd!, 0) : eligibilityError && !attempts.length ? 0 : null;
  const finishedAt = new Date();
  const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);

  // Determine outcome. Prefer the agent's explicit marker; fall back to
  // PR-URL heuristics and the session-error state.
  const parsed = parseDispatchResult(output);
  let outcome: RunOutcome = sessionError ? "error" : parsed.outcome;

  const prMatch = output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
  const prUrl = parsed.pr || prMatch?.[0];

  let note = sessionError ? `session error: ${sessionError}` : parsed.note || output.slice(0, 280).replace(/\s+/g, " ").trim();

  if (outcome === "not-a-bug" && !config.dryRun) {
    busy = true; currentTurnId = turnId;
    try {
      if (parsed.issue !== candidate.identifier && parsed.issue !== candidate.id) throw new Error("Verdict does not name the selected ticket");
      await closeFalsePositive(candidate, parsed.note || "", parsed.evidence || []);
    }
    catch (error) {
      outcome = "backlogged";
      note = `False positive not fully recorded: ${error instanceof Error ? error.message : "unknown failure"}. Decision reconciliation will retry.`;
    } finally { busy = false; currentTurnId = null; }
  }

  const summary: RunSummary = {
    turnId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSec,
    outcome,
    // The daemon pins every run to one selected candidate, so a run that
    // started a provider attempt is about that ticket even when the agent
    // never printed [DISPATCH_RESULT] (watchdog abort, crash). Without this
    // the failure alert named no ticket. issueId is display-only (feed and
    // Telegram); it is never read back as a claim. "no-work" means the agent
    // declined the ticket, so it stays unattributed. A provider that claimed a
    // DIFFERENT ticket is named by what it actually mutated, ahead of even its
    // own [DISPATCH_RESULT]: an observed mutation outranks a provider-authored
    // marker, and naming the selected ticket would hide the one that may have
    // been changed.
    issueId: claimedOutsideCandidate.length ? claimedOutsideCandidate.join(", ")
      : parsed.issue ?? (attempts.length && outcome !== "no-work" ? candidate.identifier : undefined),
    repo: parsed.repo,
    prUrl,
    costUsd,
    attempts,
    costIsEstimate: true,
    numTurns,
    dryRun: config.dryRun,
    summary: note,
  };

  traceEvent(turnId, "run_finished", { ...summary });
  recordRun(summary);
  // A rejected start with no inference stays silent; an earlier real attempt
  // must notify before the retryable eligibility error is propagated.
  if (eligibilityError && !attempts.length) throw eligibilityError;

  await alertAccounting().catch(err => console.error("[session] accounting alert failed:", err));
  await alertProviderReadiness().catch(err => console.error("[session] readiness alert failed:", err));
  const notification = buildRunNotification(summary);
  if (notification !== null) {
    try {
      await sendTelegram(notification);
    } catch (err) {
      console.warn("[session] lifecycle Telegram send failed (ignored):", err);
    }
  }

  console.log(`[session] Dispatch run ${turnId} done: ${outcome} (${durationSec}s, estimated $${costUsd?.toFixed(2) ?? "unknown"})`);

  if (eligibilityError) throw eligibilityError;
  return summary;
}
