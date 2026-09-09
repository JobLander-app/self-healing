import { query } from "@anthropic-ai/claude-agent-sdk";
import { config, LINEAR_AGENT_CLAIMED_LABEL_ID } from "./config";
import { classifyFailure, safeError } from "./providerState";
import { unknownUsage, type AttemptResult, type ProviderAttempt, type TokenUsage } from "./providerTypes";

function num(n: unknown): number | null { return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null; }
export function claudeUsage(value: unknown): TokenUsage {
  const u = value as Record<string, unknown> | undefined;
  const input = num(u?.input_tokens), cachedInput = num(u?.cache_read_input_tokens), cacheWrite = num(u?.cache_creation_input_tokens);
  return { input: input === null ? null : input + (cachedInput ?? 0) + (cacheWrite ?? 0), cachedInput, cacheWrite, output: num(u?.output_tokens) };
}
/** SDK error result messages do not throw: inspect both subtype and is_error. */
export function claudeResultError(m: Record<string, any>): string | null {
  if (m.type !== "result" || (m.subtype === "success" && m.is_error !== true)) return null;
  return [m.result, ...(Array.isArray(m.errors) ? m.errors : [])].filter(x => typeof x === "string").join("\n") || `Claude result: ${m.subtype ?? "error"}`;
}
export async function executeClaude(input: {
  id: string; prompt: string; abortController: AbortController;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  onMessage: (m: unknown) => void;
}, queryProvider: typeof query = query): Promise<AttemptResult> {
  const attempt: ProviderAttempt = { id: input.id, provider: "claude", model: config.claudeModel, startedAt: new Date().toISOString(), finishedAt: "", status: "failed", usage: unknownUsage(), estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  let output = "", error = "", gotResult = false, toolsUsed = false;
  const issueIds = new Set<string>();
  try {
    for await (const msg of queryProvider({ prompt: input.prompt, options: {
      model: config.claudeModel, maxTurns: config.claudeMaxTurns,
      allowedTools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Agent", "mcp__firebase__*", "mcp__sentry__*", "mcp__linear__*"],
      mcpServers: input.mcpServers, permissionMode: "bypassPermissions", abortController: input.abortController,
    } })) {
      const m = msg as Record<string, any>;
      input.onMessage(m);
      if (m.session_id) attempt.sessionId = m.session_id;
      for (const block of m.type === "assistant" && Array.isArray(m.message?.content) ? m.message.content : []) {
        if (block.type === "tool_use") toolsUsed = true;
        if (block.type === "tool_use" && block.name === "mcp__linear__update_issue" && Array.isArray(block.input?.labelIds) && block.input.labelIds.includes(LINEAR_AGENT_CLAIMED_LABEL_ID)) {
          const id = block.input?.id;
          if (typeof id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(id)) issueIds.add(id);
        }
      }
      if (m.type === "result") {
        gotResult = true; output = typeof m.result === "string" ? m.result : "";
        attempt.usage = claudeUsage(m.usage);
        attempt.rawUsage = Object.fromEntries(Object.entries(m.usage ?? {}).filter(([, v]) => typeof v === "number")) as Record<string, number>;
        attempt.models = Object.entries(m.modelUsage ?? {}).map(([model, raw]) => {
          const u = raw as Record<string, number>;
          return { model, usage: claudeUsage({ input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens }) };
        });
        attempt.estimatedCostUsd = num(m.total_cost_usd);
        if (attempt.estimatedCostUsd !== null) attempt.costSource = "claude-sdk-estimate";
        attempt.turns = num(m.num_turns) ?? 0;
        error = claudeResultError(m) ?? "";
      }
    }
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  attempt.finishedAt = new Date().toISOString();
  if (gotResult && !error && !input.abortController.signal.aborted) attempt.status = "completed";
  else {
    attempt.error = safeError(input.abortController.signal.aborted ? "watchdog: Claude run aborted" : error || "Claude stream ended without result");
    attempt.failureKind = input.abortController.signal.aborted ? "timeout" : !gotResult && !error ? "unavailable" : classifyFailure(attempt.error);
  }
  return { attempt, output, issueIds: [...issueIds], toolsUsed };
}
