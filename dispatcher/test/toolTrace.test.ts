// The dispatcher's first tests. They exist because of a defect that no amount
// of building would have caught: `session.ts` checked `msg.type === "tool_use"`,
// a message type the SDK does not have, so tool tracing silently produced
// nothing across 143 runs. It compiled, it ran, it logged no error, and it left
// every run undiagnosable.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toolUsesFrom } from "../src/session";

const assistant = (content: unknown[]) => ({
  type: "assistant",
  message: { content },
});

test("extracts tool_use blocks from an assistant message", () => {
  const uses = toolUsesFrom(
    assistant([
      { type: "text", text: "checking the logs" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
      { type: "tool_use", name: "mcp__linear__update_issue", input: { id: "JOB-1" } },
    ])
  );
  assert.deepEqual(uses, [{ tool: "Read" }, { tool: "mcp__linear__update_issue" }]);
});

test("records the leading command word for Bash, never the arguments", () => {
  const uses = toolUsesFrom(
    assistant([
      {
        type: "tool_use",
        name: "Bash",
        // A real run does exactly this — and the trace must not carry the secret.
        input: { command: "gcloud secrets versions access latest --secret=linear-api-key" },
      },
    ])
  );
  assert.deepEqual(uses, [{ tool: "Bash", cmd: "gcloud" }]);
  assert.ok(!JSON.stringify(uses).includes("linear-api-key"), "arguments must not be traced");
});

test("ignores the message type the old code was looking for", () => {
  // The regression itself: this shape never arrives from the SDK, and treating
  // it as the signal is what produced 143 empty traces.
  assert.deepEqual(toolUsesFrom({ type: "tool_use", name: "Bash" }), []);
});

test("returns nothing for non-assistant messages and malformed content", () => {
  assert.deepEqual(toolUsesFrom({ type: "result", result: "done" }), []);
  assert.deepEqual(toolUsesFrom({ type: "assistant", message: {} }), []);
  assert.deepEqual(toolUsesFrom({ type: "assistant", message: { content: "not an array" } }), []);
  assert.deepEqual(toolUsesFrom(null), []);
  assert.deepEqual(toolUsesFrom(undefined), []);
});

test("skips blocks that are not tool_use or lack a name", () => {
  const uses = toolUsesFrom(
    assistant([
      { type: "thinking", thinking: "..." },
      { type: "tool_use", input: { command: "ls" } },
      { type: "tool_use", name: "Glob", input: {} },
    ])
  );
  assert.deepEqual(uses, [{ tool: "Glob" }]);
});

test("handles a Bash command with leading whitespace and a long binary path", () => {
  const uses = toolUsesFrom(
    assistant([{ type: "tool_use", name: "Bash", input: { command: "   git   status" } }])
  );
  assert.deepEqual(uses, [{ tool: "Bash", cmd: "git" }]);
});

test("never traces a leading shell assignment — it carries the secret", () => {
  // CodeRabbit Major on PR #26: the 40-char truncation does not make this safe,
  // it just ships a shorter secret. The tool name alone is enough to diagnose.
  const uses = toolUsesFrom(
    assistant([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "LINEAR_API_KEY=sk-live-abcdef gcloud secrets list" },
      },
    ])
  );
  assert.deepEqual(uses, [{ tool: "Bash" }]);
  assert.ok(!JSON.stringify(uses).includes("sk-live"), "assignment value must not be traced");
});

test("still records the binary when the command has no assignment prefix", () => {
  assert.deepEqual(
    toolUsesFrom(assistant([{ type: "tool_use", name: "Bash", input: { command: "gh pr view 26" } }])),
    [{ tool: "Bash", cmd: "gh" }]
  );
});
