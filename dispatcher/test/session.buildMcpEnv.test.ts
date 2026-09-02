// Regression test for JOB-916: the per-server MCP env builders must use an
// allowlist, never copy process.env wholesale, and must NOT include any
// credentials in the environment passed to MCP child processes.
//
// The old buildMcpEnv() iterated over all of process.env and serialised
// every key into the --mcp-config argv passed to the claude child process.
// Because argv is world-readable via `ps` or /proc/<pid>/cmdline, this leaked
// at minimum: CLAUDE_CODE_OAUTH_TOKEN, TG_BOT_TOKEN, TRIGGER_TOKEN,
// and LINEAR_API_KEY to any user on the machine.
//
// The fix:
//   1. Three per-server allowlist builders — no credentials forwarded.
//   2. firebase MCP uses ADC (applicationDefault()) when GCP_PRIVATE_KEY_BASE_64
//      is absent — as is always the case on the self-healing VM.
//   3. sentry MCP already fetched SENTRY_TOKEN itself from Secret Manager.
//   4. linear MCP now fetches LINEAR_API_KEY itself from Secret Manager
//      (mcp/linear/tools.js gcloud fallback added in this PR).
//
// Result: `ps -eo args | grep mcp-config` contains no credentials.

import { strict as assert } from "node:assert";
import { test } from "node:test";

// Set required config env vars before importing the module so that
// config.ts can initialise without throwing or hitting Secret Manager.
process.env.GCP_PROJECT = "test-project-id";
process.env.GCP_PROJECT_ID = "test-project-id";
process.env.LINEAR_TEAM = "JobLander";
process.env.LOG_DIR = "/tmp";

import { buildFirebaseMcpEnv, buildSentryMcpEnv, buildLinearMcpEnv } from "../src/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Secrets that belong only to the dispatcher process, never to MCP children. */
const DISPATCHER_ONLY_SECRETS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "TG_BOT_TOKEN",
  "TRIGGER_TOKEN",
];

/** Dispatcher-internal knobs that MCP children have no use for. */
const DISPATCHER_ONLY_INTERNALS = [
  "HTTP_PORT",
  "POLL_CRON",
  "DRY_RUN",
  "LOG_DIR",
  "MAX_RUN_MS",
  "STALE_CLAIM_MINUTES",
];

/**
 * Credentials that USED to leak via the old buildMcpEnv() and must now be
 * absent from all builder outputs (each MCP child fetches its own credential
 * from Secret Manager on first use).
 */
const CREDENTIALS_THAT_MUST_NOT_LEAK = [
  "LINEAR_API_KEY",
  "SENTRY_TOKEN",
  "GCP_PRIVATE_KEY_BASE_64",
  "GCP_CLIENT_EMAIL",
];

/**
 * Temporarily inject poison env vars, call fn(), then restore the originals.
 */
