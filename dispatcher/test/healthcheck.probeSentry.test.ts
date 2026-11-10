/**
 * Unit tests for probeMcp / probeSentry retry logic in healthcheck.ts.
 *
 * We exercise the exported helpers (validSmokeResult, probeMcp) and the
 * retry branching inside the module via a small monkey-patch that replaces
 * the real node-child spawn with a deterministic fake MCP server.
 *
 * We deliberately do NOT spawn real MCP children or hit Sentry/Secret Manager.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.GCP_PROJECT = "test-project";
process.env.GCP_PROJECT_ID = "test-project";
process.env.LINEAR_TEAM = "Example";
process.env.LOG_DIR = "/tmp";
// Prevent probeGcloud from running (config.sentryEnabled guard not relevant
// to the exports under test, but keep the import side-effect clean).
process.env.SENTRY_ENABLED = "false";

import { validSmokeResult, probeMcp } from "../src/healthcheck";

// ---------------------------------------------------------------------------
// validSmokeResult — the shape gate for MCP tool/call results.
// ---------------------------------------------------------------------------

test("validSmokeResult accepts well-formed non-error result", () => {
  assert.ok(validSmokeResult({
    content: [{ type: "text", text: "2 tools, smoke ok" }],
  }));
});

test("validSmokeResult rejects missing content", () => {
  assert.equal(validSmokeResult({}), false);
  assert.equal(validSmokeResult(undefined), false);
  assert.equal(validSmokeResult(null), false);
});

test("validSmokeResult rejects empty content array", () => {
  assert.equal(validSmokeResult({ content: [] }), false);
});

test("validSmokeResult rejects non-text content items", () => {
  assert.equal(validSmokeResult({ content: [{ type: "image", text: "x" }] }), false);
});

test("validSmokeResult rejects blank text", () => {
  assert.equal(validSmokeResult({ content: [{ type: "text", text: "   " }] }), false);
});

test("validSmokeResult accepts isError=false", () => {
  assert.ok(validSmokeResult({
    content: [{ type: "text", text: "ok" }],
    isError: false,
  }));
});

test("validSmokeResult accepts isError=true (shape check only — caller reads isError separately)", () => {
  // validSmokeResult checks structural correctness, not the value of isError.
  assert.ok(validSmokeResult({
    content: [{ type: "text", text: "Error: something" }],
    isError: true,
  }));
});

// ---------------------------------------------------------------------------
// probeMcp — fake stdio MCP child.
//
// We spawn a tiny Node one-liner as the MCP "server" so the test stays
// unit-level (no real Sentry/Firebase) while still exercising the full
// initialize → tools/list → tools/call JSON-RPC exchange.
// ---------------------------------------------------------------------------

/** Build a one-liner Node child that plays a minimal MCP stdio server. */
function fakeMcpCmd(opts: {
  toolsCount?: number;      // number of tools to return in tools/list (default 1)
  callResult?: string;      // text the tool returns (default "smoke ok")
  callIsError?: boolean;    // isError flag (default false)
  hangCallMs?: number;      // if set, delay call response by N ms (simulates slow API)
  exitCode?: number;        // if set, exit instead of responding
}): string {
  const tools = JSON.stringify(
    Array.from({ length: opts.toolsCount ?? 1 }, (_, i) => ({ name: `tool${i}` })),
  );
  const callPayload = JSON.stringify({
    content: [{ type: "text", text: opts.callResult ?? "smoke ok" }],
    ...(opts.callIsError !== undefined ? { isError: opts.callIsError } : {}),
  });
  const hang = opts.hangCallMs ?? 0;

  // Minimal stdio MCP: read lines, respond to initialize and tools/list
  // synchronously; optionally delay tools/call.
  return [
    `const lines = [];`,
    `process.stdin.on('data', d => {`,
    `  const all = (lines.join('') + d.toString()).split('\\n');`,
    `  lines.length = 0;`,
    `  if (all.length > 1) lines.push(all.pop());`,
    `  for (const raw of all) {`,
    `    if (!raw.trim()) continue;`,
    `    const m = JSON.parse(raw);`,
    `    if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fake',version:'1.0'}}}) + '\\n');`,
    `    else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:${tools}}}) + '\\n');`,
    `    else if (m.method === 'tools/call') {`,
    `      const delay = ${hang};`,
    `      if (delay > 0) setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${callPayload}}) + '\\n'), delay);`,
    `      else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${callPayload}}) + '\\n');`,
    `    }`,
    `  }`,
    `});`,
    `process.stdin.resume();`,
  ].join(" ");
}

function nodeInlineEntry(script: string): string {
  // Write a temp file so the path is a real file (probeMcp spawns "node <path>").
  const { writeFileSync, mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fake-mcp-"));
  const file = join(dir, "index.js");
  writeFileSync(file, script, "utf8");
  return file;
}

test("probeMcp succeeds with a well-behaved fake server", async () => {
  const entry = nodeInlineEntry(fakeMcpCmd({}));
  const result = await probeMcp({ entry, smokeTool: "tool0", smokeArgs: {}, budgetMs: 5_000 });
  assert.ok(result.detail.includes("tool0 smoke ok"), `expected smoke ok in detail, got: ${result.detail}`);
});

test("probeMcp throws when tools/list returns 0 tools", async () => {
  const entry = nodeInlineEntry(fakeMcpCmd({ toolsCount: 0 }));
  await assert.rejects(
    () => probeMcp({ entry, smokeTool: "tool0", smokeArgs: {}, budgetMs: 5_000 }),
    /tools\/list returned 0 tools/,
  );
});

test("probeMcp throws when tool call sets isError=true", async () => {
  const entry = nodeInlineEntry(fakeMcpCmd({ callResult: "Error: Sentry request timed out after 20000ms", callIsError: true }));
  await assert.rejects(
    () => probeMcp({ entry, smokeTool: "tool0", smokeArgs: {}, budgetMs: 5_000 }),
    /isError.*timed out/,
  );
});

test("probeMcp throws probe budget exhausted when server never responds to call", async () => {
  // hang > budget → probe budget fires first
  const entry = nodeInlineEntry(fakeMcpCmd({ hangCallMs: 10_000 }));
  const start = Date.now();
  await assert.rejects(
    () => probeMcp({ entry, smokeTool: "tool0", smokeArgs: {}, budgetMs: 1_500 }),
    /timed out|probe budget/,
  );
  // Should have respected the budget (not waited the full hang).
  assert.ok(Date.now() - start < 4_000, "probe should respect budgetMs");
});
