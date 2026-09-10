import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_ISSUE_AGE_MS, CandidateEligibilityError, type SelectedCandidate } from "../src/queue";
import { EMPTY_QUEUE_GRACE_MS, TriggerReceipts } from "../src/triggerReceipts";
import { unknownUsage, type AttemptResult } from "../src/providerTypes";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shl-recent-"));
process.env.LINEAR_API_KEY = "test-key";
process.env.LOG_DIR = path.join(dir, "turns");
process.env.TRIGGER_RECEIPTS_FILE = path.join(dir, "manual.json");
process.env.TRIGGER_TOKEN = "test-trigger-token";
process.env.DEPLOY_GUARD_FILE = path.join(dir, "no-deploy");
const session: typeof import("../src/session") = require("../src/session");
const poller: typeof import("../src/poller") = require("../src/poller");
const accounting: typeof import("../src/accountingState") = require("../src/accountingState");
const alerts: typeof import("../src/healthAlerts") = require("../src/healthAlerts");
const providers: typeof import("../src/providerState") = require("../src/providerState");
const claude: typeof import("../src/claude") = require("../src/claude");
const codex: typeof import("../src/codex") = require("../src/codex");
const realExecuteClaude = claude.executeClaude;
const realExecuteCodex = codex.executeCodex;
const trace: typeof import("../src/trace") = require("../src/trace");
const notify: typeof import("../src/notify") = require("../src/notify");
const NOW = Date.parse("2026-09-10T14:00:00Z");
const recent: SelectedCandidate = { id: "issue-1", identifier: "JOB-1", createdAt: "2026-09-09T10:00:00Z", updatedAt: "2026-09-10T10:00:00Z", reclaim: false };
const boundary = { ...recent, createdAt: new Date(NOW - MAX_ISSUE_AGE_MS).toISOString() };
let calls: string[];
let notifications: string[];
let alertCalls: string[];
let summaries: import("../src/trace").RunSummary[];

function result(provider: "claude" | "codex", failed = false): AttemptResult {
  return { attempt: { id: provider, provider, model: "test", startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString(),
    status: failed ? "failed" : "completed", ...(failed ? { failureKind: "quota" as const, error: "usage limit" } : {}),
    usage: unknownUsage(), estimatedCostUsd: 0.02, costSource: "claude-sdk-estimate", turns: 1 },
    output: '[DISPATCH_RESULT] {"outcome":"no-work","note":"test"}', issueIds: [recent.id], toolsUsed: true };
}
function queueResponse(createdAt = recent.createdAt): Response {
  return new Response(JSON.stringify({ data: { issues: { nodes: [{ ...recent, createdAt,
    title: "[Monitor] Current bug", description: "Signature", priority: 2,
    state: { name: "Backlog" }, labels: { nodes: [] }, children: { nodes: [] },
  }], pageInfo: { hasNextPage: false, endCursor: null } } } }));
}

beforeEach(() => {
  calls = []; summaries = []; notifications = []; alertCalls = [];
  mock.method(Date, "now", () => NOW);
  mock.method(accounting, "accountingStatus", () => ({ healthy: true }));
  mock.method(alerts, "alertAccounting", async () => { alertCalls.push("accounting"); });
  mock.method(alerts, "alertProviderReadiness", async () => { alertCalls.push("readiness"); });
  mock.method(providers, "providerOrder", () => ["claude", "codex"]);
  mock.method(providers, "availableToAttempt", () => true);
  mock.method(providers, "updateProvider", () => {});
  mock.method(notify, "sendTelegram", async (message: string) => { notifications.push(message); });
  for (const name of ["traceEvent", "recordAttemptStarted", "recordAttempt"] as const) mock.method(trace, name, () => {});
  mock.method(trace, "recordRun", (summary: import("../src/trace").RunSummary) => { summaries.push(summary); });
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => { input.beforeStart?.(); calls.push("claude"); return result("claude"); });
  mock.method(codex, "executeCodex", async (input: Parameters<typeof codex.executeCodex>[0]) => { input.beforeStart?.(); calls.push("codex"); return result("codex"); });
  // An accidental real queue call must fail this test rather than touch Linear.
  mock.method(globalThis, "fetch", async () => { throw new Error("test: unexpected fetch"); });
});
afterEach(() => { mock.restoreAll(); });
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

