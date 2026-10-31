import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { MonitorIngress, MonitorWakeups, monitorRouter, parseWakeup, validIdentity } from "../src/monitorWebhook";

const options: MonitorIngress = { audience: "https://example.com/monitor/alerts",
  email: "push@example-project.iam.gserviceaccount.com", project: "example-project",
  subscription: "projects/example-project/subscriptions/errors", stateFile: "unused" };
const identity = { aud: options.audience, email: options.email, email_verified: true,
  iss: "https://accounts.google.com", sub: "123", iat: 1, exp: 2 };
const envelope = (value: unknown, id = "123") => ({ subscription: options.subscription,
  message: { messageId: id, data: Buffer.from(JSON.stringify(value)).toString("base64") } });
const incident = { incident: { scoping_project_id: options.project, state: "open" } };

test("signed identities still require the exact audience and verified push service account", () => {
  assert.ok(validIdentity(identity, options));
  for (const change of [{ aud: "other" }, { email: "other@example.com" }, { email_verified: false }, { iss: "evil" }]) {
    assert.equal(validIdentity({ ...identity, ...change }, options), false);
  }
});

test("only this subscription/project can wake the monitor; closed incidents do nothing", () => {
  assert.equal(parseWakeup(envelope(incident), options), "123");
  assert.equal(parseWakeup(envelope({ incident: { ...incident.incident, state: "closed" } }), options), null);
  assert.equal(parseWakeup(envelope({ kind: "monitor-wakeup", project: options.project }), options), "123");
  assert.throws(() => parseWakeup({ ...envelope(incident), subscription: "other" }, options));
  assert.throws(() => parseWakeup(envelope({ incident: { ...incident.incident, scoping_project_id: "other" } }), options));
  assert.throws(() => parseWakeup(envelope({ command: "rm -rf /" }), options));
  const entry = { logName: `projects/${options.project}/logs/run.googleapis.com%2Fstderr`,
    resource: { type: "cloud_run_revision", labels: { project_id: options.project } },
    textPayload: "large error ".repeat(20_000) };
  assert.equal(parseWakeup(envelope(entry), options), "123");
  assert.throws(() => parseWakeup(envelope({ ...entry, logName: "projects/other/logs/errors" }), options));
});

test("wake-ups survive restart, coalesce a burst and re-read after the window matures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-queue-"));
  try {
    let now = 1_000, runs = 0;
    const file = join(dir, "state.json");
    let q = new MonitorWakeups(file, async () => { runs++; return 0; }, () => now);
    assert.ok(q.accept("1"));
    for (let n = 2; n < 100; n++) q.accept(String(n));
    assert.equal(q.accept("1"), false);
    q = new MonitorWakeups(file, async () => { runs++; return 0; }, () => now);
    assert.equal(q.accept("1"), false);
    await q.tick(); assert.equal(runs, 0);
    now += 10_000; await q.tick(); assert.equal(runs, 1);
    assert.equal(q.status().pending, true);
    now += 300_000; await q.tick(); assert.equal(runs, 2);
    assert.equal(q.status().pending, false);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).lastExitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a cron lock collision and run failure remain queued; arrivals during a run are not lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-retry-"));
  try {
    let now = 0, code = 75, runs = 0;
    let finish: ((code: number) => void) | undefined;
    const q = new MonitorWakeups(join(dir, "state.json"), async () => {
      runs++;
      if (code === -1) return new Promise<number>(resolve => { finish = resolve; });
      return code;
    }, () => now);
    q.accept("1"); now = 10_000; await q.tick();
    assert.equal(q.status().dueAt, now + 30_000);
    assert.equal(q.status().pending, true);
    now += 30_000; code = 1; await q.tick();
    assert.equal(q.status().pending, true);
    now += 300_000; code = -1;
    const running = q.tick();
    await q.tick(); assert.equal(runs, 3);
    q.accept("2"); finish!(0); await running;
    assert.equal(q.status().pending, true);
    assert.equal(q.status().followUp, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt durable state is not silently reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-corrupt-"));
  try {
    const file = join(dir, "state.json"); writeFileSync(file, '{"version":1}');
    assert.throws(() => new MonitorWakeups(file, async () => 0), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP rejects unauthenticated/wrong identities, and only acknowledges durable acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monitor-http-"));
  const q = new MonitorWakeups(join(dir, "state.json"), async () => 0);
  const app = express();
  app.use("/", monitorRouter(options, q, async token => {
    if (token === "invalid") throw new Error("invalid signature");
    return token === "valid" ? identity : { ...identity, email: "someone-else@example.com" };
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const post = (token?: string) => fetch(`http://127.0.0.1:${address.port}/`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(envelope(incident)),
  });
  try {
    assert.equal((await post()).status, 401);
    assert.equal((await post("invalid")).status, 401);
    assert.equal((await post("other")).status, 403);
    assert.equal(q.status().pending, false);
    assert.equal((await post("valid")).status, 204);
    assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).pending, true);
    assert.equal((await post("valid")).status, 204);
    assert.equal(q.status().generation, 1);
    const largeEntry = envelope({ logName: `projects/${options.project}/logs/errors`,
      resource: { type: "cloud_run_revision", labels: { project_id: options.project } },
      textPayload: "e".repeat(200_000) }, "124");
    const largeResponse = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid" }, body: JSON.stringify(largeEntry) });
    assert.equal(largeResponse.status, 204);
    assert.equal(q.status().generation, 2);
    q.accept = () => { throw new Error("disk full"); };
    assert.equal((await post("valid")).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
