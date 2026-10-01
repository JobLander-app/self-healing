// Accounting for runs that end without an SDK `result` (watchdog abort) or
// that continue past an intermediate one, plus the failure alert they send.
//
// Evidence (2026-10-01): 6 of 8 watchdog-aborted runs in a week were recorded
// costUsd null / numTurns 0 although each ran 40 minutes, and the alert read
// "[dispatcher] ⚠️ run FAILED — session error: watchdog: run aborted before
// provider completion. $2.83,2400s, 80 turns" with no ticket id.
import { strict as assert } from "node:assert";
import { test, afterEach, mock } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shl-aborted-"));
process.env.LOG_DIR = path.join(dir, "turns");
process.env.MAX_RUN_MS = "50";
process.env.DEPLOY_GUARD_FILE = path.join(dir, "no-deploy");
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

const pricing: typeof import("../src/pricing") = require("../src/pricing");
const claude: typeof import("../src/claude") = require("../src/claude");
const session: typeof import("../src/session") = require("../src/session");
const accounting: typeof import("../src/accountingState") = require("../src/accountingState");
const alerts: typeof import("../src/healthAlerts") = require("../src/healthAlerts");
const providers: typeof import("../src/providerState") = require("../src/providerState");
const trace: typeof import("../src/trace") = require("../src/trace");
const notify: typeof import("../src/notify") = require("../src/notify");
const realExecuteClaude = claude.executeClaude;

afterEach(() => { mock.restoreAll(); });

// Usage of run dispatch-2026-10-01T12-10-01-204Z-iessyc at its `result`, for
// which the SDK reported total_cost_usd 2.8344.
const SONNET = { input_tokens: 75, cache_creation_input_tokens: 116467, cache_read_input_tokens: 5835193, output_tokens: 42305 };
const HAIKU = { input_tokens: 12247, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 15 };

test("price table reproduces the SDK's own total_cost_usd for a real run", () => {
  const cost = pricing.modelsCostUsd([
    { model: "claude-sonnet-4-6", usage: claude.claudeUsage(SONNET) },
    { model: "claude-haiku-4-5-20251001", usage: claude.claudeUsage(HAIKU) },
  ]);
  assert.ok(cost !== null);
  assert.equal(cost.toFixed(4), "2.8344");
});

test("an unknown model or an unreported field prices to null, never a guess", () => {
  assert.equal(pricing.usageCostUsd("claude-opus-9", claude.claudeUsage(SONNET)), null);
  assert.equal(pricing.usageCostUsd("claude-sonnet-4-6", claude.claudeUsage({ input_tokens: 10, output_tokens: 1 })), null);
  assert.equal(pricing.modelsCostUsd([{ model: "claude-sonnet-4-6", usage: claude.claudeUsage(SONNET) }, { model: "mystery", usage: claude.claudeUsage(HAIKU) }]), null);
});

function assistant(id: string, usage: Record<string, number>, opts: { model?: string; parent?: string } = {}) {
  return { type: "assistant", session_id: "s1", parent_tool_use_id: opts.parent ?? null,
    message: { id, model: opts.model ?? "claude-sonnet-4-6", usage, content: [{ type: "text", text: "working" }] } };
}
const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0) =>
  ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });

/** A fake SDK stream: yields messages, then behaves like an aborted query. */
function abortingQuery(messages: unknown[], controller: AbortController) {
  return (async function* () {
    for (const m of messages) yield m;
    controller.abort();
    throw new Error("Claude Code process aborted by user");
  }) as any;
}
const run = (controller: AbortController, query: unknown) => realExecuteClaude({ id: "t", prompt: "p", abortController: controller,
  mcpServers: {}, onMessage: () => {} }, query as any);

test("an aborted run without a result keeps cost, tokens and turns from the streamed messages", async () => {
  const controller = new AbortController();
  const { attempt } = await run(controller, abortingQuery([
    assistant("msg_1", u(10, 5, 1000, 200)),
    assistant("msg_1", u(10, 50, 1000, 200)), // later chunk of the same response wins
    assistant("msg_2", u(5, 100, 2000, 0)),
    assistant("msg_sub", u(100, 10), { model: "claude-haiku-4-5-20251001", parent: "toolu_1" }),
  ], controller));
  assert.equal(attempt.status, "failed");
  assert.equal(attempt.failureKind, "timeout");
  assert.equal(attempt.costSource, "transcript-estimate");
  assert.equal(attempt.turns, 2, "main-thread responses only; subagent responses are not turns");
  assert.deepEqual(attempt.usage, { input: 3315, cachedInput: 3000, cacheWrite: 200, output: 160 });
  const sonnet = (15 * 3 + 200 * 3.75 + 3000 * 0.3 + 150 * 15) / 1e6;
  const haiku = (100 * 1 + 10 * 5) / 1e6;
  assert.ok(attempt.estimatedCostUsd !== null && Math.abs(attempt.estimatedCostUsd - (sonnet + haiku)) < 1e-12);
  assert.deepEqual(attempt.models?.map(r => r.model).sort(), ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]);
});

