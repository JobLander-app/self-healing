import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { config, LINEAR_AGENT_CLAIMED_LABEL_ID } from "./config";
import { classifyFailure, safeError, stateForAttempt } from "./providerState";
import { codexSessionScript } from "./codexAuth";
import type { Duplex } from "node:stream";
import { unknownUsage, type AttemptResult, type ProviderAttempt, type TokenUsage } from "./providerTypes";

const number = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
export function codexUsage(value: unknown): TokenUsage {
  const u = value as Record<string, unknown> | undefined;
  return { input: number(u?.input_tokens), cachedInput: number(u?.cached_input_tokens), cacheWrite: number(u?.cache_write_input_tokens), output: number(u?.output_tokens) };
}
export function codexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "CODEX_HOME", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR", "CLOUDSDK_CONFIG", "GCP_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.GCP_PROJECT_ID = config.gcpProject;
  env.CODEX_HOME = source.CODEX_HOME || `${source.HOME}/.codex-shl`;
  return env;
}
export function codexArgs(entries: Record<string, string>, model: string): string[] {
  const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "-m", model,
    "-c", 'forced_login_method="chatgpt"', "-c", 'cli_auth_credentials_store="file"', "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="medium"'];
  for (const [name, entry] of Object.entries(entries)) {
    args.push("-c", `mcp_servers.${name}.command="node"`, "-c", `mcp_servers.${name}.args=${JSON.stringify([entry])}`, "-c", `mcp_servers.${name}.required=true`);
  }
  args.push("-");
  return args;
}
/** No raw command arguments, tool results, reasoning or stderr are persisted. */
export function codexTool(event: Record<string, any>): { tool: string } | null {
  if (!["item.started", "item.completed"].includes(event.type)) return null;
  const item = event.item;
  if (item?.type === "mcp_tool_call") return { tool: `mcp__${String(item.server).slice(0, 60)}__${String(item.tool).slice(0, 100)}` };
  if (["command_execution", "file_change", "web_search"].includes(item?.type)) return { tool: item.type };
  // A new CLI tool kind must not look like a side-effect-free attempt. Only
  // known conversational metadata can be ignored for handover safety.
  if (typeof item?.type === "string" && !["agent_message", "reasoning", "todo_list", "plan"].includes(item.type)) {
    return { tool: `codex_${item.type.replace(/[^a-z0-9_]/gi, "").slice(0, 60)}` };
  }
  return null;
}
interface CodexInput {
  id: string; prompt: string; beforeStart?: () => void; model: string; entries: Record<string, string>;
  signal: AbortSignal; onTool: (use: { tool: string }) => void;
}
export function executeCodex(input: CodexInput): Promise<AttemptResult> {
  return executeCodexTransport(input, { args: codexArgs(input.entries, input.model), env: codexEnv() });
}

/** Smoke has no repair tools or cloud credentials. Keep the original auth home
 * so subscription refreshes remain in place, but ignore its config/rules. */
