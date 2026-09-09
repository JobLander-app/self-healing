/** Shared subscription provider adapter for the standalone monitor.
 * Prompt on stdin; one final JSON line on stdout. Use a component-specific
 * LOG_DIR: concurrent components must not share the same provider-state file.
 */
import * as path from "node:path";
import { config } from "./config";
import { executeClaude } from "./claude";
import { executeCodex } from "./codex";
import { executeWithFallback } from "./fallback";
import { providerOrder, availableToAttempt, updateProvider } from "./providerState";
import { buildFirebaseMcpEnv, buildLinearMcpEnv, buildSentryMcpEnv, toolUsesFrom } from "./session";
import { hydrateFromDisk, recordAttempt, recordAttemptStarted, traceEvent } from "./trace";

async function main() {
  if (!process.env.LOG_DIR) throw new Error("Monitor provider CLI requires its own LOG_DIR");
  let prompt = "";
  for await (const chunk of process.stdin) {
    prompt += chunk;
    if (prompt.length > 1_000_000) throw new Error("Prompt exceeds 1 MB");
  }
  if (!prompt.trim()) throw new Error("Prompt required on stdin");
  hydrateFromDisk();
  const root = path.resolve(__dirname, "../..");
  const entries = Object.fromEntries(["firebase", "sentry", "linear"].map(name => [name, path.join(root, "mcp", name, "index.js")]));
  const turnId = `monitor-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.maxRunMs);
  const stop = () => controller.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    const result = await executeWithFallback({ providers: providerOrder(), prompt, signal: controller.signal, purpose: "monitor",
      canAttempt: availableToAttempt,
      execute: (provider, nextPrompt) => {
        const id = `${turnId}-${provider}`;
        recordAttemptStarted(turnId, provider, provider === "claude" ? config.claudeModel : config.codexModel);
        return provider === "codex" ? executeCodex({ id, prompt: nextPrompt, model: config.codexModel, entries, signal: controller.signal,
          onTool: tool => traceEvent(turnId, "tool_use", { provider, ...tool }) }) : executeClaude({ id, prompt: nextPrompt, abortController: controller,
          mcpServers: {
            firebase: { command: "node", args: [entries.firebase], env: buildFirebaseMcpEnv() },
            sentry: { command: "node", args: [entries.sentry], env: buildSentryMcpEnv() },
            linear: { command: "node", args: [entries.linear], env: buildLinearMcpEnv() },
          }, onMessage: msg => { for (const tool of toolUsesFrom(msg)) traceEvent(turnId, "tool_use", { provider, ...tool }); } });
      }, record: a => { recordAttempt(turnId, a); updateProvider(a); },
    });
    process.stdout.write(JSON.stringify({ turnId, output: result.output, error: result.error, attempts: result.results.map(r => r.attempt) }) + "\n");
    if (result.error) process.exitCode = 1;
  } finally { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}
main().catch(err => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; });
