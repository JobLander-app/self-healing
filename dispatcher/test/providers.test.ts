import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-providers-"));
process.env.LOG_DIR = path.join(root, "turns");
process.env.CODEX_BIN = path.join(root, "codex");
process.env.CODEX_ENABLED = "true";
process.env.CODEX_MODEL = "verified-test-model";

test("Claude and Codex quota variants and dated resets", async () => {
  const { isLimitError, parseResetTime } = await import("../src/pause");
  const now = new Date("2026-09-09T15:30:00Z");
  for (const message of ["You're out of extra usage · resets Sep 13, 3pm (UTC)", "usage_limit_reached", "You've hit your limit · resets 4:30pm (UTC)"]) assert.ok(isLimitError(message));
  assert.equal(parseResetTime("resets Sep 13, 3pm (UTC)", now)?.toISOString(), "2026-09-13T15:02:00.000Z");
  assert.equal(parseResetTime("resets 4:30pm (UTC)", now)?.toISOString(), "2026-09-09T16:32:00.000Z");
  assert.equal(parseResetTime("resets 3pm (UTC)", now)?.toISOString(), "2026-09-10T15:02:00.000Z");
  assert.equal(parseResetTime("resets Feb 30, 3pm (UTC)", now), null);
  assert.equal(parseResetTime("resets Jan 1, 3pm (UTC)", new Date("2026-12-31T12:00:00Z"))?.toISOString(), "2027-01-01T15:02:00.000Z");
});

test("SDK result errors are recognized even without a thrown exception", async () => {
  const { claudeResultError } = await import("../src/claude");
  assert.match(claudeResultError({ type: "result", subtype: "error_during_execution", errors: ["You're out of extra usage"] })!, /extra usage/);
  assert.equal(claudeResultError({ type: "result", subtype: "success", result: "done" }), null);
  assert.equal(claudeResultError({ type: "result", subtype: "success", is_error: true, result: "401 unauthorized" }), "401 unauthorized");
});

test("provider connectivity/model errors cool down while task failures do not", async () => {
  const { classifyFailure } = await import("../src/providerState");
  for (const message of ["stream disconnected before completion", "error sending request for url", "The model is not supported with this account", "HTTP 529 overloaded", "spawn /usr/bin/codex ENOENT"]) assert.equal(classifyFailure(message), "unavailable");
  assert.equal(classifyFailure("Reached maximum number of turns (120)"), "task");
  assert.equal(classifyFailure("unit tests failed"), "task");
});

test("usage normalization preserves cache semantics and unknown values", async () => {
  const { claudeUsage } = await import("../src/claude");
  const { codexUsage } = await import("../src/codex");
  assert.deepEqual(claudeUsage({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 5 }), { input: 140, cachedInput: 100, cacheWrite: 30, output: 5 });
  assert.deepEqual(codexUsage({ input_tokens: 140, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 5 }), { input: 140, cachedInput: 100, cacheWrite: 0, output: 5 });
  assert.equal(codexUsage(undefined).input, null);
  assert.equal(claudeUsage({ input_tokens: 0, output_tokens: 0 }).input, 0);
});

test("Codex authentication cannot inherit API keys or dispatcher secrets", async () => {
  const { codexEnv, codexArgs } = await import("../src/codex");
  const env = codexEnv({ HOME: "/home/agent", PATH: "/bin", OPENAI_API_KEY: "forbidden", CODEX_API_KEY: "forbidden", CLAUDE_CODE_OAUTH_TOKEN: "forbidden", TG_BOT_TOKEN: "forbidden" });
  assert.equal(env.CODEX_HOME, "/home/agent/.codex-shl");
  assert.ok(!Object.values(env).includes("forbidden"));
  const args = codexArgs({ linear: "/repo/mcp/linear/index.js" }, "model");
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes("mcp_servers.linear.required=true"));
  assert.equal(args.at(-1), "-");
});

