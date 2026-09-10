import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import express from "express";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shl-accounting-"));
process.env.LOG_DIR = path.join(root, "turns");
process.env.LEDGER_MAX_BYTES = String(1024 * 1024);
const input = { busy: false, lastRun: null, lastHealthcheck: null, lastPrecheck: null };

test("storage outage keeps HTTP liveness, hides unknown totals, alerts and recovers preserved counters", async () => {
  const { hydrateFromDisk, recordAttempt, recordRun, recordAttemptStarted } = await import("../src/trace");
  const { accountingStatus, ledgerPath } = await import("../src/accountingState");
  const { renderMetrics } = await import("../src/metrics");
  const { alertAccounting, retryHealthAlerts } = await import("../src/healthAlerts");
  const { statusRouter } = await import("../src/routes/status");
  hydrateFromDisk();
  const at = new Date().toISOString();
  const attempt: import("../src/providerTypes").ProviderAttempt = { id: "durable", provider: "codex", model: "test", startedAt: at, finishedAt: at, status: "completed", usage: { input: 10, cachedInput: 8, cacheWrite: 0, output: 2 }, estimatedCostUsd: null, costSource: "unavailable", turns: 1 };
  recordAttempt("run", attempt);
  recordRun({ turnId: "run", startedAt: at, finishedAt: at, durationSec: 1, outcome: "fixed", attempts: [attempt], costUsd: null, numTurns: 1, dryRun: true, summary: "test" });
  const before = renderMetrics(input);
  fs.renameSync(ledgerPath, ledgerPath + ".preserved");
  fs.mkdirSync(ledgerPath);
  assert.doesNotThrow(hydrateFromDisk);
  assert.equal(accountingStatus().healthy, false);
  assert.doesNotMatch(renderMetrics(input), /^selfheal_dispatcher_runs_total/m);
  assert.throws(() => recordAttemptStarted("blocked", "codex", "test"), /Ledger/);
  const app = express(); app.use(statusRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(health.status, 200);
    const body = await health.json() as any;
    assert.equal(body.status, "ok"); assert.equal(body.accounting.healthy, false);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 503);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const messages: string[] = [];
  await alertAccounting(async s => { messages.push(s); return false; });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "health-alerts.json"), "utf8")).accounting.pending, true);
  await retryHealthAlerts(async s => { messages.push(s); return true; });
  fs.rmdirSync(ledgerPath);
  fs.renameSync(ledgerPath + ".preserved", ledgerPath);
  hydrateFromDisk(); hydrateFromDisk();
  assert.equal(accountingStatus().healthy, true);
  assert.equal(renderMetrics(input), before);
  await alertAccounting(async s => { messages.push(s); return true; });
  assert.match(messages[0], /unavailable/); assert.match(messages.at(-1)!, /recovered/);
});

test("ledger size cap bounds replay and writes without truncating preserved history", async () => {
  const { hydrateFromDisk, recordAttemptStarted } = await import("../src/trace");
  const { accountingStatus, ledgerPath } = await import("../src/accountingState");
  const { renderMetrics } = await import("../src/metrics");
  const original = fs.readFileSync(ledgerPath), before = renderMetrics(input);
  fs.truncateSync(ledgerPath, 1024 * 1024);
  assert.doesNotThrow(hydrateFromDisk);
  assert.equal(accountingStatus().healthy, false);
  assert.equal(accountingStatus().warning, true);
  assert.throws(() => recordAttemptStarted("cap", "codex", "test"), /size cap/);
  assert.equal(fs.statSync(ledgerPath).size, 1024 * 1024);
  fs.writeFileSync(ledgerPath, original); // restore test fixture, never a production repair procedure
  hydrateFromDisk();
  assert.equal(renderMetrics(input), before);
});

test("malformed journal records cannot poison the feed or hide rejected record counts", async () => {
  const { hydrateFromDisk, getRecentRuns, validAttempt } = await import("../src/trace");
  const { accountingStatus, ledgerPath } = await import("../src/accountingState");
  fs.appendFileSync(ledgerPath, JSON.stringify({ kind: "run", id: "bad", data: { turnId: "bad", outcome: "fixed" } }) + "\n");
  assert.doesNotThrow(hydrateFromDisk);
  assert.equal(getRecentRuns().length, 1);
  assert.equal(accountingStatus().rejectedRecords, 1);
  assert.equal(accountingStatus().warning, true);
  assert.equal(validAttempt({ id: "bad", provider: "codex", model: "m", startedAt: "now", usage: {} }), false);
});
