// Regression test for JOB-916: the per-server MCP env builders must use an
// allowlist, never copy process.env wholesale.
//
// The old buildMcpEnv() iterated over all of process.env and serialised
// every key into the --mcp-config argv. Because the SDK passes mcpServers as
// --mcp-config, every key became visible to any user on the machine via
//   ps -eo args | grep mcp-config
// or /proc/<pid>/cmdline. That leaked at minimum:
//   CLAUDE_CODE_OAUTH_TOKEN, TG_BOT_TOKEN, TRIGGER_TOKEN, LINEAR_API_KEY.
//
// The fix splits the single buildMcpEnv() into three per-server allowlist
// builders. Each exports only what its MCP child process actually reads.
// These tests verify the builders (a) exclude dispatcher-only secrets and
// (b) include the vars each server needs.

import { strict as assert } from "node:assert";
import { test } from "node:test";

// Set required config env vars before importing the module so that
// config.ts can initialise without throwing or hitting Secret Manager.
process.env.GCP_PROJECT = "test-project-id";
process.env.GCP_PROJECT_ID = "test-project-id";
process.env.LINEAR_TEAM = "JobLander";
process.env.LOG_DIR = "/tmp";
process.env.LINEAR_API_KEY = "lin_api_testonly"; // avoids Secret Manager call

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
 * Temporarily inject poison env vars, call fn(), then restore the originals.
 * Returns the result of fn().
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

const POISON: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-dispatcher-token",
  TG_BOT_TOKEN: "9999999:AAFakeToken",
  TRIGGER_TOKEN: "fake-trigger",
  HTTP_PORT: "4100",
  POLL_CRON: "*/10 * * * *",
  DRY_RUN: "false",
  MAX_RUN_MS: "2400000",
  STALE_CLAIM_MINUTES: "30",
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
}

function assertHasBase(env: Record<string, string>, label: string): void {
  assert.ok(env.PATH, `${label}: PATH must be present`);
  assert.ok(env.HOME, `${label}: HOME must be present`);
  assert.ok(env.GCP_PROJECT_ID, `${label}: GCP_PROJECT_ID must be present`);
}

// ---------------------------------------------------------------------------
// Tests — secret isolation (core security property)
// ---------------------------------------------------------------------------

test("buildFirebaseMcpEnv does not leak dispatcher secrets into MCP argv", () => {
  const env = withPoisonEnv(POISON, () => buildFirebaseMcpEnv());
  assertNoLeaks(env, "buildFirebaseMcpEnv");
  assertHasBase(env, "buildFirebaseMcpEnv");
});

test("buildSentryMcpEnv does not leak dispatcher secrets into MCP argv", () => {
  const env = withPoisonEnv(POISON, () => buildSentryMcpEnv());
  assertNoLeaks(env, "buildSentryMcpEnv");
  assertHasBase(env, "buildSentryMcpEnv");
});

test("buildLinearMcpEnv does not leak dispatcher secrets into MCP argv", () => {
  const env = withPoisonEnv(POISON, () => buildLinearMcpEnv("lin_api_safe"));
  assertNoLeaks(env, "buildLinearMcpEnv");
  assertHasBase(env, "buildLinearMcpEnv");
  // The key it carries is the Linear key, not the Claude token
  assert.equal(env.LINEAR_API_KEY, "lin_api_safe");
  assert.ok(!Object.hasOwn(env, "CLAUDE_CODE_OAUTH_TOKEN"));
});

// ---------------------------------------------------------------------------
// Tests — each server gets exactly the vars it needs
// ---------------------------------------------------------------------------

test("buildFirebaseMcpEnv forwards GCP cert vars when present", () => {
  const env = withPoisonEnv(
    {
      ...POISON,
      GCP_PRIVATE_KEY_BASE_64: "ZmFrZWtleQ==",
      GCP_CLIENT_EMAIL: "svc@project.iam.gserviceaccount.com",
    },
    () => buildFirebaseMcpEnv(),
  );
  assert.equal(env.GCP_PRIVATE_KEY_BASE_64, "ZmFrZWtleQ==");
  assert.equal(env.GCP_CLIENT_EMAIL, "svc@project.iam.gserviceaccount.com");
});

test("buildFirebaseMcpEnv omits cert vars when absent", () => {
  const env = withPoisonEnv(POISON, () => buildFirebaseMcpEnv());
  assert.ok(!Object.hasOwn(env, "GCP_PRIVATE_KEY_BASE_64"));
  assert.ok(!Object.hasOwn(env, "GCP_CLIENT_EMAIL"));
});

test("buildSentryMcpEnv forwards SENTRY_TOKEN when present", () => {
  const env = withPoisonEnv(
    { ...POISON, SENTRY_TOKEN: "sntryu_realtoken" },
    () => buildSentryMcpEnv(),
  );
  assert.equal(env.SENTRY_TOKEN, "sntryu_realtoken");
});

test("buildSentryMcpEnv omits SENTRY_TOKEN key when absent (falls back to Secret Manager)", () => {
  const env = withPoisonEnv(POISON, () => buildSentryMcpEnv());
  assert.ok(
    !Object.hasOwn(env, "SENTRY_TOKEN"),
    "SENTRY_TOKEN should be absent so the server falls back to gcloud Secret Manager",
  );
});

test("buildLinearMcpEnv uses the resolvedKey parameter, not process.env raw value", () => {
  // Even if an unrelated LINEAR_API_KEY appears in env, the explicit param wins.
  const env = withPoisonEnv(
    { ...POISON, LINEAR_API_KEY: "process-env-key" },
    () => buildLinearMcpEnv("param-wins"),
  );
  assert.equal(env.LINEAR_API_KEY, "param-wins");
});

test("buildLinearMcpEnv falls back to process.env.LINEAR_API_KEY when resolvedKey is empty", () => {
  const env = withPoisonEnv(
    { ...POISON, LINEAR_API_KEY: "fallback-key" },
    () => buildLinearMcpEnv(""),
  );
  assert.equal(env.LINEAR_API_KEY, "fallback-key");
});

test("GOOGLE_* ADC vars are forwarded by all builders", () => {
  const extra = { ...POISON, GOOGLE_APPLICATION_CREDENTIALS: "/run/sa/key.json" };
  const firebase = withPoisonEnv(extra, () => buildFirebaseMcpEnv());
  const sentry = withPoisonEnv(extra, () => buildSentryMcpEnv());
  const linear = withPoisonEnv(extra, () => buildLinearMcpEnv("key"));
  for (const [label, env] of [["firebase", firebase], ["sentry", sentry], ["linear", linear]] as const) {
    assert.equal(
      (env as Record<string, string>).GOOGLE_APPLICATION_CREDENTIALS,
      "/run/sa/key.json",
      `${label}: GOOGLE_APPLICATION_CREDENTIALS must be forwarded for ADC`,
    );
  }
});
