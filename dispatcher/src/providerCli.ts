/** Shared subscription provider adapter for the standalone monitor.
 * Prompt on stdin; one final JSON line on stdout. Use a component-specific
 * LOG_DIR: concurrent components must not share the same provider-state file.
 */
import * as path from "node:path";
import { accountingStatus } from "./accountingState";
import { alertAccounting } from "./healthAlerts";
import { readProviderPrompt } from "./promptInput";
import { config, providerModel } from "./config";
import { executeClaude } from "./claude";
import { executeOpenCode } from "./opencode";
import { executeCodex } from "./codex";
import { executeWithFallback } from "./fallback";
import { providerOrder, availableToAttempt, updateProvider } from "./providerState";
import { mcpEntries, mcpServers, toolUsesFrom } from "./session";
import { hydrateFromDisk, recordAttempt, recordAttemptStarted, traceEvent } from "./trace";

async function main() {
  if (!process.env.LOG_DIR) throw new Error("Monitor provider CLI requires its own LOG_DIR");
  const prompt = await readProviderPrompt(process.stdin);
  hydrateFromDisk();
  await alertAccounting().catch(err => console.error("[provider-cli] accounting alert failed:", err));
  if (!accountingStatus().healthy) throw new Error("Accounting unavailable; no provider attempt started");
  const entries = mcpEntries();
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
        recordAttemptStarted(turnId, provider, providerModel(provider));
        if (provider === "opencode") return executeOpenCode({ id, prompt: nextPrompt, model: config.openCodeModel, entries,
          signal: controller.signal, onTool: tool => traceEvent(turnId, "tool_use", { provider, ...tool }) });
        return provider === "codex" ? executeCodex({ id, prompt: nextPrompt, model: config.codexModel, entries, signal: controller.signal,
          onTool: tool => traceEvent(turnId, "tool_use", { provider, ...tool }) }) : executeClaude({ id, prompt: nextPrompt, abortController: controller,
          mcpServers: mcpServers(), onMessage: msg => { for (const tool of toolUsesFrom(msg)) traceEvent(turnId, "tool_use", { provider, ...tool }); } });
      }, record: a => { recordAttempt(turnId, a); updateProvider(a); },
    });
    process.stdout.write(JSON.stringify({ turnId, output: result.output, error: result.error, attempts: result.results.map(r => r.attempt) }) + "\n");
    if (result.error) process.exitCode = 1;
  } finally { clearTimeout(timer); process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}
main().catch(err => {
  const error = err instanceof Error ? err.message : String(err);
  process.stdout.write(JSON.stringify({ turnId: null, output: "", error, attempts: [] }) + "\n");
  process.exitCode = 1;
});