test("all poll reasons fail closed on a Linear API error without model attempts", async () => {
  mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  for (const reason of ["trigger", "cron", "startup", "provider-retry", "anything-else"]) {
    assert.deepEqual(await poller.pollOnce(reason), { ran: false, note: "precheck-error" });
    assert.equal(poller.getLastPrecheck()?.result, "error");
    assert.match(poller.getLastPrecheck()?.error ?? "", /HTTP 503/);
  }
  assert.deepEqual(calls, []);
});

test("manual trigger cannot infer on old/future/invalid API results even if server ignores its filter", async () => {
  for (const createdAt of ["2026-04-01T00:00:00Z", new Date(NOW - MAX_ISSUE_AGE_MS - 1).toISOString(), new Date(NOW + 1).toISOString(), "invalid"]) {
    mock.method(globalThis, "fetch", async () => queueResponse(createdAt));
    assert.deepEqual(await poller.pollOnce("trigger"), { ran: false, note: "precheck-skip" });
  }
  assert.deepEqual(calls, []);
});

test("valid recent manual wakeup passes its exact candidate into the session", async () => {
  mock.method(globalThis, "fetch", async () => queueResponse());
  let selected: SelectedCandidate | undefined;
  mock.method(session, "runDispatchSession", async (_reason: string, candidate?: SelectedCandidate) => { selected = candidate; return {} as any; });
  assert.deepEqual(await poller.pollOnce("trigger"), { ran: true, note: "completed" });
  assert.deepEqual(selected, recent);
});

test("session entry refuses missing/old/future/malformed candidate for any reason", async () => {
  for (const candidate of [undefined, { ...recent, createdAt: "2026-04-01T00:00:00Z" },
    { ...recent, createdAt: "invalid" }, { ...recent, createdAt: new Date(NOW + 1).toISOString() }]) {
    await assert.rejects(session.runDispatchSession("trigger", candidate), CandidateEligibilityError);
  }
  assert.deepEqual(calls, []);
  assert.equal(session.isBusy(), false);
});

test("candidate aging after session entry is refused at the actual provider start", async () => {
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => {
    mock.method(Date, "now", () => NOW + 1);
    input.beforeStart?.();
    calls.push("claude"); return result("claude");
  });
  await assert.rejects(session.runDispatchSession("cron", boundary), CandidateEligibilityError);
  assert.deepEqual(calls, []);
  assert.equal(summaries[0].costUsd, 0);
  assert.deepEqual(notifications, []);
  assert.deepEqual(alertCalls, []);
  assert.equal(session.isBusy(), false);
});

test("expired candidate never starts fallback and retains accounting for its earlier attempt", async () => {
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => {
    input.beforeStart?.(); calls.push("claude");
    mock.method(Date, "now", () => NOW + 1);
    return result("claude", true);
  });
  await assert.rejects(session.runDispatchSession("provider-retry", boundary), CandidateEligibilityError);
  assert.deepEqual(calls, ["claude"]);
  assert.equal(summaries[0].attempts?.length, 1);
  assert.equal(summaries[0].costUsd, 0.02);
  assert.deepEqual(alertCalls, ["accounting", "readiness"]);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /JOB-1: run FAILED/);
  assert.match(notifications[0], /\$0.02/);
  assert.equal(session.isBusy(), false);
});

test("recent candidate still runs both providers when primary quota is exhausted", async () => {
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => { input.beforeStart?.(); calls.push("claude"); return result("claude", true); });
  const summary = await session.runDispatchSession("cron", recent);
  assert.deepEqual(calls, ["claude", "codex"]);
  assert.equal(summary.attempts?.length, 2);
});

test("fallback cannot replace the selected recent issue with a different observed claim", async () => {
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => { input.beforeStart?.(); calls.push("claude"); return { ...result("claude", true), issueIds: ["old-issue"] }; });
  const summary = await session.runDispatchSession("cron", recent);
  assert.deepEqual(calls, ["claude"]);
  assert.equal(summary.outcome, "error");
  assert.match(summary.summary, /outside the exact selected candidate/);
});

test("failed trigger precheck survives restart and retries a confirmed recent candidate", async () => {
  const file = path.join(dir, "retry.json");
  mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const receipt = new TriggerReceipts(file, () => poller.pollOnce("trigger"));
  receipt.accept("retry-incident");
  await receipt.drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["retry-incident"].done, false);
  assert.deepEqual(calls, []);
  mock.method(globalThis, "fetch", async () => queueResponse());
  await new TriggerReceipts(file, () => poller.pollOnce("trigger")).drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["retry-incident"].done, true);
  assert.deepEqual(calls, ["claude"]);
});

