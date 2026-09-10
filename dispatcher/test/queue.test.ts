import { strict as assert } from "node:assert";
import { test, beforeEach, afterEach, mock } from "node:test";
import { candidateInstruction, isQueueCandidate, queuePolicy, selectCandidate, isRecentIssue, MAX_ISSUE_AGE_MS, buildQueueFilter, type QueueIssue } from "../src/queue";
import { readCandidate } from "../src/queueClient";
import { buildDispatchPrompt } from "../src/session";

const NOW = Date.parse("2026-09-09T12:30:00Z");
beforeEach(() => { mock.method(Date, "now", () => NOW); });
afterEach(() => { mock.restoreAll(); });

const CUTOFF = "2026-09-09T12:00:00Z";
function issue(overrides: Partial<QueueIssue> = {}): QueueIssue {
  return {
    id: "issue-1", identifier: "JOB-1", title: "[Monitor] Audio failed", description: "Observed error signature",
    priority: 2, createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-09T11:00:00Z",
    state: { name: "Backlog" }, labels: { nodes: [] }, children: { nodes: [] }, ...overrides,
  };
}

test("prefix-only backlog tickets select an exact candidate instead of an empty label-only queue", () => {
  const backlog = Array.from({ length: 51 }, (_, i) => issue({ id: `issue-${i}`, identifier: `JOB-${i + 1}` }));
  const selected = selectCandidate(backlog, CUTOFF);
  assert.equal(selected?.identifier, "JOB-1");
  assert.equal(selected?.reclaim, false);
  assert.match(candidateInstruction(selected!), /exact candidate/);
  assert.match(candidateInstruction(selected!), /without the monitor label/);
  assert.match(queuePolicy(40), /label "monitor" OR title prefix "\[Monitor\]"/);
  assert.match(queuePolicy(40), /older than 40 minutes/);
});

test("a monitor label also admits SelfHeal tickets without the prefix", () => {
  assert.equal(isQueueCandidate(issue({ title: "[SelfHeal] Linear down", labels: { nodes: [{ name: "monitor" }] } }), CUTOFF), true);
  assert.equal(isQueueCandidate(issue({ title: "Build a new feature" }), CUTOFF), false);
});

test("In Progress requires a stale agent label regardless of assignee", () => {
  const inProgress = issue({ state: { name: "In Progress" } });
  assert.equal(isQueueCandidate(inProgress, CUTOFF), false);
  const claimed = { ...inProgress, labels: { nodes: [{ name: "agent-claimed" }] } };
  assert.equal(isQueueCandidate(claimed, CUTOFF), true);
  assert.equal(selectCandidate([claimed], CUTOFF)?.reclaim, true);
  assert.equal(isQueueCandidate({ ...claimed, updatedAt: CUTOFF }, CUTOFF), false);
  assert.equal(isQueueCandidate({ ...claimed, updatedAt: "2026-09-09T12:05:00Z" }, CUTOFF), false);
  assert.equal(isQueueCandidate({ ...claimed, updatedAt: "invalid" }, CUTOFF), false);
});

test("terminal, parent, and descriptionless tickets never spawn an investigation", () => {
  for (const candidate of [
    issue({ state: { name: "Done" } }), issue({ state: { name: "Canceled" } }),
    issue({ description: "  " }), issue({ description: null }),
    issue({ children: { nodes: [{ id: "child" }] } }),
  ]) assert.equal(selectCandidate([candidate], CUTOFF), null);
});

test("selection ranks priority before age, handles unprioritized and deduplicates", () => {
  const low = issue({ id: "low", priority: 4, createdAt: "2026-09-03T00:00:00Z" });
  const urgent = issue({ id: "urgent", identifier: "JOB-2", priority: 1, createdAt: "2026-09-05T00:00:00Z" });
  const olderUrgent = issue({ id: "old-urgent", identifier: "JOB-3", priority: 1, createdAt: "2026-09-04T00:00:00Z" });
  const unprioritized = issue({ id: "none", priority: 0, createdAt: "2026-09-03T00:00:00Z" });
  assert.equal(selectCandidate([low, urgent, olderUrgent, unprioritized, urgent], CUTOFF)?.id, "old-urgent");
  assert.equal(selectCandidate([unprioritized, low], CUTOFF)?.id, "low");
});

function response(nodes: QueueIssue[], hasNextPage = false, endCursor: string | null = null): Response {
  return new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } }));
}

