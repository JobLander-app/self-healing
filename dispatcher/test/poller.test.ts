// Regression test for JOB-915: the pre-check filter must accept tickets that
// carry the `[Monitor]` title prefix but NOT the `monitor` label, as well as
// the normal label-only path. Before this fix, only the label was checked, so
// tickets filed by a human (or external tool) without the label were silently
// ignored — precheckCandidates() returned "skip" and no session was spawned.
//
// We test the pure filter-builder (`buildPrecheckFilter`) rather than the full
// network call, so no mocking of `fetch` is required.
import { strict as assert } from "node:assert";
import { test } from "node:test";

// Set required env vars before importing config-dependent modules.
process.env.LINEAR_TEAM = "JobLander";
process.env.GCP_PROJECT = "meet-assistant-6d8ad";
process.env.LINEAR_API_KEY = "test-key"; // avoids Secret Manager call
process.env.LOG_DIR = "/tmp";

// buildPrecheckFilter is exported specifically so this test can inspect the
// shape without mocking the Linear API or the Secret Manager.
import { buildPrecheckFilter } from "../src/poller";

const STALE = "2026-01-01T00:00:00.000Z";

test("filter accepts tickets by monitor label (existing behaviour)", () => {
  const filter = buildPrecheckFilter(STALE) as Record<string, unknown>;
  const andClauses = filter["and"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(andClauses), "top-level `and` must be an array");

  // First AND clause: label OR title gate
  const labelOrTitle = andClauses[0] as { or: unknown[] };
  const orItems = labelOrTitle.or as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(orItems), "label/title `or` must be an array");

  const labelBranch = orItems.find(
    (o) =>
      o["labels"] !== undefined &&
      (o["labels"] as { name: { eq: string } }).name.eq === "monitor",
  );
  assert.ok(labelBranch, "filter must include a branch matching label name 'monitor'");
});

test("filter accepts tickets by [Monitor] title prefix (JOB-915 regression)", () => {
  const filter = buildPrecheckFilter(STALE) as Record<string, unknown>;
  const andClauses = filter["and"] as Array<Record<string, unknown>>;
  const labelOrTitle = andClauses[0] as { or: unknown[] };
  const orItems = labelOrTitle.or as Array<Record<string, unknown>>;

  const titleBranch = orItems.find(
    (o) =>
      o["title"] !== undefined &&
      (o["title"] as { startsWith: string }).startsWith === "[Monitor]",
  );
  assert.ok(
    titleBranch,
    "filter must include a branch matching title startsWith '[Monitor]' — " +
      "tickets filed with the prefix but without the label were silently dropped before this fix",
  );
});

test("filter gates on To Do / Backlog states", () => {
  const filter = buildPrecheckFilter(STALE) as Record<string, unknown>;
  const andClauses = filter["and"] as Array<Record<string, unknown>>;
  const stateGate = andClauses[1] as { or: unknown[] };
  const orItems = stateGate.or as Array<Record<string, unknown>>;

  const normalStateBranch = orItems.find(
    (o) =>
      o["state"] !== undefined &&
      Array.isArray((o["state"] as { name: { in: string[] } }).name.in) &&
      (o["state"] as { name: { in: string[] } }).name.in.includes("To Do") &&
      (o["state"] as { name: { in: string[] } }).name.in.includes("Backlog"),
  );
  assert.ok(normalStateBranch, "filter must include To Do and Backlog states");
});

test("filter includes stale-claim In Progress branch", () => {
  const filter = buildPrecheckFilter(STALE) as Record<string, unknown>;
  const andClauses = filter["and"] as Array<Record<string, unknown>>;
  const stateGate = andClauses[1] as { or: unknown[] };
  const orItems = stateGate.or as Array<Record<string, unknown>>;

  const staleClaimBranch = orItems.find(
    (o) =>
      o["and"] !== undefined &&
      Array.isArray(o["and"]) &&
      (o["and"] as Array<Record<string, unknown>>).some(
        (sub) =>
          sub["state"] !== undefined &&
          (sub["state"] as { name: { eq: string } }).name.eq === "In Progress",
      ) &&
      (o["and"] as Array<Record<string, unknown>>).some(
        (sub) => sub["updatedAt"] !== undefined,
      ),
  );
  assert.ok(staleClaimBranch, "filter must include stale-claim In Progress branch");
});

test("stale claim cutoff timestamp is threaded through correctly", () => {
  const ts = "2099-12-31T23:59:59.000Z";
  const filter = buildPrecheckFilter(ts) as Record<string, unknown>;
  const andClauses = filter["and"] as Array<Record<string, unknown>>;
  const stateGate = andClauses[1] as { or: unknown[] };
  const orItems = stateGate.or as Array<Record<string, unknown>>;
  const staleClaimAnd = orItems.find((o) => Array.isArray(o["and"])) as { and: Array<Record<string, unknown>> };
  assert.ok(staleClaimAnd, "stale-claim branch must exist");
  const updatedAtFilter = staleClaimAnd.and.find((sub) => sub["updatedAt"] !== undefined) as
    | { updatedAt: { lt: string } }
    | undefined;
  assert.ok(updatedAtFilter, "stale-claim branch must contain updatedAt filter");
  assert.equal(updatedAtFilter.updatedAt.lt, ts, "staleClaimBefore must equal the argument passed in");
});