export async function executeCodexSmoke(input: Omit<CodexInput, "entries">): Promise<AttemptResult> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "shl-codex-probe-"));
  const env: NodeJS.ProcessEnv = { HOME: cwd, TMPDIR: cwd,
    CODEX_HOME: path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex-shl")) };
  for (const key of ["PATH", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const args = codexArgs({}, input.model).filter(arg => arg !== "--dangerously-bypass-approvals-and-sandbox");
  args.splice(args.length - 1, 0, "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules",
    "-c", 'approval_policy="never"', "-c", 'cli_auth_credentials_store="file"',
    "-c", 'history.persistence="none"', "-c", 'web_search="disabled"',
    "--disable", "apps", "--disable", "shell_tool", "--disable", "multi_agent");
  try { return await executeCodexTransport({ ...input, entries: {} }, { args, env, cwd }); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

async function executeCodexTransport(input: CodexInput, launch: { args: string[]; env: NodeJS.ProcessEnv; cwd?: string }): Promise<AttemptResult> {
  const attempt: ProviderAttempt = { id: input.id, provider: "codex", model: input.model, startedAt: new Date().toISOString(), finishedAt: "", status: "failed", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  let output = "", stderr = "", buffer = "", failure = "", completed = false, toolsUsed = false, transportFailed = false;
  const issueIds = new Set<string>();
  const tracedItems = new Set<string>();
  let startError: unknown;
  let authFinished = false;
  const child = spawn("python3", [codexSessionScript, config.codexBin, ...launch.args], { env: launch.env, cwd: launch.cwd, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true });
  const control = child.stdio[3] as Duplex;
  control.on("error", () => { /* exit/close handles coordination failure */ });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } };
  const abort = () => { failure = "watchdog: Codex run aborted"; kill(); };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  function finish(code: number | null) {
    if (code === 0 && completed && !failure && !input.signal.aborted) attempt.status = "completed";
    else {
      attempt.status = "failed";
      attempt.error = safeError(failure || stderr || `Codex exited ${code} without turn.completed`);
      attempt.failureKind = input.signal.aborted ? "timeout" : transportFailed || (code === 0 && !completed) ? "unavailable" : classifyFailure(attempt.error);
    }
  }
  function consume(line: string) {
    if (!line.trim()) return;
    if (line.length > 4_000_000) { transportFailed = true; failure = "Codex JSON event exceeded 4 MB"; kill(); return; }
    let ev: Record<string, any>;
    try { ev = JSON.parse(line); } catch { transportFailed = true; failure = "Codex emitted invalid JSON"; kill(); return; }
    if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof ev.type !== "string") { transportFailed = true; failure = "Codex emitted invalid event envelope"; kill(); return; }
    if (ev.type === "shl.auth_locked") {
      attempt.credentialFingerprint = ev.credentialFingerprint;
      if (input.signal.aborted) { abort(); return; }
      try {
        input.beforeStart?.(); // recheck candidate and accounting AFTER waiting
        control.write("G");
        child.stdin.end(input.prompt);
      } catch (error) { startError = error; kill(); }
      return;
    }
    if (ev.type === "shl.auth_finished") {
      authFinished = true;
      attempt.finishedAt = ev.checkedAt;
      attempt.credentialFingerprint = ev.credentialFingerprint;
      stderr = ev.stderr || stderr;
      finish(ev.code);
      const { reason: _private, ...state } = stateForAttempt(attempt) ?? { status: "unknown" };
      control.end(JSON.stringify(state) + "\n");
      return;
    }
    if (ev.type === "thread.started") attempt.sessionId = ev.thread_id;
    const tool = codexTool(ev);
    if (tool) {
      toolsUsed = true;
      const id = typeof ev.item?.id === "string" ? ev.item.id : undefined;
      if (!id || !tracedItems.has(id)) { input.onTool(tool); if (id) tracedItems.add(id); }
    }
    if (ev.item?.type === "mcp_tool_call" && ev.item.tool === "update_issue" && Array.isArray(ev.item.arguments?.labelIds) && ev.item.arguments.labelIds.includes(LINEAR_AGENT_CLAIMED_LABEL_ID)) {
      const id = ev.item.arguments?.id;
      if (typeof id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(id)) issueIds.add(id);
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") output = String(ev.item.text ?? "").slice(-64_000);
    if (ev.type === "turn.completed") {
      completed = true;
      // exec performs one user turn. A duplicate terminal event must not add
      // its cumulative usage twice; later terminal snapshots replace earlier.
      attempt.usage = codexUsage(ev.usage);
      attempt.rawUsage = Object.fromEntries(Object.entries(ev.usage ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>;
      attempt.turns = 1;
    }
    if (ev.type === "turn.failed") failure = String(ev.error?.message ?? "Codex turn failed");
    // `error` can be a reconnect notice. A later completed turn proves recovery.
    if (ev.type === "error") stderr = String(ev.message ?? "Codex provider error").slice(-4000);
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) { const pos = buffer.indexOf("\n"); if (pos < 0) break; const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1); consume(line); }
    if (buffer.length > 4_000_000) { transportFailed = true; failure = "Codex JSON event exceeded 4 MB"; kill(); }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on("error", () => { /* spawn/close determines failure */ });
  const code = await new Promise<number | null>(resolve => {
    child.on("error", err => { failure = err.message; resolve(null); });
    child.on("exit", () => kill());
    child.on("close", code => resolve(code));
  });
  input.signal.removeEventListener("abort", abort);
  // Kill any surviving MCP/shell descendants even on normal CLI exit.
  kill();
  if (startError) throw startError;
  if (buffer.trim()) consume(buffer);
  if (!attempt.finishedAt) attempt.finishedAt = new Date().toISOString();
  if (!authFinished || (code !== 0 && attempt.status === "completed")) {
    // Inference may finish but persisting the shared result can still fail.
    if (!input.signal.aborted) { transportFailed = true; failure ||= "Codex auth coordination unavailable"; }
    finish(code);
  }
  return { attempt, output, issueIds: [...issueIds], toolsUsed };
}
