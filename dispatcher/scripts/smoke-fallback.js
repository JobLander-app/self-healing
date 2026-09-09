#!/usr/bin/env node
// Real subscription smoke. Never starts the dispatcher or claims a ticket.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shl-fallback-smoke-")) + "/turns";
process.env.CODEX_ENABLED = "true";
if (!process.env.CODEX_MODEL) throw new Error("Set the verified CODEX_MODEL");
const { executeWithFallback } = require("../dist/fallback");
const { executeCodex } = require("../dist/codex");
const { unknownUsage } = require("../dist/providerTypes");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
executeWithFallback({ providers: ["claude", "codex"], prompt: "This is a read-only subscription connectivity probe. Do not use any tools, read files or change anything. Reply exactly SHL_CODEX_FALLBACK_OK.",
  signal: controller.signal, canAttempt: () => true, record: () => {},
  execute: async (provider, prompt) => {
    if (provider === "codex") return executeCodex({ id: "smoke-codex", prompt, model: process.env.CODEX_MODEL, entries: {}, signal: controller.signal, onTool: () => { controller.abort(); } });
    const at = new Date().toISOString();
    return { output: "", toolsUsed: false, issueIds: [], attempt: { id: "mock-claude-quota", provider: "claude", model: "mock", status: "failed", failureKind: "quota", error: "Injected quota response for isolated smoke", startedAt: at, finishedAt: at, usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 } };
  },
}).then(result => {
  const ok = !result.error && result.results.length === 2 && result.output.trim() === "SHL_CODEX_FALLBACK_OK";
  console.log(JSON.stringify({ ok, error: result.error, attempts: result.results.map(r => r.attempt) }, null, 2));
  if (!ok) process.exitCode = 1;
}).catch(err => { console.error(err.message); process.exitCode = 1; }).finally(() => clearTimeout(timer));
