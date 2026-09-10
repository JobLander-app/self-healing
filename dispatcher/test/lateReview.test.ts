import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-late-review-"));
process.env.LOG_DIR = path.join(root, "turns");
process.env.CODEX_BIN = path.join(root, "codex");
process.env.CODEX_HOME = path.join(root, "subscription-auth");
process.env.CODEX_ENABLED = "true";
process.env.CODEX_MODEL = "test-model";

test("smoke child is read-only with temporary cwd/home, minimal environment and subscription auth preserved", async () => {
  const { executeCodexSmoke, codexArgs } = await import("../src/codex");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = "/production/google.json";
  process.env.CLOUDSDK_CONFIG = "/production/gcloud";
  process.env.OPENAI_API_KEY = "test-must-not-be-forwarded";
  fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>prompt+=s);
process.stdin.on('end',()=>{
 const text=JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env,prompt});
 process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');
 process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1}})+'\\n');
});`, { mode: 0o700 });
  const result = await executeCodexSmoke({ id: "smoke", model: "test-model", prompt: "read-only проверка", signal: new AbortController().signal, onTool: () => {} });
  assert.equal(result.attempt.status, "completed");
  const observed = JSON.parse(result.output);
  assert.equal(observed.args[observed.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(!observed.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert.ok(observed.args.includes(flag));
  for (const feature of ["shell_tool", "apps", "multi_agent"]) assert.equal(observed.args[observed.args.indexOf(feature) - 1], "--disable");
  assert.equal(observed.env.CODEX_HOME, process.env.CODEX_HOME);
  assert.equal(path.join(fs.realpathSync(path.dirname(observed.env.HOME)), path.basename(observed.env.HOME)), observed.cwd);
  assert.notEqual(observed.cwd, process.cwd());
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG", "OPENAI_API_KEY", "GCP_PROJECT_ID", "TG_BOT_TOKEN"]) assert.equal(observed.env[key], undefined);
  assert.equal(observed.prompt, "read-only проверка");
  assert.equal(fs.existsSync(observed.cwd), false);
  // The actual repair entry point retains its explicitly authorized profile.
  assert.ok(codexArgs({}, "test-model").includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("restricted smoke retains watchdog abort and removes its temporary cwd", async () => {
  const { executeCodexSmoke } = await import("../src/codex");
  const marker = path.join(root, "child-cwd");
  fs.writeFileSync(process.env.CODEX_BIN!, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)},process.cwd());setInterval(()=>{},1000);`, { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const pending = executeCodexSmoke({ id: "abort", model: "test-model", prompt: "probe", signal: controller.signal, onTool: () => {} });
    for (let i = 0; i < 500 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    assert.equal(result.attempt.failureKind, "timeout");
    assert.equal(fs.existsSync(fs.readFileSync(marker, "utf8")), false);
  } finally { clearTimeout(timer); }
});

test("failed recovery persistence does not skip other recoveries or provider readiness and remains retryable", async () => {
  const { healthAlert, retryHealthAlerts } = await import("../src/healthAlerts");
  const { notifyHealthcheckRecovery } = await import("../src/healthcheck");
  for (const dep of ["firebase", "linear"]) await healthAlert(`dependency:${dep}`, true, "down", async () => true);
  const tmp = path.join(root, "health-alerts.json.tmp");
  fs.mkdirSync(tmp); // simulate a failing outbox write without changing the ledger
  let readiness = 0;
  const observed: string[] = [];
  await notifyHealthcheckRecovery(["firebase", "linear"].map(dep => ({ dep, healthy: true, detail: "ok", latencyMs: 1 })), {
    recovery: async (key, active, message) => { observed.push(key); await healthAlert(key, active, message, async () => true); },
    readiness: async () => { readiness++; },
  });
  assert.deepEqual(observed, ["dependency:firebase", "dependency:linear"]);
  assert.equal(readiness, 1);
  fs.rmdirSync(tmp);
  const messages: string[] = [];
  await retryHealthAlerts(async message => { messages.push(message); return true; });
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.includes("recovered")));
  const saved = JSON.parse(fs.readFileSync(path.join(root, "health-alerts.json"), "utf8"));
  assert.equal(saved["dependency:firebase"].pending, false);
  assert.equal(saved["dependency:linear"].pending, false);
});

test("expired ISO reset uses cooldown while a future buffered reset remains eligible", async () => {
  const { parseResetTime } = await import("../src/pause");
  const { updateProvider, providerReadiness, availableToAttempt } = await import("../src/providerState");
  const { unknownUsage } = await import("../src/providerTypes");
  const now = new Date("2026-09-10T13:00:00Z");
  assert.equal(parseResetTime("resets 2026-09-10T12:00:00Z", now), null);
  assert.equal(parseResetTime("retry_at 2026-09-10T12:58:00Z", now), null);
  assert.equal(parseResetTime("resets 2026-09-10T12:59:00Z", now)?.toISOString(), "2026-09-10T13:01:00.000Z");
  assert.equal(parseResetTime("resets 2026-09-10T14:00:00Z", now)?.toISOString(), "2026-09-10T14:02:00.000Z");
  updateProvider({ id: "quota", provider: "claude", model: "test", startedAt: now.toISOString(), finishedAt: now.toISOString(), status: "failed", failureKind: "quota", error: "usage_limit_reached resets 2026-09-10T12:00:00Z", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 });
  assert.equal(providerReadiness(now.getTime()).providers[0].retryAt, "2026-09-10T14:00:00.000Z");
  assert.equal(availableToAttempt("claude", now.getTime()), false);
});