test("manual HTTP trigger without an idempotency key is durable on precheck failure", async () => {
  mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const { triggerRouter } = require("../src/routes/trigger");
  const handler = triggerRouter.stack[0].route.stack[0].handle;
  let status = 0;
  const req = { header: (name: string) => name === "X-Dispatch-Token" ? "test-trigger-token" : undefined, query: {} };
  const res = { status: (value: number) => { status = value; return res; }, json: () => {} };
  handler(req, res);
  assert.equal(status, 202);
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  const receipts = JSON.parse(fs.readFileSync(process.env.TRIGGER_RECEIPTS_FILE!, "utf8"));
  assert.equal(Object.keys(receipts).length, 1);
  assert.match(Object.keys(receipts)[0], /^manual:/);
  assert.equal(Object.values(receipts).every((r: any) => !r.done), true);
  assert.deepEqual(calls, []);
  // Finish the pending receipt while mocks remain active; the unref'd router
  // timer must not carry test work into another test.
  await new TriggerReceipts(process.env.TRIGGER_RECEIPTS_FILE!, async () => ({ ran: false, note: "precheck-skip" }), () => NOW + EMPTY_QUEUE_GRACE_MS).drain();
});


test("native provider adapters refuse inference when their final start guard rejects", async () => {
  let queried = false;
  const beforeStart = () => { throw new CandidateEligibilityError(); };
  await assert.rejects(realExecuteClaude({ id: "guard", prompt: "never send", abortController: new AbortController(),
    mcpServers: {}, onMessage: () => {}, beforeStart,
  }, (() => { queried = true; throw new Error("query must not start"); }) as any), CandidateEligibilityError);
  assert.equal(queried, false);
  await assert.rejects(realExecuteCodex({ id: "guard", prompt: "never send", model: "unused",
    entries: {}, signal: new AbortController().signal, onTool: () => {}, beforeStart,
  }), CandidateEligibilityError);
});

test("failed provider session keeps the accepted trigger pending", async () => {
  const file = path.join(dir, "provider-retry.json");
  mock.method(globalThis, "fetch", async () => queueResponse());
  mock.method(session, "runDispatchSession", async () => ({ outcome: "error" } as any));
  const receipt = new TriggerReceipts(file, () => poller.pollOnce("trigger"));
  receipt.accept("failed-attempt");
  await receipt.drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["failed-attempt"].done, false);
});

test("eligibility loss after queue selection is observable and keeps the wakeup pending", async () => {
  const file = path.join(dir, "aged-retry.json");
  mock.method(globalThis, "fetch", async () => queueResponse());
  mock.method(session, "runDispatchSession", async () => { throw new CandidateEligibilityError(); });
  const receipt = new TriggerReceipts(file, () => poller.pollOnce("trigger"));
  receipt.accept("aged-attempt");
  await receipt.drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["aged-attempt"].done, false);
  assert.equal(poller.getLastPrecheck()?.result, "error");
  assert.match(poller.getLastPrecheck()?.error ?? "", /older than 7 days/);
  assert.deepEqual(calls, []);
});


test("old-only trigger queue retries briefly then settles without any inference", async () => {
  const file = path.join(dir, "old-only.json");
  let now = NOW;
  mock.method(Date, "now", () => now);
  mock.method(globalThis, "fetch", async () => queueResponse("2026-04-01T00:00:00Z"));
  const receipts = new TriggerReceipts(file, () => poller.pollOnce("trigger"), () => now);
  receipts.accept("old-only");
  await receipts.drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["old-only"].done, false);
  now += EMPTY_QUEUE_GRACE_MS;
  await receipts.drain();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["old-only"].done, true);
  assert.deepEqual(calls, []);
});

test("notification failure cannot consume an expiry-trigger retry after a real attempt", async () => {
  mock.method(claude, "executeClaude", async (input: Parameters<typeof claude.executeClaude>[0]) => {
    input.beforeStart?.(); calls.push("claude");
    mock.method(Date, "now", () => NOW + 1);
    return result("claude", true);
  });
  let deliveryAttempted = false;
  mock.method(notify, "sendTelegram", async () => { deliveryAttempted = true; throw new Error("test Telegram unavailable"); });
  await assert.rejects(session.runDispatchSession("trigger", boundary), CandidateEligibilityError);
  assert.equal(deliveryAttempted, true);
  assert.deepEqual(calls, ["claude"]);
});