function withPoisonEnv<T>(extra: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(extra)) {
    saved[k] = process.env[k];
    process.env[k] = extra[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Full poison set: everything a dispatcher process might carry. */
const POISON: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-dispatcher-token",
  TG_BOT_TOKEN: "9999999:AAFakeToken",
  TRIGGER_TOKEN: "fake-trigger",
  HTTP_PORT: "4100",
  POLL_CRON: "*/10 * * * *",
  DRY_RUN: "false",
  MAX_RUN_MS: "2400000",
  STALE_CLAIM_MINUTES: "30",
  // Credentials that must also be absent even when present in parent env
  LINEAR_API_KEY: "lin_api_leaked",
  SENTRY_TOKEN: "sntryu_leaked",
  GCP_PRIVATE_KEY_BASE_64: "ZmFrZWtleQ==",
  GCP_CLIENT_EMAIL: "svc@project.iam.gserviceaccount.com",
};

function assertNoLeaks(env: Record<string, string>, label: string): void {
  for (const secret of DISPATCHER_ONLY_SECRETS) {
    assert.ok(
      !Object.hasOwn(env, secret),
      `${label}: must NOT include dispatcher secret ${secret}`,
    );
  }
  for (const internal of DISPATCHER_ONLY_INTERNALS) {
    assert.ok(
      !Object.hasOwn(env, internal),
      `${label}: must NOT include dispatcher-internal var ${internal}`,
    );
  }
  for (const cred of CREDENTIALS_THAT_MUST_NOT_LEAK) {
    assert.ok(
      !Object.hasOwn(env, cred),
      `${label}: credential ${cred} must NOT be forwarded — MCP child fetches it from Secret Manager`,
    );
  }
}

function assertHasBase(env: Record<string, string>, label: string): void {
  assert.ok(env.PATH, `${label}: PATH must be present`);
  assert.ok(env.HOME, `${label}: HOME must be present`);
  assert.ok(env.GCP_PROJECT_ID, `${label}: GCP_PROJECT_ID must be present`);
}

// ---------------------------------------------------------------------------
// Tests — secret isolation (core security property)
// ---------------------------------------------------------------------------

test("buildFirebaseMcpEnv does not forward any credentials or dispatcher secrets", () => {
  const env = withPoisonEnv(POISON, () => buildFirebaseMcpEnv());
  assertNoLeaks(env, "buildFirebaseMcpEnv");
  assertHasBase(env, "buildFirebaseMcpEnv");
});

test("buildSentryMcpEnv does not forward any credentials or dispatcher secrets", () => {
  const env = withPoisonEnv(POISON, () => buildSentryMcpEnv());
  assertNoLeaks(env, "buildSentryMcpEnv");
  assertHasBase(env, "buildSentryMcpEnv");
});

test("buildLinearMcpEnv does not forward any credentials or dispatcher secrets", () => {
  const env = withPoisonEnv(POISON, () => buildLinearMcpEnv());
  assertNoLeaks(env, "buildLinearMcpEnv");
  assertHasBase(env, "buildLinearMcpEnv");
});

// ---------------------------------------------------------------------------
// Tests — all three builders are equivalent (same base env)
// ---------------------------------------------------------------------------

test("all three builders produce the same base env (no per-server extras)", () => {
  // Since all three builders now return baseMcpEnv() with no additions,
  // their outputs must be identical given the same process.env.
  const firebase = withPoisonEnv(POISON, () => buildFirebaseMcpEnv());
  const sentry = withPoisonEnv(POISON, () => buildSentryMcpEnv());
  const linear = withPoisonEnv(POISON, () => buildLinearMcpEnv());
  assert.deepEqual(firebase, sentry, "firebase and sentry envs must be equal");
  assert.deepEqual(firebase, linear, "firebase and linear envs must be equal");
});

// ---------------------------------------------------------------------------
// Tests — required base vars
// ---------------------------------------------------------------------------

test("GCP_PROJECT_ID is always set (even when absent from process.env)", () => {
  // The baseMcpEnv() fallback must fill in config.gcpProject.
  const saved = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID;
  try {
    const env = buildFirebaseMcpEnv();
    assert.ok(env.GCP_PROJECT_ID, "GCP_PROJECT_ID must be set from config.gcpProject fallback");
  } finally {
    if (saved !== undefined) process.env.GCP_PROJECT_ID = saved;
  }
});

test("GOOGLE_* ADC vars are forwarded by all builders", () => {
  const extra = { ...POISON, GOOGLE_APPLICATION_CREDENTIALS: "/run/sa/key.json" };
  const firebase = withPoisonEnv(extra, () => buildFirebaseMcpEnv());
  const sentry = withPoisonEnv(extra, () => buildSentryMcpEnv());
  const linear = withPoisonEnv(extra, () => buildLinearMcpEnv());
  for (const [label, env] of [["firebase", firebase], ["sentry", sentry], ["linear", linear]] as const) {
    assert.equal(
      (env as Record<string, string>).GOOGLE_APPLICATION_CREDENTIALS,
      "/run/sa/key.json",
      `${label}: GOOGLE_APPLICATION_CREDENTIALS must be forwarded for ADC`,
    );
  }
});