test("fallback preserves same-ticket handover, never retries arbitrary task errors", async () => {
  const { executeWithFallback } = await import("../src/fallback");
  const { unknownUsage } = await import("../src/providerTypes");
  type Provider = import("../src/providerTypes").Provider;
  const run = async (kind: "quota" | "task", toolsUsed: boolean, issueIds: string[]) => {
    const seen: string[] = [], attempts: string[] = [];
    const value = await executeWithFallback({ providers: ["claude", "codex"], prompt: "constitution", signal: new AbortController().signal, canAttempt: () => true,
      execute: async (p: Provider, prompt) => {
        seen.push(prompt);
        return { output: p === "codex" ? "done" : "", toolsUsed, issueIds, attempt: { id: p, provider: p, model: "m", status: p === "claude" ? "failed" : "completed", failureKind: kind, error: "quota", startedAt: "now", finishedAt: "now", usage: unknownUsage(), turns: 0, estimatedCostUsd: null, costSource: "unavailable" } };
      }, record: a => { attempts.push(a.provider); } });
    return { value, seen, attempts };
  };
  const quota = await run("quota", true, ["JOB-1"]);
  assert.deepEqual(quota.attempts, ["claude", "codex"]);
  assert.match(quota.seen[1], /Work on this ticket ONLY/);
  assert.match(quota.seen[1], /NEW session/);
  assert.equal(quota.value.error, null);
  assert.deepEqual((await run("task", false, [])).attempts, ["claude"]);
  assert.deepEqual((await run("quota", true, [])).attempts, ["claude"]);
  assert.deepEqual((await run("quota", false, [])).attempts, ["claude", "codex"]);
});

test("real child JSON transport handles usage, reconnect and duplicate terminal snapshots", async () => {
  const { executeCodex } = await import("../src/codex");
  fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node
process.stdin.resume(); process.stdin.on('end', () => {
for (const event of [
 {type:'thread.started',thread_id:'t1'}, {type:'error',message:'reconnecting'},
 {type:'item.started',item:{type:'mcp_tool_call',server:'linear',tool:'get_issue',arguments:{secret:'NEVER_TRACE'}}},
 {type:'item.completed',item:{type:'agent_message',text:'done'}},
 {type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:10,output_tokens:2}},
 {type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:10,output_tokens:2}}
]) process.stdout.write(JSON.stringify(event)+'\\n'); });`, { mode: 0o700 });
  const uses: object[] = [];
  const result = await executeCodex({ id: "one", prompt: "read-only", model: "verified", entries: {}, signal: new AbortController().signal, onTool: u => uses.push(u) });
  assert.equal(result.attempt.status, "completed");
  assert.equal(result.attempt.usage.input, 12);
  assert.equal(result.attempt.turns, 1);
  assert.equal(result.attempt.estimatedCostUsd, null);
  assert.deepEqual(uses, [{ tool: "mcp__linear__get_issue" }]);
});

test("unknown Codex action types are never treated as a side-effect-free handover", async () => {
  const { codexTool } = await import("../src/codex");
  assert.deepEqual(codexTool({ type: "item.started", item: { type: "custom_tool_call", input: "secret command" } }), { tool: "codex_custom_tool_call" });
  assert.deepEqual(codexTool({ type: "item.completed", item: { type: "file_change" } }), { tool: "file_change" });
  for (const type of ["agent_message", "reasoning", "todo_list", "plan"]) assert.equal(codexTool({ type: "item.started", item: { type } }), null);
});

test("child failure and wall-clock abort release the process", async () => {
  const { executeCodex } = await import("../src/codex");
  fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'usage_limit_reached'}})+'\\n');process.exitCode=1;`, { mode: 0o700 });
  let result = await executeCodex({ id: "two", prompt: "probe", model: "verified", entries: {}, signal: new AbortController().signal, onTool: () => {} });
  assert.equal(result.attempt.failureKind, "quota");
  assert.equal(result.attempt.usage.input, null);
  fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node