test("an aborted run on an unpriced model records tokens and turns but leaves cost unknown", async () => {
  const controller = new AbortController();
  const { attempt } = await run(controller, abortingQuery([assistant("m", u(1, 2), { model: "claude-future-1" })], controller));
  assert.equal(attempt.estimatedCostUsd, null);
  assert.equal(attempt.costSource, "unavailable");
  assert.equal(attempt.turns, 1);
  assert.equal(attempt.usage.output, 2);
});

const RESULT = { type: "result", subtype: "success", is_error: false, result: "waiting for the background task", num_turns: 80,
  total_cost_usd: 2.83, usage: SONNET, modelUsage: { "claude-sonnet-4-6": { inputTokens: 75, outputTokens: 42305, cacheReadInputTokens: 5835193, cacheCreationInputTokens: 116467 } } };

test("messages streamed after an intermediate result are added to the SDK figures", async () => {
  const controller = new AbortController();
  const { attempt } = await run(controller, abortingQuery([
    assistant("before", u(75, 42305, 5835193, 116467)),
    RESULT,
    assistant("after_1", u(10, 1000, 100000, 0)),
    assistant("after_2", u(10, 2000, 100000, 1000)),
  ], controller));
  const tail = (20 * 3 + 1000 * 3.75 + 200000 * 0.3 + 3000 * 15) / 1e6;
  assert.equal(attempt.costSource, "claude-sdk-plus-transcript-estimate");
  assert.ok(attempt.estimatedCostUsd !== null && Math.abs(attempt.estimatedCostUsd - (2.83 + tail)) < 1e-12);
  assert.equal(attempt.turns, 82);
  assert.equal(attempt.usage.output, 42305 + 3000);
  assert.equal(attempt.models?.length, 1);
  assert.equal(attempt.models?.[0].usage.cachedInput, 5835193 + 200000);
});

test("a completed run is still accounted from the SDK result alone", async () => {
  const query = (async function* () { yield assistant("before", u(75, 42305, 5835193, 116467)); yield RESULT; }) as any;
  const { attempt } = await run(new AbortController(), query);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.costSource, "claude-sdk-estimate");
  assert.equal(attempt.estimatedCostUsd, 2.83);
  assert.equal(attempt.turns, 80);
});

const base: import("../src/trace").RunSummary = { turnId: "t", startedAt: "2026-10-01T12:10:01Z", finishedAt: "2026-10-01T12:50:01Z",
  durationSec: 2400, outcome: "error", issueId: "JOB-1138", costUsd: 2.83, numTurns: 80, dryRun: false,
  summary: "session error: watchdog: run exceeded MAX_RUN_MS (40m) and was aborted" };

test("failure alert names the ticket and separates the stats", () => {
  assert.equal(session.buildRunNotification(base),
    "⚠️ JOB-1138: run FAILED — session error: watchdog: run exceeded MAX_RUN_MS (40m) and was aborted. $2.83, 2400s, 80 turns");
  assert.equal(session.buildRunNotification({ ...base, costUsd: null, summary: "boom." }), "⚠️ JOB-1138: run FAILED — boom. cost unknown, 2400s, 80 turns");
  assert.equal(session.buildRunNotification({ ...base, issueId: undefined, costUsd: 0, numTurns: 0, durationSec: 0, summary: "Startup error: x" }),
    "⚠️ run FAILED — Startup error: x. 0s, 0 turns");
});

test("a fixed run reports the merge, not a confirmed production deploy", () => {
  const line = session.buildRunNotification({ ...base, outcome: "fixed", prUrl: "https://github.com/JobLander-app/backend/pull/399", summary: "ok" });
  assert.equal(line, "🚀 merged: JOB-1138 FIXED — https://github.com/JobLander-app/backend/pull/399 merged, deploy pending. ok. estimated $2.83, 2400s");
  assert.doesNotMatch(line!, /in prod/);
});