test("read-only polling drains pages and hands off the oldest urgent issue from a later page", async () => {
  const requests: Array<{ query: string; variables: { after: string | null } }> = [];
  const candidate = await readCandidate({ key: "test", team: "JobLander", staleClaimBefore: CUTOFF,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? response([issue({ id: "later", priority: 3 })], true, "page-2")
        : response([issue({ id: "urgent", identifier: "JOB-2", priority: 1 })]);
    },
  });
  assert.equal(candidate?.id, "urgent");
  assert.deepEqual(requests.map((r) => r.variables.after), [null, "page-2"]);
  assert.ok(requests.every((r) => r.query.startsWith("query ") && !r.query.includes("mutation")));
});

test("incomplete or invalid queue reads throw instead of asserting the queue is empty", async () => {
  const inputs: Array<() => Promise<Response>> = [
    async () => new Response("{}", { status: 503 }),
    async () => new Response(JSON.stringify({ errors: [{ message: "denied" }] })),
    async () => new Response(JSON.stringify({ data: { issues: { nodes: [] } } })),
    async () => response([issue()], true, null),
    async () => response([issue()], true, "same-cursor"),
  ];
  for (const fetchImpl of inputs) {
    await assert.rejects(readCandidate({ key: "test", team: "JobLander", staleClaimBefore: CUTOFF, fetchImpl }));
  }
});

test("a confirmed queue containing only protected tickets produces no candidate", async () => {
  assert.equal(await readCandidate({ key: "test", team: "JobLander", staleClaimBefore: CUTOFF,
    fetchImpl: async () => response([issue({ state: { name: "In Progress" } })]),
  }), null);
});


test("the full dry-run prompt ends with the read-only override and suppresses queue claim commands", () => {
  const input = { systemPrompt: "Constitution", freshnessPolicy: "Freshness", changeFeedPolicy: "Changes",
    staleClaimMinutes: 30, candidate: selectCandidate([issue()], CUTOFF)!, dryRunBanner: "READ ONLY BANNER" };
  const dry = buildDispatchPrompt({ ...input, dryRun: true });
  assert.doesNotMatch(dry, /Claim once: set In Progress|Re-read the candidate and claim it once|yours to reclaim/);
  assert.match(dry, /WOULD claim/);
  assert.ok(dry.indexOf("READ ONLY BANNER") > dry.indexOf("SELECTED CANDIDATE"));
  assert.ok(dry.endsWith("This overrides every mutation instruction above."));
  const live = buildDispatchPrompt({ ...input, dryRun: false, dryRunBanner: "" });
  assert.match(live, /Claim once: set In Progress/);
  assert.doesNotMatch(live, /FINAL DRY_RUN OVERRIDE/);
});


test("hard seven-day boundary is inclusive and rejects old, future and malformed dates", () => {
  const exact = new Date(NOW - MAX_ISSUE_AGE_MS).toISOString();
  assert.equal(isRecentIssue(exact), true);
  assert.equal(isRecentIssue(new Date(NOW).toISOString()), true);
  for (const createdAt of [new Date(NOW - MAX_ISSUE_AGE_MS - 1).toISOString(),
    new Date(NOW + 1).toISOString(), "invalid", "2026-09-08", "2026-02-30T00:00:00Z", undefined]) {
    assert.equal(isRecentIssue(createdAt), false, String(createdAt));
  }
  const filter = buildQueueFilter("JobLander", CUTOFF) as { createdAt: object };
  assert.deepEqual(filter.createdAt, { gte: exact, lte: new Date(NOW).toISOString() });
});

test("old high-priority and stale active claims cannot starve recent issues or use updatedAt for age", () => {
  const old = issue({ id: "old", priority: 1, createdAt: "2026-04-01T00:00:00Z", updatedAt: new Date(NOW).toISOString() });
  const active = { ...old, state: { name: "In Progress" }, updatedAt: "2026-09-09T10:00:00Z", labels: { nodes: [{ name: "agent-claimed" }] } };
  assert.equal(selectCandidate([old, active], CUTOFF), null);
  assert.equal(selectCandidate([old, active, issue({ id: "recent", priority: 4 })], CUTOFF)?.id, "recent");
});

test("candidate that ages beyond the limit while awaiting Linear is discarded locally", async () => {
  const createdAt = new Date(NOW - MAX_ISSUE_AGE_MS).toISOString();
  const candidate = await readCandidate({ key: "test", team: "JobLander", staleClaimBefore: CUTOFF,
    fetchImpl: async () => {
      mock.method(Date, "now", () => NOW + 1);
      return response([issue({ createdAt })]);
    },
  });
  assert.equal(candidate, null);
});

test("prompt forbids missing-candidate discovery and every old-ticket exception", () => {
  assert.match(candidateInstruction(), /STOP without discovery/);
  assert.match(queuePolicy(30), /Older tickets are forbidden regardless of priority, updatedAt, active state, stale claim, manual trigger, or provider retry/);
  assert.match(queuePolicy(30), /createdAt only, never updatedAt/);
});
