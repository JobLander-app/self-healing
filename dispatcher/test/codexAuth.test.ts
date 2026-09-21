import { strict as assert } from "node:assert";
import { test, mock } from "node:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-auth-ownership-"));
process.env.CODEX_HOME = path.join(root, "auth");
process.env.LOG_DIR = path.join(root, "dispatcher", "turns");
process.env.CODEX_BIN = path.join(root, "codex");
process.env.CODEX_ENABLED = "true";
process.env.CODEX_MODEL = "test-model";
fs.mkdirSync(process.env.CODEX_HOME);
const auth = path.join(process.env.CODEX_HOME, "auth.json");
const marker = path.join(process.env.CODEX_HOME, "shl-auth-state.json");
const executions = path.join(root, "executions");
const authModule = path.resolve(__dirname, "../src/providerState.js");
const codexModule = path.resolve(__dirname, "../src/codex.js");
function credentials(generation: string) {
  fs.writeFileSync(auth, JSON.stringify({ tokens: { refresh_token: generation } }), { mode: 0o600 });
}
function fake(body: string) {
  fs.writeFileSync(process.env.CODEX_BIN!, "#!/usr/bin/env node\n" + body, { mode: 0o700 });
}
const success = "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n');";
function worker(code: string) {
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, LOG_DIR: path.join(root, "worker-" + Math.random(), "turns") } });
  let out = "", err = "";
  child.stdout.on("data", chunk => out += chunk);
  child.stderr.on("data", chunk => err += chunk);
  return new Promise<any>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || out)));
  });
}
const runWorker = () => worker(
  "const c=require(" + JSON.stringify(codexModule) + ");" +
  "const timer=setTimeout(()=>process.exit(2),10000);" +
  "c.executeCodex({id:'test',prompt:'test',model:'test',entries:{},signal:new AbortController().signal,onTool:()=>{}})" +
  ".then(r=>{clearTimeout(timer);console.log(JSON.stringify(r));});");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("independent monitor/dispatcher processes serialize refreshes in one persistent auth home", async () => {
  credentials("0");
  fake("const fs=require('fs'),p=require('path');process.stdin.resume();process.stdin.on('end',()=>{" +
    "const auth=p.join(process.env.CODEX_HOME,'auth.json');const n=Number(JSON.parse(fs.readFileSync(auth)).tokens.refresh_token);" +
    "fs.appendFileSync(" + JSON.stringify(executions) + ",n+'\\n');setTimeout(()=>{" +
    "fs.writeFileSync(auth,JSON.stringify({tokens:{refresh_token:String(n+1)}}));" + success + "},180);});");
  const results = await Promise.all([runWorker(), runWorker()]);
  assert.ok(results.every(r => r.attempt.status === "completed"));
  assert.equal(fs.readFileSync(executions, "utf8"), "0\n1\n");
  assert.equal(JSON.parse(fs.readFileSync(auth, "utf8")).tokens.refresh_token, "2");
  assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
});

test("shared auth failure blocks queued and future invocations until new credentials, without restart", async () => {
  const { availableToAttempt, providerReadiness } = await import("../src/providerState");
  credentials("invalid-session-secret");
  fs.writeFileSync(executions, "");
  fake("require('fs').appendFileSync(" + JSON.stringify(executions) + ",'started\\n');" +
    "setTimeout(()=>{process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Your access token could not be refreshed because your refresh token was already used'}})+'\\n');process.exitCode=1;},100);");
  const results = await Promise.all([runWorker(), runWorker()]);
  assert.ok(results.every(r => r.attempt.failureKind === "auth"));
  assert.equal(fs.readFileSync(executions, "utf8"), "started\n");
  assert.equal(availableToAttempt("codex", Date.now() + 30 * 86_400_000), false);
  assert.equal(providerReadiness().providers.find(p => p.provider === "codex")?.ready, false);
  assert.equal(fs.readFileSync(marker, "utf8").includes("invalid-session-secret"), false);
  const restarted = await worker("console.log(JSON.stringify(require(" + JSON.stringify(authModule) + ").availableToAttempt('codex')))");
  assert.equal(restarted, false);
  credentials("new-independent-session");
  assert.equal(availableToAttempt("codex"), true);
  assert.equal(providerReadiness().providers.find(p => p.provider === "codex")?.ready, false);
  fake(success);
  assert.equal((await runWorker()).attempt.status, "completed");
  // Another process records real success; this daemon sees it live.
  assert.equal(providerReadiness().providers.find(p => p.provider === "codex")?.ready, true);
});

test("watchdog kills holder and waiter without launching the waiter; kernel releases lock", async () => {
  const { executeCodex } = await import("../src/codex");
  credentials("watchdog");
  fs.writeFileSync(executions, "");
  fake("require('fs').appendFileSync(" + JSON.stringify(executions) + ",'started\\n');setInterval(()=>{},1000);");
  const holder = new AbortController(), waiter = new AbortController();
  const input = { id: "abort", prompt: "", model: "test", entries: {}, onTool: () => {} };
  const first = executeCodex({ ...input, signal: holder.signal });
  for (let i = 0; i < 200 && !fs.readFileSync(executions, "utf8"); i++) await delay(10);
  assert.equal(fs.readFileSync(executions, "utf8"), "started\n");
  let guardCalls = 0;
  const second = executeCodex({ ...input, signal: waiter.signal, beforeStart: () => { guardCalls++; } });
  await delay(100);
  waiter.abort();
  assert.equal((await second).attempt.failureKind, "timeout");
  assert.equal(guardCalls, 0);
  holder.abort();
  assert.equal((await first).attempt.failureKind, "timeout");
  fake(success);
  assert.equal((await runWorker()).attempt.status, "completed");
});

