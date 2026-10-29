import { spawn } from "node:child_process";
import { config, LINEAR_AGENT_CLAIMED_LABEL_ID } from "./config";
import { classifyFailure, safeError } from "./providerState";
import { unknownUsage, type AttemptResult, type ProviderAttempt } from "./providerTypes";

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** OpenCode JSON output is a stream of completed parts, not one cumulative result. */
export class OpenCodeResult {
  output = "";
  error = "";
  toolsUsed = false;
  completed = false;
  issueIds = new Set<string>();
  private seen = new Set<string>();
  constructor(readonly attempt: ProviderAttempt, private onTool: (use: { tool: string }) => void) {}

  consume(event: Record<string, any>): void {
    if (!event || typeof event.type !== "string") throw new Error("OpenCode emitted an invalid event envelope");
    const part = event.part;
    if (typeof event.sessionID === "string") this.attempt.sessionId = event.sessionID;
    if (event.type === "error") {
      this.error = String(event.error?.data?.message || event.error?.message || event.error?.name || "OpenCode error");
      return;
    }
    const id = typeof part?.id === "string" ? `${event.type}:${part.id}` : null;
    if (id && this.seen.has(id)) return;
    if (id) this.seen.add(id);
    if (event.type === "text") {
      this.output = (this.output + String(part?.text || "") + "\n").slice(-64_000);
    } else if (event.type === "tool_use") {
      this.toolsUsed = true;
      const tool = String(part?.tool || "unknown");
      this.onTool({ tool: tool.slice(0, 160) });
      const input = part?.state?.input;
      if (/^(?:mcp__)?linear(?:__|_)update_issue$/.test(tool) &&
          Array.isArray(input?.labelIds) && input.labelIds.includes(LINEAR_AGENT_CLAIMED_LABEL_ID) &&
          typeof input.id === "string" && /^[A-Za-z0-9-]{1,80}$/.test(input.id)) this.issueIds.add(input.id);
    } else if (event.type === "step_finish") {
      this.attempt.turns++;
      const tokens = part?.tokens;
      const input = number(tokens?.input), read = number(tokens?.cache?.read), write = number(tokens?.cache?.write);
      const usage = { input: input === null ? null : input + (read ?? 0) + (write ?? 0),
        cachedInput: read, cacheWrite: write, output: number(tokens?.output) };
      for (const key of ["input", "cachedInput", "cacheWrite", "output"] as const) {
        const before = this.attempt.turns === 1 ? 0 : this.attempt.usage[key];
        this.attempt.usage[key] = before === null || usage[key] === null ? null : before + usage[key]!;
      }
      const cost = number(part?.cost);
      const previous = this.attempt.turns === 1 ? 0 : this.attempt.estimatedCostUsd;
      this.attempt.estimatedCostUsd = previous === null || cost === null ? null : previous + cost;
      this.attempt.costSource = this.attempt.estimatedCostUsd === null ? "unavailable" : "opencode-estimate";
      this.completed = ["stop", "end_turn"].includes(part?.reason);
    } else if (!["step_start", "reasoning"].includes(event.type)) {
      // Unknown activity must not authorize a supposedly side-effect-free handover.
      this.toolsUsed = true;
    }
  }
}

export function openCodeEnv(entries: Record<string, string>, source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "USER", "LOGNAME", "SHELL", "TMPDIR", "CLOUDSDK_CONFIG",
    "GOOGLE_APPLICATION_CREDENTIALS", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENROUTER_API_KEY",
    "LINEAR_API_KEY_SECRET", "SENTRY_ORG", "SENTRY_PROJECT_ID", "SENTRY_TOKEN_SECRET"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.GCP_PROJECT_ID = config.gcpProject;
  // Secret values stay in the child environment, never argv or the JSON config.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: "https://opencode.ai/config.json", share: "disabled", autoupdate: false,
    enabled_providers: ["openrouter"],
    mcp: Object.fromEntries(Object.entries(entries).map(([name, entry]) =>
      [name, { type: "local", command: ["node", entry], enabled: true }])),
  });
  return env;
}

export async function executeOpenCode(input: {
  id: string; prompt: string; model: string; entries: Record<string, string>;
  signal: AbortSignal; beforeStart?: () => void; onTool: (use: { tool: string }) => void;
}): Promise<AttemptResult> {
  const attempt: ProviderAttempt = { id: input.id, provider: "opencode", model: input.model,
    startedAt: new Date().toISOString(), finishedAt: "", status: "failed", usage: unknownUsage(),
    estimatedCostUsd: null, costSource: "unavailable", turns: 0 };
  const result = new OpenCodeResult(attempt, input.onTool);
  let stderr = "", buffer = "", bytes = 0, transportError = "";
  if (!process.env.OPENROUTER_API_KEY) {
    attempt.error = "OPENROUTER_API_KEY is not configured";
    attempt.failureKind = "auth";
  } else if (!input.signal.aborted) {
    input.beforeStart?.();
    const child = spawn(config.openCodeBin, ["run", "--format", "json", "--model", input.model, "--auto"], {
      env: openCodeEnv(input.entries), stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ } } };
    const abort = () => { transportError = "watchdog: OpenCode run aborted"; kill(); };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const consume = (line: string) => {
      if (!line.trim()) return;
      try { result.consume(JSON.parse(line)); }
      catch { transportError = "OpenCode emitted invalid JSON events"; kill(); }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > 50 * 1024 * 1024 || buffer.length > 4_000_000) {
        transportError = "OpenCode output exceeded capture limit"; kill(); return;
      }
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk); stderr = (stderr + chunk).slice(-4000);
      if (bytes > 50 * 1024 * 1024) { transportError = "OpenCode output exceeded capture limit"; kill(); }
    });
    child.stdin.on("error", () => { /* child close determines the result */ });
    child.stdin.end(input.prompt);
    const code = await new Promise<number | null>(resolve => {
      child.on("error", error => { transportError = error.message; resolve(null); });
      child.on("exit", kill);
      child.on("close", resolve);
    });
    input.signal.removeEventListener("abort", abort);
    kill();
    if (buffer.trim()) consume(buffer);
    if (code === 0 && result.completed && !result.error && !transportError && !input.signal.aborted) attempt.status = "completed";
    else {
      attempt.error = safeError(transportError || result.error || stderr || `OpenCode exited ${code} without a completed turn`);
      attempt.failureKind = input.signal.aborted ? "timeout" : transportError || (code === 0 && !result.completed)
        ? "unavailable" : classifyFailure(attempt.error);
    }
  } else {
    attempt.error = "watchdog: OpenCode run aborted"; attempt.failureKind = "timeout";
  }
  attempt.finishedAt = new Date().toISOString();
  return { attempt, output: result.output, toolsUsed: result.toolsUsed, issueIds: [...result.issueIds] };
}
