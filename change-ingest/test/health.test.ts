import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../src/store";
import { PollController } from "../src/poll";
import { createApp } from "../src/routes";
import { pull as github } from "../src/ingest/github";
import { pull as linear } from "../src/ingest/linear";
import { pull as audit } from "../src/ingest/gcpAudit";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "change-health-"));
  const store = new ChangeStore(path.join(dir, "changes.db"));
  return { dir, store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("startup, failed source, success, stale and restart are distinguishable", async () => {
  const { store, cleanup } = setup();
  let now = 1_700_000_000_000;
  const polls = new PollController(store, () => now, 900_000);
  try {
    assert.equal(polls.health().ok, false);
    const success = async () => ({ changes: [], nextCursor: now });
    await polls.run({ source: "github", puller: success });
    await polls.run({ source: "linear", puller: success });
    await polls.run({ source: "gcp_audit", puller: async ({ since }) => ({ changes: [], nextCursor: since, error: "permission denied" }) });
    assert.equal(polls.health().ok, false);
    assert.equal(polls.health().lastPollBySource.gcp_audit.error, "permission denied");
    assert.equal(store.getCursor("gcp_audit"), null);
    await polls.run({ source: "gcp_audit", puller: success });
    assert.equal(polls.health().ok, true);
    now += 901_000;
    assert.equal(polls.health().ok, false);
    assert.equal(polls.health().lastPollBySource.github.stale, true);
    await polls.run({ source: "github", puller: async () => { throw new Error("token expired"); } });
    assert.equal(polls.health().lastPollBySource.github.lastSuccess, new Date(now - 901_000).toISOString());
    assert.equal(new PollController(store).health().ok, false, "stored cursor alone cannot prove credentials still work after restart");
  } finally { cleanup(); }
});

test("partial backfill can advance safely while remaining unready; failed poll cannot advance", async () => {
  const { store, cleanup } = setup();
  try {
    store.setCursor("gcp_audit", "100");
    const polls = new PollController(store);
    await polls.run({ source: "gcp_audit", puller: async () => ({ changes: [], nextCursor: 200, incomplete: true }) });
    assert.equal(store.getCursor("gcp_audit"), "200");
    assert.equal(polls.health().ok, false);
    await polls.run({ source: "gcp_audit", puller: async () => ({ changes: [], nextCursor: 300, error: "truncated" }) });
    assert.equal(store.getCursor("gcp_audit"), "200");
  } finally { cleanup(); }
});

test("unready and stale feeds return 503 instead of a misleading successful empty array", async () => {
  const { store, cleanup } = setup();
  let now = Date.now();
  const polls = new PollController(store, () => now, 60_000);
  const server = createApp({ store, health: polls.health }).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (route: string) => fetch(`http://127.0.0.1:${port}${route}`);
  try {
    assert.equal((await get("/live")).status, 200);
    assert.equal((await get("/ready")).status, 503);
    assert.equal((await get("/changes?since=0")).status, 503);
    for (const source of ["github", "gcp_audit", "linear"]) await polls.run({ source, puller: async () => ({ changes: [], nextCursor: now }) });
    assert.equal((await get("/ready")).status, 200);
    assert.deepEqual(await (await get("/changes?since=0")).json(), []);
    now += 60_001;
    assert.equal((await get("/healthz")).status, 503);
    assert.equal((await get("/changes?since=0")).status, 503);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); cleanup(); }
});

test("real source adapters surface HTTP/GraphQL/gcloud errors without advancing coverage", async () => {
  const originalFetch = globalThis.fetch;
  const oldGh = process.env.GH_TOKEN, oldLinear = process.env.LINEAR_API_KEY, oldPath = process.env.PATH;
  const { dir, cleanup } = setup();
  process.env.GH_TOKEN = "test-only";
  process.env.LINEAR_API_KEY = "test-only";
  try {
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    const gh = await github({ since: 100 });
    assert.ok(gh.error);
    assert.equal(gh.nextCursor, 100);
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), { status: 200 });
    const li = await linear({ since: 100 });
    assert.ok(li.error);
    assert.equal(li.nextCursor, 100);
    fs.writeFileSync(path.join(dir, "gcloud"), "#!/bin/sh\nprintf 'malformed'\n", { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    const gcp = await audit({ since: 100 });
    assert.ok(gcp.error);
    assert.equal(gcp.nextCursor, 100);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["GH_TOKEN", oldGh], ["LINEAR_API_KEY", oldLinear], ["PATH", oldPath]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    cleanup();
  }
});
