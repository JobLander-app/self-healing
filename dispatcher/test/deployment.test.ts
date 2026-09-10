import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollOnce } from "../src/poller";

test("deployment guard refuses cron and trigger before credentials/network/agent work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-guard-"));
  const old = process.env.DEPLOY_GUARD_FILE;
  process.env.DEPLOY_GUARD_FILE = path.join(dir, "guard");
  fs.writeFileSync(process.env.DEPLOY_GUARD_FILE, "release");
  try {
    assert.deepEqual(await pollOnce("trigger"), { ran: false, note: "deploying" });
    assert.deepEqual(await pollOnce("cron"), { ran: false, note: "deploying" });
  } finally {
    if (old === undefined) delete process.env.DEPLOY_GUARD_FILE; else process.env.DEPLOY_GUARD_FILE = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