setInterval(()=>{},10000);`, { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  result = await executeCodex({ id: "three", prompt: "probe", model: "verified", entries: {}, signal: controller.signal, onTool: () => {} });
  clearTimeout(timer);
  assert.equal(result.attempt.failureKind, "timeout");
});

test("readiness stays blocked after cooldown until a real successful turn", async () => {
  const { updateProvider, providerReadiness, availableToAttempt } = await import("../src/providerState");
  const { unknownUsage } = await import("../src/providerTypes");
  const at = new Date().toISOString();
  const a: import("../src/providerTypes").ProviderAttempt = { id: "state", provider: "claude", model: "m", startedAt: at, finishedAt: at, status: "failed", failureKind: "quota", error: "out of extra usage", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  updateProvider(a);
  assert.equal(providerReadiness().providers.find(p => p.provider === "claude")?.ready, false);
  assert.equal(availableToAttempt("claude", Date.now() + 3_700_000), true);
  assert.equal(providerReadiness(Date.now() + 3_700_000).providers.find(p => p.provider === "claude")?.ready, false);
  updateProvider({ ...a, status: "completed" });
  assert.equal(providerReadiness().providers.find(p => p.provider === "claude")?.ready, true);
});

test("ledger counters survive restart and trace rotation beyond the 50 run feed", async () => {
  const { recordRun, recordAttempt, hydrateFromDisk, getRecentRuns } = await import("../src/trace");
  const { renderMetrics } = await import("../src/metrics");
  for (let i = 0; i < 65; i++) {
    const stamp = new Date(Date.now() + i * 1000).toISOString();
    const a: import("../src/providerTypes").ProviderAttempt = { id: `a${i}`, provider: "codex", model: "verified", startedAt: stamp, finishedAt: stamp, status: "completed", usage: { input: 10, cachedInput: 8, cacheWrite: 0, output: 2 }, estimatedCostUsd: null, costSource: "unavailable", turns: 1 };
    recordAttempt(`run${i}`, a);
    recordRun({ turnId: `run${i}`, startedAt: stamp, finishedAt: stamp, durationSec: 1, outcome: "fixed", costUsd: null, attempts: [a], numTurns: 1, dryRun: true, summary: "test" });
  }
  const input = { busy: false, lastRun: null, lastHealthcheck: null, lastPrecheck: null };
  const before = renderMetrics(input);
  hydrateFromDisk(); hydrateFromDisk();
  assert.equal(renderMetrics(input), before);
  assert.equal(getRecentRuns(100).length, 50);
  assert.match(before, /runs_total\{outcome="fixed"\} 65/);
  fs.rmSync(process.env.LOG_DIR!, { recursive: true });
  hydrateFromDisk();
  assert.equal(renderMetrics(input), before);
});

test("Linear failure still notifies and never claims ticket creation", async () => {
  const { reportDependencyFailure } = await import("../src/healthcheck");
  const messages: string[] = [], order: string[] = [];
  const failure = { dep: "linear", detail: "offline", healthy: false, latencyMs: 0 };
  await reportDependencyFailure(failure, { resolveKey: async () => { throw new Error("unreachable"); }, exists: async () => false, file: async () => "JOB-1", notify: async s => { messages.push(s); } });
  assert.match(messages[0], /could not be filed/);
  await reportDependencyFailure(failure, { resolveKey: async () => "key", exists: async () => false, file: async () => { order.push("file"); return "JOB-1"; }, notify: async s => { order.push("notify"); messages.push(s); } });
  assert.deepEqual(order, ["file", "notify"]);
  assert.match(messages[1], /JOB-1 filed/);
  await reportDependencyFailure(failure, { resolveKey: async () => "key", exists: async () => true, file: async () => { throw new Error("must not duplicate"); }, notify: async s => { messages.push(s); } });
  assert.match(messages[2], /Existing repair ticket/);
});

test("health alerts retry failed delivery and send recovery once", async () => {
  const { healthAlert, retryHealthAlerts } = await import("../src/healthAlerts");
  let calls = 0;
  await healthAlert("test-delivery", true, "down", async () => { calls++; return false; });
  const saved = JSON.parse(fs.readFileSync(path.join(root, "health-alerts.json"), "utf8"));
  assert.equal(saved["test-delivery"].pending, true);
  await retryHealthAlerts(async () => { calls++; return true; });
  await retryHealthAlerts(async () => { calls++; return true; });
  assert.equal(calls, 2);
  await healthAlert("test-delivery", false, "recovered", async () => { calls++; return true; });
  await healthAlert("test-delivery", false, "recovered", async () => { calls++; return true; });
  assert.equal(calls, 3);
});

test("MCP smoke rejects malformed and empty success envelopes", async () => {
  const { validSmokeResult } = await import("../src/healthcheck");
  for (const value of [undefined, {}, { content: [] }, { content: [{}] }, { content: [{ type: "text", text: "" }] }, { content: [{ type: "text", text: "ok" }], isError: "false" }]) assert.equal(validSmokeResult(value), false);
  assert.equal(validSmokeResult({ content: [{ type: "text", text: "[]" }] }), true);
});

test("MCP timeout terminates descendants and pipe errors fail without crashing", async () => {
  const { probeMcp } = await import("../src/healthcheck");
  const fixture = path.join(root, "hanging-mcp.js");
  fs.writeFileSync(fixture, `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);`);
  const start = Date.now();
  await assert.rejects(probeMcp({ entry: fixture, smokeTool: "unused", smokeArgs: {}, budgetMs: 100 }), /timed out|exhausted/);
  assert.ok(Date.now() - start < 1000);
  fs.writeFileSync(fixture, "process.exit(1);");
  await assert.rejects(probeMcp({ entry: fixture, smokeTool: "unused", smokeArgs: {}, budgetMs: 100 }));
});

test("interrupted attempts and a partial ledger tail recover without double counting", async () => {
  const { recordAttemptStarted, hydrateFromDisk } = await import("../src/trace");
  const { renderMetrics } = await import("../src/metrics");
  recordAttemptStarted("interrupted", "codex", "interrupted-model");
  fs.appendFileSync(path.join(root, "usage-ledger.jsonl"), '{"broken":');
  hydrateFromDisk(); hydrateFromDisk();
  const metrics = renderMetrics({ busy: false, lastRun: null, lastHealthcheck: null, lastPrecheck: null });
  assert.match(metrics, /provider_attempts_total\{provider="codex",model="interrupted-model"\} 1/);
  assert.match(metrics, /provider_usage_unknown_total\{provider="codex",model="interrupted-model"\} 1/);
});

test("monitor fallback keeps its escalation scope and never retries after tool actions", async () => {
  const { handoverPrompt, fallbackAllowed } = await import("../src/fallback");
  const { unknownUsage } = await import("../src/providerTypes");
  const previous: import("../src/providerTypes").AttemptResult = { output: "", toolsUsed: false, issueIds: [], attempt: { id: "monitor", provider: "claude", model: "m", status: "failed", failureKind: "quota", startedAt: "now", finishedAt: "now", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 } };
  const prompt = handoverPrompt("Create only deduplicated incident reports", previous, "monitor");
  assert.match(prompt, /SAME monitor escalation batch/);
  assert.match(prompt, /Do not pick or claim repair tickets/);
  assert.equal(fallbackAllowed(previous, "monitor"), true);
  assert.equal(fallbackAllowed({ ...previous, toolsUsed: true, issueIds: ["JOB-1"] }, "monitor"), false);
});

test("unavailable intent coverage does not authorize infrastructure reversal", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../src/session.ts"), "utf8");
  const constitution = fs.readFileSync(path.resolve(__dirname, "../../CLAUDE.md"), "utf8");
  assert.match(source, /Do not create\/delete\/restore resources/);
  assert.match(constitution, /Unavailable intent evidence is not permission/);
  assert.doesNotMatch(source, /FAIL OPEN on availability:/);
});

test("pre-aborted fallback never runs a provider and reports watchdog abort", async () => {
  const { executeWithFallback } = await import("../src/fallback");
  const controller = new AbortController(); controller.abort();
  const result = await executeWithFallback({ providers: ["claude", "codex"], prompt: "test", signal: controller.signal, canAttempt: () => true, execute: async () => { throw new Error("must not run"); }, record: () => {} });
  assert.equal(result.results.length, 0); assert.match(result.error!, /watchdog.*aborted/);
});

test("UTF8 prompt decoding preserves characters split across input chunks", async () => {
  const { Readable } = await import("node:stream");
  const { readProviderPrompt } = await import("../src/promptInput");
  const prompt = "Проверь self healing — 東京 🛠️";
  const chunks = Array.from(Buffer.from(prompt), byte => Buffer.from([byte]));
  assert.equal(await readProviderPrompt(Readable.from(chunks)), prompt);
});

test("malformed persisted alert and provider state is safely bounded and retryable", async () => {
  const { parseAlertState } = await import("../src/healthAlerts");
  const { parseProviderState, stateCanAttempt } = await import("../src/providerState");
  for (const value of [null, false, 1, "text", []]) {
    assert.equal(Object.keys(parseAlertState(value)).length, 0);
    assert.equal(parseProviderState(value), null);
  }
  assert.equal(Object.keys(parseAlertState({ bad: null, malformed: { active: true }, valid: { active: true, pending: false, message: "down", deliveredAt: "invalid" } })).length, 1);
  for (const retryAt of [undefined, "broken"]) {
    const s = parseProviderState({ status: "blocked", retryAt, checkedAt: 42 })!;
    assert.equal(s.status, "blocked"); assert.equal(stateCanAttempt(s), true); assert.equal(s.checkedAt, undefined);
  }
});

test("generic throttling uses a short separate retry while explicit reset metadata wins", async () => {
  const { classifyFailure, updateProvider, providerReadiness } = await import("../src/providerState");
  const { unknownUsage } = await import("../src/providerTypes");
  for (const message of ["HTTP 429", "Rate limit exceeded", "Too many requests"]) assert.equal(classifyFailure(message), "throttle");
  assert.equal(classifyFailure("429 usage_limit_reached"), "quota");
  const at = new Date().toISOString();
  const a: import("../src/providerTypes").ProviderAttempt = { id: "throttle", provider: "claude", model: "m", startedAt: at, finishedAt: at, status: "failed", failureKind: "throttle", error: "429", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  updateProvider(a);
  assert.equal(Date.parse(providerReadiness().providers[0].retryAt!) - Date.parse(at), 60_000);
  const deadline = new Date(Date.now() + 5 * 60_000).toISOString();
  updateProvider({ ...a, error: `429 retry_at ${deadline}` });
  assert.equal(Date.parse(providerReadiness().providers[0].retryAt!), Date.parse(deadline) + 120_000);
});

test("empty Claude stream is unavailable and eligible for safe fallback", async () => {
  const { executeClaude } = await import("../src/claude");
  const { fallbackAllowed } = await import("../src/fallback");
  const result = await executeClaude({ id: "empty", prompt: "test", abortController: new AbortController(), mcpServers: {}, onMessage: () => {} }, (async function* () {}) as any);
  assert.equal(result.attempt.failureKind, "unavailable"); assert.equal(fallbackAllowed(result), true);
});

test("Codex malformed and oversized transport data enters provider cooldown", async () => {
  const { executeCodex, codexArgs } = await import("../src/codex");
  const { updateProvider, availableToAttempt } = await import("../src/providerState");
  assert.ok(codexArgs({}, "m").includes("--ephemeral"));
  for (const payload of ["not JSON", "null", "x".repeat(4_000_100)]) {
    const fixture = path.join(root, "malformed-payload");
    fs.writeFileSync(fixture, payload);
    fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node\nprocess.stdout.write(require('fs').readFileSync(${JSON.stringify(fixture)}));`, { mode: 0o700 });
    const result = await executeCodex({ id: "bad-json", prompt: "test", model: "m", entries: {}, signal: new AbortController().signal, onTool: () => {} });
    assert.equal(result.attempt.failureKind, "unavailable");
    updateProvider(result.attempt); assert.equal(availableToAttempt("codex"), false);
  }
});

