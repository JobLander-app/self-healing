import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OpenCodeResult, openCodeEnv } from "../src/opencode";
import { fallbackAllowed, executeWithFallback } from "../src/fallback";
import { unknownUsage, type ProviderAttempt } from "../src/providerTypes";
const attempt = (): ProviderAttempt => ({id: "a", provider: "opencode", model: "openrouter/vendor/model", startedAt: "", finishedAt: "", status: "failed", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0});
test("JSON parts aggregate step usage once and require a terminal finish", () => {
  const a = attempt(), result = new OpenCodeResult(a, () => {});
  const event = {type: "step_finish", sessionID: "s", part: {id: "p1", reason: "tool-calls", cost: 0.12, tokens: {input: 20, output: 10, cache: {read: 5, write: 2}}}};
  result.consume(event); result.consume(event);
  assert.equal(a.turns, 1); assert.equal(result.completed, false);
  result.consume({...event, part: {...event.part, id: "p2", reason: "stop"}});
  assert.equal(result.completed, true); assert.equal(a.turns, 2);
  assert.deepEqual(a.usage, {input: 54, output: 20, cachedInput: 10, cacheWrite: 4});
  assert.equal(a.estimatedCostUsd, 0.24);
  result.consume({type: "text", part: {id: "t", text: "done"}});
  assert.equal(result.output.trim(), "done");
});
test("missing usage stays unknown; unknown activity prevents an unsafe handover", () => {
  const a = attempt(), result = new OpenCodeResult(a, () => {});
  result.consume({type: "step_finish", part: {id: "p", reason: "stop"}});
  assert.equal(a.usage.input, null); assert.equal(a.estimatedCostUsd, null);
  result.consume({type: "future_tool_event"}); a.failureKind = "quota";
  assert.equal(fallbackAllowed({attempt: a, output: "", toolsUsed: result.toolsUsed, issueIds: []}), false);
});
test("OpenRouter key is environment-only; unrelated secrets are excluded", () => {
  const env = openCodeEnv({linear: "/repo/mcp/linear/index.js"}, {OPENROUTER_API_KEY: "provider-secret", CLAUDE_CODE_OAUTH_TOKEN: "claude-secret", TG_BOT_TOKEN: "telegram-secret", TRIGGER_TOKEN: "trigger-secret", PATH: "/usr/bin"});
  assert.equal(env.OPENROUTER_API_KEY, "provider-secret");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(env.TG_BOT_TOKEN, undefined);
  assert.ok(!env.OPENCODE_CONFIG_CONTENT!.includes("secret"));
  assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).mcp.linear.command, ["node", "/repo/mcp/linear/index.js"]);
});
test("quota falls through Claude and Codex to OpenCode within one selected task", async () => {
  const called: string[] = [];
  const result = await executeWithFallback({providers: ["claude", "codex", "opencode"], prompt: "exact candidate", signal: new AbortController().signal,
    canAttempt: () => true, record: () => {}, execute: async (provider, prompt) => {
      called.push(provider); assert.ok(prompt.includes("exact candidate"));
      return {attempt: {...attempt(), provider, status: provider === "opencode" ? "completed" : "failed", failureKind: "quota"}, output: "done", toolsUsed: false, issueIds: []};
    }});
  assert.deepEqual(called, ["claude", "codex", "opencode"]); assert.equal(result.error, null);
});

test("CLI adapter uses stdin/JSON mode and rejects incomplete successful exits", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-opencode-cli-"));
  const bin = path.join(root, "opencode");
  const {config} = require("../src/config");
  const {executeOpenCode} = await import("../src/opencode");
  const oldBin = config.openCodeBin, oldKey = process.env.OPENROUTER_API_KEY;
  config.openCodeBin = bin; process.env.OPENROUTER_API_KEY = "test-only-key";
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const args=process.argv.slice(2);
if (args.join(' ') !== 'run --format json --model openrouter/vendor/model --auto') process.exit(2);
let prompt='';process.stdin.on('data', x=>prompt+=x);process.stdin.on('end',()=>{
if(prompt !== 'test prompt') process.exit(3);
console.log(JSON.stringify({type:'text',part:{id:'t',text:'completed'}}));
console.log(JSON.stringify({type:'step_finish',part:{id:'s',reason:'stop',cost:0,tokens:{input:1,output:1,cache:{read:0,write:0}}}}));
});\n`, {mode: 0o700});
    const input = {id: "run", prompt: "test prompt", model: "openrouter/vendor/model", entries: {}, signal: new AbortController().signal, onTool: () => {}};
    const complete = await executeOpenCode(input);
    assert.equal(complete.attempt.status, "completed"); assert.equal(complete.output.trim(), "completed");
    fs.writeFileSync(bin, "#!/usr/bin/env node\nprocess.stdin.resume();\n", {mode: 0o700});
    const incomplete = await executeOpenCode(input);
    assert.equal(incomplete.attempt.status, "failed"); assert.equal(incomplete.attempt.failureKind, "unavailable");
    const abort = new AbortController(); abort.abort();
    assert.equal((await executeOpenCode({...input, signal: abort.signal})).attempt.failureKind, "timeout");
  } finally {
    config.openCodeBin = oldBin;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    fs.rmSync(root, {recursive: true, force: true});
  }
});