test("a watchdog-aborted session is attributed to its selected ticket with streamed cost", async () => {
  const NOW = Date.now();
  const candidate = { id: "issue-1", identifier: "JOB-1138", createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), reclaim: false };
  const notifications: string[] = [];
  const summaries: import("../src/trace").RunSummary[] = [];
  mock.method(accounting, "accountingStatus", () => ({ healthy: true }));
  mock.method(alerts, "alertAccounting", async () => {});
  mock.method(alerts, "alertProviderReadiness", async () => {});
  mock.method(providers, "providerOrder", () => ["claude", "codex"]);
  mock.method(providers, "availableToAttempt", () => true);
  mock.method(providers, "updateProvider", () => {});
  mock.method(notify, "sendTelegram", async (message: string) => { notifications.push(message); });
  for (const name of ["traceEvent", "recordAttemptStarted", "recordAttempt"] as const) mock.method(trace, name, () => {});
  mock.method(trace, "recordRun", (s: import("../src/trace").RunSummary) => { summaries.push(s); });
  // The real adapter over a fake stream that only ends when the watchdog aborts.
  mock.method(claude, "executeClaude", (input: Parameters<typeof claude.executeClaude>[0]) => realExecuteClaude(input, (async function* () {
    yield assistant("msg_1", u(1000, 1000));
    await new Promise(resolve => input.abortController.signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("Claude Code process aborted by user");
  }) as any));

  const summary = await session.runDispatchSession("cron", candidate);
  assert.equal(summary.outcome, "error");
  assert.equal(summary.issueId, "JOB-1138");
  assert.equal(summary.attempts?.length, 1, "a timeout is not a provider failure, so no fallback");
  assert.equal(summary.numTurns, 1);
  assert.ok(summary.costUsd !== null && Math.abs(summary.costUsd - (1000 * 3 + 1000 * 15) / 1e6) < 1e-12);
  assert.match(summary.summary, /watchdog: run exceeded MAX_RUN_MS \(\d+m\) and was aborted/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /^⚠️ JOB-1138: run FAILED — session error: watchdog: run exceeded MAX_RUN_MS \(\d+m\) and was aborted\. \$0\.02, \d+s, 1 turns$/);
  assert.equal(summaries.length, 1);
});

test("a run that claimed a different ticket is attributed to that ticket, not the selected one", async () => {
  const { LINEAR_AGENT_CLAIMED_LABEL_ID } = require("../src/config") as typeof import("../src/config");
  const NOW = Date.now();
  const candidate = { id: "issue-1", identifier: "JOB-1138", createdAt: new Date(NOW - 3_600_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), reclaim: false };
  const notifications: string[] = [];
  mock.method(accounting, "accountingStatus", () => ({ healthy: true }));
  mock.method(alerts, "alertAccounting", async () => {});
  mock.method(alerts, "alertProviderReadiness", async () => {});
  mock.method(providers, "providerOrder", () => ["claude", "codex"]);
  mock.method(providers, "availableToAttempt", () => true);
  mock.method(providers, "updateProvider", () => {});
  mock.method(notify, "sendTelegram", async (message: string) => { notifications.push(message); });
  for (const name of ["traceEvent", "recordAttemptStarted", "recordAttempt", "recordRun"] as const) mock.method(trace, name, () => {});
  mock.method(claude, "executeClaude", (input: Parameters<typeof claude.executeClaude>[0]) => realExecuteClaude(input, (async function* () {
    yield { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { id: "m1", model: "claude-sonnet-4-6", usage: u(1, 1),
      content: [{ type: "tool_use", id: "toolu_1", name: "mcp__linear__update_issue", input: { id: "JOB-9999", labelIds: [LINEAR_AGENT_CLAIMED_LABEL_ID] } }] } };
    // The provider's own marker names the selected ticket; the observed claim must still win.
    yield { ...RESULT, result: '[DISPATCH_RESULT] {"outcome":"fixed","issue":"JOB-1138","repo":null,"pr":null,"note":"done"}' };
  }) as any));

  const summary = await session.runDispatchSession("cron", candidate);
  assert.equal(summary.outcome, "error");
  assert.match(summary.summary, /claimed outside the exact selected candidate/);
  assert.equal(summary.issueId, "JOB-9999");
  assert.match(notifications[0], /^⚠️ JOB-9999: run FAILED/);
});
