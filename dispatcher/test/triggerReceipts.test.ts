import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TriggerReceipts } from "../src/triggerReceipts";

test("lost HTTP acknowledgement and restart do not repeat a completed trigger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-receipts-"));
  const file = path.join(dir, "receipts.json");
  let calls = 0;
  const poll = async () => { calls++; return { ran: true, note: "completed" }; };
  try {
    const first = new TriggerReceipts(file, poll);
    assert.equal(first.accept("output-watch:incident"), true);
    assert.equal(first.accept("output-watch:incident"), false);
    await Promise.all([first.drain(), first.drain()]);
    const restart = new TriggerReceipts(file, poll);
    assert.equal(restart.accept("output-watch:incident"), false);
    await restart.drain();
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("accepted-before-crash and paused/busy work survives and runs after restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-receipts-"));
  const file = path.join(dir, "receipts.json");
  try {
    const paused = new TriggerReceipts(file, async () => ({ ran: false, note: "paused 30m" }));
    paused.accept("incident");
    await paused.drain();
    let calls = 0;
    const restart = new TriggerReceipts(file, async () => { calls++; return { ran: true, note: "completed" }; });
    await restart.drain();
    await restart.drain();
    assert.equal(calls, 1);
    fs.writeFileSync(file, "{corrupt");
    assert.throws(() => restart.accept("another"));
    assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a trigger received while a run is active remains pending for the next scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-receipts-"));
  try {
    let finish!: () => void;
    let calls = 0;
    const receipts = new TriggerReceipts(path.join(dir, "r.json"), async () => {
      calls++;
      if (calls === 1) await new Promise<void>(resolve => { finish = resolve; });
      return { ran: true, note: "completed" };
    });
    receipts.accept("first");
    const drain = receipts.drain();
    receipts.accept("second");
    finish();
    await drain;
    await receipts.drain();
    assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one run consumes only one accumulated wakeup and the other survives restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-receipts-"));
  const file = path.join(dir, "receipts.json");
  let calls = 0;
  const poll = async () => { calls++; return { ran: true, note: "completed" }; };
  try {
    const receipts = new TriggerReceipts(file, poll);
    receipts.accept("first");
    receipts.accept("second");
    await receipts.drain();
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.first.done, true);
    assert.equal(stored.second.done, false);
    const restart = new TriggerReceipts(file, poll);
    assert.equal(restart.accept("second"), false);
    await restart.drain();
    await restart.drain();
    assert.equal(calls, 2);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).second.done, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("confirmed empty queue consumes accumulated wakeups but preserves new arrivals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-receipts-"));
  const file = path.join(dir, "receipts.json");
  try {
    let finish!: () => void;
    const receipts = new TriggerReceipts(file, async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { ran: false, note: "precheck-skip" };
    });
    receipts.accept("first");
    receipts.accept("second");
    const drain = receipts.drain();
    receipts.accept("third");
    finish();
    await drain;
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.first.done, true);
    assert.equal(stored.second.done, true);
    assert.equal(stored.third.done, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
