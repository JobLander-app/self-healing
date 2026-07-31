// End-to-end over the part that can be tested deterministically: an assistant
// message of the SDK's documented shape must land as `tool_use` lines in the
// on-disk JSONL trace. This closes the loop from message -> traceEvent -> file,
// which is where the original defect lived (the extraction never matched, so
// nothing was ever written).
//
// What it deliberately does NOT assert is that the SDK emits this shape — that
// is a fact about a third-party package, verified against its own type
// declarations (`sdk.d.ts` has no top-level `tool_use` message; tool calls are
// content blocks on `assistant`). The remaining confirmation is operational:
// after deploy, a real run's trace must contain tool_use events.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-trace-"));
process.env.LOG_DIR = logDir;

test("assistant tool_use blocks reach the JSONL trace file", async () => {
  // Imported inside the test, AFTER LOG_DIR is set above: config reads the
  // environment at module load, so a top-level import would bind the default.
  const { traceEvent } = await import("../src/trace");
  const { toolUsesFrom } = await import("../src/session");

  const turnId = "dispatch-test-trace";
  const message = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "looking" },
        { type: "tool_use", name: "Bash", input: { command: "gcloud logging read" } },
        { type: "tool_use", name: "mcp__linear__update_issue", input: { id: "JOB-1" } },
      ],
    },
  };

  for (const use of toolUsesFrom(message)) traceEvent(turnId, "tool_use", use);

  const lines = fs
    .readFileSync(path.join(logDir, `${turnId}.jsonl`), "utf-8")
    .trim()
    .split("\n")
    .map(l => JSON.parse(l));

  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map(l => l.data),
    [{ tool: "Bash", cmd: "gcloud" }, { tool: "mcp__linear__update_issue" }]
  );
  assert.ok(lines.every(l => l.kind === "tool_use" && l.turnId === turnId));
});
