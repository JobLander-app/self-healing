import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";
import type { ProviderAttempt } from "../src/providerTypes";
import type { RunSummary } from "../src/trace";

process.env.LOG_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shl-coverage-")), "turns");
const at = new Date().toISOString();
const metricsInput = { busy: false, lastRun: null, lastHealthcheck: null, lastPrecheck: null };
const attempt = (id: string): ProviderAttempt => ({ id, provider: "codex", model: "coverage", startedAt: at, finishedAt: at, status: "completed", usage: { input: 10, cachedInput: null, cacheWrite: 0, output: 2 }, estimatedCostUsd: null, costSource: "unavailable", turns: 1 });
const run = (turnId: string): RunSummary => ({ turnId, startedAt: at, finishedAt: at, durationSec: 1, outcome: "fixed", costUsd: null, numTurns: 1, dryRun: true, summary: "test" });

test("status retains known Claude estimate from a mixed run and legacy estimates without claiming total cost", async () => {
  const { recordRun, hydrateFromDisk } = await import("../src/trace");
  const { statusRouter, knownEstimatedCost } = await import("../src/routes/status");
  hydrateFromDisk();
  const mixed: RunSummary = { ...run("mixed"), attempts: [{ ...attempt("claude"), provider: "claude", status: "failed", failureKind: "quota", estimatedCostUsd: 0.32, costSource: "claude-sdk-estimate" }, attempt("codex")] };
  assert.equal(knownEstimatedCost(mixed), 0.32);
  assert.equal(knownEstimatedCost({ ...run("legacy"), costUsd: 1.25 }), 1.25);
  assert.equal(knownEstimatedCost({ ...run("zero"), attempts: [{ ...attempt("zero"), estimatedCostUsd: 0 }] }), 0);
  recordRun(mixed); recordRun({ ...run("legacy"), costUsd: 1.25 });
  const app = express(); app.use(statusRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/status`);
    const body = await response.json() as any;
    assert.equal(body.recentKnownEstimatedCostUsd, 1.57);
    assert.equal(body.recentCostUsd, null);
    assert.equal(body.recentUnknownCostRuns, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("per-field coverage distinguishes unknown, measured zero and partial known totals through replay", async () => {
  const { recordAttempt, hydrateFromDisk } = await import("../src/trace");
  const { renderMetrics } = await import("../src/metrics");
  const tokens = 'selfheal_dispatcher_provider_tokens_total{provider="codex",model="coverage",kind="cachedInput"}';
  const coverage = 'selfheal_dispatcher_provider_token_reports_total{provider="codex",model="coverage",kind="cachedInput",coverage=';
  recordAttempt("missing", attempt("missing"));
  let text = renderMetrics(metricsInput);
  assert.ok(!text.includes(tokens));
  assert.ok(text.includes(`${coverage}"unreported"} 1`));
  assert.ok(text.includes('selfheal_dispatcher_provider_usage_unknown_total{provider="codex",model="coverage"} 1'));
  recordAttempt("zero", { ...attempt("zero"), usage: { input: 10, cachedInput: 0, cacheWrite: 0, output: 2 } });
  text = renderMetrics(metricsInput);
  assert.ok(text.includes(`${tokens} 0`));
  assert.ok(text.includes(`${coverage}"reported"} 1`));
  recordAttempt("known", { ...attempt("known"), usage: { input: 10, cachedInput: 5, cacheWrite: 0, output: 2 } });
  text = renderMetrics(metricsInput);
  assert.ok(text.includes(`${tokens} 5`));
  assert.ok(text.includes(`${coverage}"reported"} 2`));
  assert.ok(text.includes(`${coverage}"unreported"} 1`));
  recordAttempt("submodel", { ...attempt("submodel"), model: "parent", usage: { input: 10, cachedInput: 5, cacheWrite: 0, output: 2 }, models: [{ model: "child", usage: { input: 10, cachedInput: 5, cacheWrite: null, output: 2 } }] });
  text = renderMetrics(metricsInput);
  assert.ok(text.includes('selfheal_dispatcher_provider_usage_unknown_total{provider="codex",model="parent"} 1'));
  assert.ok(!text.includes('selfheal_dispatcher_provider_tokens_total{provider="codex",model="child",kind="cacheWrite"}'));
  hydrateFromDisk(); hydrateFromDisk();
  assert.equal(renderMetrics(metricsInput), text);
});
