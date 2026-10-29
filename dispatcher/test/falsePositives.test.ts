import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-false-positive-"));
process.env.LOG_DIR = path.join(root, "turns");
process.env.DRY_RUN = "false";
process.env.LINEAR_TEAM_ID = "team";
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const { applyFalsePositive, closeFalsePositive, retryFalsePositives } = require("../src/falsePositives") as typeof import("../src/falsePositives");
const candidate = { id: "issue", identifier: "APP-1", signature: "api:eu:noise", priority: 3,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reclaim: false };
const decision = { candidate, decidedAt: "2026-10-29T12:00:00.000Z", reason: "The request is an expected rejected scanner probe.", evidence: ["src/auth.ts:42 and logs at 2026-10-29T12:00Z"] };
function client(options: { fail?: boolean; team?: string; signature?: string; priority?: number } = {}) {
  const calls: Array<{query: string; variables: any}> = [];
  let description = `Original evidence\n**Signature:** \`${options.signature || candidate.signature}\``;
  const request = async (query: string, variables: any): Promise<any> => {
    calls.push({ query, variables });
    if (query.includes("workflowStates")) return { issueLabels: { nodes: [{ id: "fp", team: { id: "team" } }] }, workflowStates: { nodes: [{id: "canceled"}] } };
    if (query.includes("issueUpdate")) {
      description = variables.input.description;
      if (options.fail) { options.fail = false; throw new Error("response lost"); }
      return { issueUpdate: {success: true} };
    }
    return { issue: { id: variables.id, priority: options.priority ?? 3, description, team: {id: options.team || "team"}, labels: {nodes: [{id: "monitor", name: "monitor"}, {id: "claim", name: "agent-claimed"}]} } };
  };
  return { calls, request };
}
test("original evidence, verdict, label and canceled state are written atomically and idempotently", async () => {
  const mock = client();
  await applyFalsePositive(decision, mock.request);
  await applyFalsePositive(decision, mock.request);
  const writes = mock.calls.filter(c => c.query.includes("issueUpdate"));
  assert.equal(writes.length, 2);
  const input = writes[0].variables.input;
  assert.deepEqual(input.labelIds, ["monitor", "fp"]);
  assert.equal(input.stateId, "canceled");
  assert.ok(input.description.startsWith("Original evidence"));
  assert.ok(input.description.includes(decision.evidence[0]));
  assert.ok(input.description.includes(decision.decidedAt));
  assert.equal(writes[1].variables.input.description, input.description);
});
test("changed signature/team or missing evidence refuses a suppression write", async () => {
  for (const options of [{team: "other"}, {signature: "other:signal"}]) {
    const mock = client(options);
    await assert.rejects(applyFalsePositive(decision, mock.request), /changed/);
    assert.ok(mock.calls.every(c => !c.query.includes("issueUpdate")));
  }
  await assert.rejects(applyFalsePositive({...decision, evidence: []}, client().request), /evidence/);
});
test("failed write is replayed from local outbox without a new model run", async () => {
  const mock = client({fail: true});
  await assert.rejects(closeFalsePositive(candidate, decision.reason, decision.evidence, mock.request), /response lost/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "false-positive-outbox.json"), "utf8")).issue);
  await assert.rejects(retryFalsePositives(async () => { throw new Error("offline"); }), /offline/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "false-positive-outbox.json"), "utf8")).issue);
  await retryFalsePositives(mock.request);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "false-positive-outbox.json"), "utf8")), {});
  const writes = mock.calls.filter(c => c.query.includes("issueUpdate"));
  assert.equal(writes[0].variables.input.description, writes[1].variables.input.description);
});

test("obsolete decisions are quarantined without suppression and unrelated deliveries continue", async () => {
  for (const options of [{team: "other"}, {signature: "other:signal"}, {priority: 1}]) {
    const obsolete = {...decision, candidate: {...candidate, id: "obsolete"}};
    fs.writeFileSync(path.join(root, "false-positive-outbox.json"), JSON.stringify({obsolete, issue: decision}));
    const changed = client(options), valid = client();
    await retryFalsePositives((query, variables: any) =>
      variables.id === "obsolete" ? changed.request(query, variables) : valid.request(query, variables));
    assert.ok(changed.calls.every(c => !c.query.includes("issueUpdate")));
    assert.equal(valid.calls.filter(c => c.query.includes("issueUpdate")).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "false-positive-outbox.json"), "utf8")), {});
    const conflict = JSON.parse(fs.readFileSync(path.join(root, "false-positive-conflicts.json"), "utf8")).obsolete;
    assert.deepEqual(conflict.decision, obsolete);
    assert.match(conflict.reason, /changed/);
    await retryFalsePositives(async () => { throw new Error("cleared entries must not retry"); });
  }
});

test("a conflict is not removed if its durable quarantine cannot be written", async () => {
  fs.writeFileSync(path.join(root, "false-positive-outbox.json"), JSON.stringify({issue: decision}));
  const conflicts = path.join(root, "false-positive-conflicts.json");
  fs.writeFileSync(conflicts, "invalid JSON");
  try {
    await assert.rejects(retryFalsePositives(client({priority: 1}).request), SyntaxError);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "false-positive-outbox.json"), "utf8")), {issue: decision});
  } finally {
    fs.unlinkSync(conflicts);
    fs.writeFileSync(path.join(root, "false-positive-outbox.json"), "{}");
  }
});
