#!/usr/bin/env node
/**
 * prompt-debt.js — persistent prompt-debt counter for the quality-fixer
 * (JOB-777, owner directive 2026-07-19).
 *
 * After EVERY applied coach fix the fixer must assess accreted debt in the
 * coach ruleset. This tracks, PER SCOPE (default `coach_prompt`), how many
 * point-edits have landed since the last consolidation. When the count hits
 * the threshold (default 3, owner: "3+ правок") OR the fixer finds a
 * contradiction/duplicate, it files a `[Quality] Refactor` ticket; on that
 * refactor's merge it calls `reset`.
 *
 * PERSISTENCE is the whole point: the count MUST survive daemon restarts, so
 * state is a JSON file on the host (operational, like the Monitor
 * known-errors.json), NOT in memory and NOT derived from Linear. Path:
 * $PROMPT_DEBT_STATE or ~/.quality-fixer/prompt-debt.json.
 *
 * Zero dependencies (Node stdlib only) so the fixer can call it directly:
 *   node quality-fixer/prompt-debt.js record --scope coach_prompt --job JOB-779 \
 *        --summary "pin session language" --files src/utils/prompt_builder.py
 *   node quality-fixer/prompt-debt.js check  --scope coach_prompt   # {threshold_hit,...}
 *   node quality-fixer/prompt-debt.js get    --scope coach_prompt
 *   node quality-fixer/prompt-debt.js reset  --scope coach_prompt   # after a Refactor merges
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_THRESHOLD = parseInt(process.env.PROMPT_DEBT_THRESHOLD || "3", 10);

function statePath() {
  if (process.env.PROMPT_DEBT_STATE) return process.env.PROMPT_DEBT_STATE;
  return path.join(os.homedir(), ".quality-fixer", "prompt-debt.json");
}

function loadState() {
  const p = statePath();
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`prompt-debt: cannot read state ${p}: ${e.message}`);
  }
}

function writeState(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // write-then-rename so a crash mid-write cannot corrupt the counter.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}

function ensureScope(state, scope) {
  if (!state[scope]) {
    state[scope] = {
      edits_since_consolidation: 0,
      last_consolidation: null,
      threshold: DEFAULT_THRESHOLD,
      applied: [],
    };
  }
  // threshold stays tunable via env without losing history.
  state[scope].threshold = DEFAULT_THRESHOLD;
  return state[scope];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith("--")) {
      throw new Error(`prompt-debt: expected --flag, got "${key}"`);
    }
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function cmdRecord(args) {
  if (!args.job) throw new Error("record: --job JOB-XXX is required");
  const state = loadState();
  const scope = ensureScope(state, args.scope || "coach_prompt");
  scope.edits_since_consolidation += 1;
  scope.applied.push({
    job: args.job,
    ts: new Date().toISOString(),
    summary: args.summary || "",
    files: args.files ? args.files.split(",").map((s) => s.trim()).filter(Boolean) : [],
  });
  writeState(state);
  const hit = scope.edits_since_consolidation >= scope.threshold;
  console.log(
    JSON.stringify({
      recorded: true,
      scope: args.scope || "coach_prompt",
      edits_since_consolidation: scope.edits_since_consolidation,
      threshold: scope.threshold,
      threshold_hit: hit,
    }),
  );
}

function cmdCheck(args) {
  const state = loadState();
  const scope = ensureScope(state, args.scope || "coach_prompt");
  const hit = scope.edits_since_consolidation >= scope.threshold;
  console.log(
    JSON.stringify({
      scope: args.scope || "coach_prompt",
      edits_since_consolidation: scope.edits_since_consolidation,
      threshold: scope.threshold,
      threshold_hit: hit,
      last_consolidation: scope.last_consolidation,
    }),
  );
  // Non-zero exit when the threshold is hit, so a shell `if` can branch on it
  // (the fixer files a [Quality] Refactor ticket on non-zero).
  process.exitCode = hit ? 1 : 0;
}

function cmdGet(args) {
  const state = loadState();
  const scope = ensureScope(state, args.scope || "coach_prompt");
  console.log(JSON.stringify(scope, null, 2));
}

function cmdReset(args) {
  const state = loadState();
  const scope = ensureScope(state, args.scope || "coach_prompt");
  scope.edits_since_consolidation = 0;
  scope.last_consolidation = new Date().toISOString();
  scope.applied = [];
  writeState(state);
  console.log(
    JSON.stringify({ reset: true, scope: args.scope || "coach_prompt", last_consolidation: scope.last_consolidation }),
  );
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const handlers = { record: cmdRecord, check: cmdCheck, get: cmdGet, reset: cmdReset };
  if (!cmd || !handlers[cmd]) {
    console.error(
      "usage: prompt-debt.js <record|check|get|reset> [--scope coach_prompt] " +
        "[--job JOB-XXX] [--summary ...] [--files a,b]\n" +
        `state: ${statePath()} (override with $PROMPT_DEBT_STATE)`,
    );
    process.exit(2);
  }
  try {
    handlers[cmd](parseArgs(rest));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

main();
