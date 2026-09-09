import { spawn } from "node:child_process";
import { config, LINEAR_AGENT_CLAIMED_LABEL_ID } from "./config";
import { classifyFailure, safeError } from "./providerState";
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
  const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "-m", model,
    "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"', "-c", 'model_reasoning_effort="medium"'];
  for (const [name, entry] of Object.entries(entries)) {
    args.push("-c", `mcp_servers.${name}.command="node"`, "-c", `mcp_servers.${name}.args=${JSON.stringify([entry])}`, "-c", `mcp_servers.${name}.required=true`);
  }
  args.push("-");
  return args;
}
/** No raw command arguments, tool results, reasoning or stderr are persisted. */
export function codexTool(event: Record<string, any>): { tool: string } | null {
  if (event.type !== "item.started") return null;
  const item = event.item;
  if (item?.type === "mcp_tool_call") return { tool: `mcp__${String(item.server).slice(0, 60)}__${String(item.tool).slice(0, 100)}` };
  if (["command_execution", "file_change", "web_search"].includes(item?.type)) return { tool: item.type };
  return null;
}
export async function executeCodex(input: {
  id: string; prompt: string; model: string; entries: Record<string, string>;
  signal: AbortSignal; onTool: (use: { tool: string }) => void;
}): Promise<AttemptResult> {
  const attempt: ProviderAttempt = { id: input.id, provider: "codex", model: input.model, startedAt: new Date().toISOString(), finishedAt: "", status: "failed", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  let output = "", stderr = "", buffer = "", failure = "", completed = false, toolsUsed = false;
  const issueIds = new Set<string>();
  const child = spawn(config.codexBin, codexArgs(input.entries, input.model), { env: codexEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } };
  const abort = () => { failure = "watchdog: Codex run aborted"; kill(); };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  function consume(line: string) {
    if (!line.trim()) return;
    let ev: Record<string, any>;
    try { ev = JSON.parse(line); } catch { failure = "Codex emitted invalid JSON"; kill(); return; }
    if (ev.type === "thread.started") attempt.sessionId = ev.thread_id;
    const tool = codexTool(ev);
    if (tool) { toolsUsed = true; input.onTool(tool); }
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
    if (buffer.length > 4_000_000) { failure = "Codex JSON event exceeded 4 MB"; kill(); }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on("error", () => { /* spawn/close determines failure */ });
  const code = await new Promise<number | null>(resolve => {
    child.on("error", err => { failure = err.message; resolve(null); });
    child.on("exit", () => kill());
    child.on("close", code => resolve(code));
    child.stdin.end(input.prompt);
  });
  input.signal.removeEventListener("abort", abort);
  // Kill any surviving MCP/shell descendants even on normal CLI exit.
  kill();
  if (buffer.trim()) consume(buffer);
  attempt.finishedAt = new Date().toISOString();
  if (code === 0 && completed && !failure && !input.signal.aborted) attempt.status = "completed";
  else {
    attempt.error = safeError(failure || stderr || `Codex exited ${code} without turn.completed`);
    attempt.failureKind = input.signal.aborted ? "timeout" : classifyFailure(attempt.error);
  }
  return { attempt, output, issueIds: [...issueIds], toolsUsed };
}