test("task failures preserve successful shared readiness", async () => {
  const { providerReadiness } = await import("../src/providerState");
  credentials("task-failure");
  fake(success);
  await runWorker();
  const before = fs.readFileSync(marker, "utf8");
  fake("process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Unit test failed'}})+'\\n');process.exitCode=1;");
  assert.equal((await runWorker()).attempt.failureKind, "task");
  assert.equal(fs.readFileSync(marker, "utf8"), before);
  assert.equal(providerReadiness().providers.find(p => p.provider === "codex")?.ready, true);
});

test("queued processes respect newly established cooldowns without extending them", async () => {
  const { availableToAttempt } = await import("../src/providerState");
  credentials("queued-cooldown");
  fs.writeFileSync(executions, "");
  fake("require('fs').appendFileSync(" + JSON.stringify(executions) + ",'started\\n');" +
    "setTimeout(()=>{process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'HTTP 429 rate limit exceeded'}})+'\\n');process.exitCode=1;},100);");
  const results = await Promise.all([runWorker(), runWorker()]);
  assert.ok(results.every(r => r.attempt.failureKind === "throttle"));
  assert.equal(results.filter(r => r.attempt.providerSkipped).length, 1);
  assert.equal(fs.readFileSync(executions, "utf8"), "started\n");
  const before = fs.readFileSync(marker, "utf8");
  assert.equal((await runWorker()).attempt.providerSkipped, true);
  assert.equal(fs.readFileSync(marker, "utf8"), before);
  assert.equal(availableToAttempt("codex"), false);
  assert.equal(availableToAttempt("codex", Date.now() + 86_400_000), true);
});

test("candidate rejection and corrupt coordination state cannot launch Codex", async () => {
  const { executeCodex } = await import("../src/codex");
  const { availableToAttempt } = await import("../src/providerState");
  credentials("guard");
  fs.writeFileSync(executions, "");
  fake("require('fs').appendFileSync(" + JSON.stringify(executions) + ",'started\\n');" + success);
  await assert.rejects(executeCodex({ id: "guard", prompt: "", model: "test", entries: {},
    signal: new AbortController().signal, onTool: () => {}, beforeStart: () => { throw new Error("candidate expired"); } }), /candidate expired/);
  assert.equal(fs.readFileSync(executions, "utf8"), "");
  fs.writeFileSync(marker, "{broken");
  assert.equal(availableToAttempt("codex"), false);
  assert.equal((await runWorker()).attempt.failureKind, "unavailable");
  assert.equal(fs.readFileSync(executions, "utf8"), "");
});

test("a required tool's 401 cannot permanently block a healthy subscription", async () => {
  const { stateForAttempt, stateCanAttempt } = await import("../src/providerState");
  const { unknownUsage } = await import("../src/providerTypes");
  const at = new Date().toISOString();
  const state = stateForAttempt({ id: "mcp", provider: "codex", model: "test", startedAt: at, finishedAt: at,
    status: "failed", failureKind: "auth", error: "MCP server linear startup failed: HTTP 401 unauthorized",
    usage: unknownUsage(), turns: 0, estimatedCostUsd: null, costSource: "unavailable" })!;
  assert.equal(state.requiresLogin, undefined);
  assert.ok(state.retryAt);
  assert.equal(stateCanAttempt(state, Date.now() + 86_400_000), true);
});

test("an unverified fallback is not announced as a confirmed capability outage", async () => {
  const providers = await import("../src/providerState");
  const notifications = await import("../src/notify");
  const { alertProviderReadiness } = await import("../src/healthAlerts");
  let messages = 0;
  const send = mock.method(notifications, "sendTelegram", async () => { messages++; return true; });
  let fallbackStatus: "unknown" | "blocked" = "unknown";
  const snapshot = mock.method(providers, "providerReadiness", () => ({ ready: false, providers: [
    { provider: "claude" as const, status: "blocked" as const, ready: false, canAttempt: false },
    { provider: "codex" as const, status: fallbackStatus, ready: false, canAttempt: fallbackStatus === "unknown" },
  ] }));
  try {
    await alertProviderReadiness();
    assert.equal(messages, 0);
    fallbackStatus = "blocked";
    await alertProviderReadiness();
    await alertProviderReadiness();
    assert.equal(messages, 1);
  } finally { snapshot.mock.restore(); send.mock.restore(); }
});

test("bare and wrapped terminal OAuth codes suspend later CLI launches", async () => {
  const { availableToAttempt } = await import("../src/providerState");
  fs.rmSync(marker, { force: true });
  for (const message of ["invalid_grant", "Error refreshing token: invalid_grant",
    "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]) {
    credentials("terminal-" + message);
    fs.writeFileSync(executions, "");
    const event = JSON.stringify({ type: "turn.failed", error: { message } });
    fake("require('fs').appendFileSync(" + JSON.stringify(executions) + ",'started\\n');" +
      "process.stdout.write(" + JSON.stringify(event + "\n") + ");process.exitCode=1;");
    assert.equal((await runWorker()).attempt.failureKind, "auth", message);
    assert.equal(availableToAttempt("codex", Date.now() + 30 * 86_400_000), false, message);
    const second = await runWorker();
    assert.equal(second.attempt.failureKind, "auth");
    assert.equal(second.attempt.providerSkipped, true);
    assert.equal(fs.readFileSync(executions, "utf8"), "started\n", message);
  }
});