test("Prometheus metric families are contiguous even with multiple providers and models", async () => {
  const { renderMetrics, incrementAttemptCounters } = await import("../src/metrics");
  const at = new Date().toISOString();
  for (const provider of ["claude", "codex"] as const) incrementAttemptCounters({ id: provider, provider, model: "family-test", startedAt: at, finishedAt: at, status: "completed", usage: { input: 3, cachedInput: 1, cacheWrite: 0, output: 2 }, estimatedCostUsd: null, costSource: "unavailable", turns: 1 });
  const text = renderMetrics({ busy: false, lastRun: null, lastHealthcheck: null, lastPrecheck: null });
  let last = ""; const seen = new Set<string>();
  for (const line of text.trim().split("\n")) {
    const name = line.startsWith("#") ? line.split(" ")[2] : line.split(/[ {]/)[0];
    if (name !== last) { assert.equal(seen.has(name), false, `${name} reappears after another family`); seen.add(name); last = name; }
  }
});

test("delivered active alerts remain suppressed beyond six hours until recovery and recurrence", async () => {
  const { healthAlert } = await import("../src/healthAlerts");
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); return true; };
  const originalNow = Date.now;
  const start = originalNow();
  try {
    Date.now = () => start;
    await healthAlert("no-realert", true, "down", send);
    for (const hours of [6, 12, 24, 72]) {
      Date.now = () => start + hours * 3_600_000;
      await healthAlert("no-realert", true, "still down", send);
    }
    assert.deepEqual(messages, ["down"]);
    await healthAlert("no-realert", false, "recovered", send);
    await healthAlert("no-realert", false, "still healthy", send);
    await healthAlert("no-realert", true, "down again", send);
    assert.deepEqual(messages, ["down", "recovered", "down again"]);
  } finally { Date.now = originalNow; }
});

test("repeated state observations retry pending delivery without replacing an in-flight alert", async () => {
  const { healthAlert } = await import("../src/healthAlerts");
  let calls = 0;
  await healthAlert("pending-observation", true, "down", async () => { calls++; return false; });
  let acknowledge!: () => void;
  const pending = healthAlert("pending-observation", true, "still down", async () => {
    calls++;
    await new Promise<void>(resolve => { acknowledge = resolve; });
    return true;
  });
  await healthAlert("pending-observation", true, "down again during delivery", async () => { calls++; return true; });
  acknowledge(); await pending;
  await healthAlert("pending-observation", true, "still down after delivery", async () => { calls++; return true; });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "health-alerts.json"), "utf8"))["pending-observation"].pending, false);
});
