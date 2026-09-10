import type { AttemptResult, Provider, ProviderAttempt } from "./providerTypes";

export function fallbackAllowed(result: AttemptResult, purpose: "dispatch" | "monitor" = "dispatch"): boolean {
  // If the previous agent used tools but never exposed the mutated ticket,
  // there is no safe way to identify/reclaim its work. Let normal stale-claim
  // recovery handle it; never guess and start a second ticket in this run.
  return result.attempt.status === "failed" &&
    ["quota", "throttle", "auth", "unavailable"].includes(result.attempt.failureKind ?? "") &&
    (!result.toolsUsed || (purpose === "dispatch" && result.issueIds.length === 1));
}
export function handoverPrompt(prompt: string, previous: AttemptResult, purpose: "dispatch" | "monitor" = "dispatch"): string {
  if (purpose === "monitor") return `${prompt}\n\n## PROVIDER HANDOVER\nThe previous provider failed before invoking any tools. This is a NEW session for the SAME monitor escalation batch and original instructions. Do not pick or claim repair tickets, investigate unrelated incidents or change the monitor's authorized scope. No previous external action needs repeating; preserve the original deduplication and no-repair rules.\n`;
  const target = previous.issueIds[0];
  return `${prompt}\n\n## PROVIDER HANDOVER (overrides PICK for this attempt)\n` +
    `The ${previous.attempt.provider} attempt ended with a provider availability error and has stopped. This is a NEW session, not a resumed conversation.\n` +
    (target ? `The previous attempt called update_issue for ${target}; this is an observed mutation target, not proof the claim succeeded. Work on this ticket ONLY. Re-read its current state, labels, comments, repository working tree, PR and CI status before any write. If it is terminal, verify the existing outcome and report it without repeating writes. The observed update included the agent-claimed label. Recheck the claim and comments for intervening ownership changes; only if they confirm this interrupted attempt owns it may you continue without waiting for the stale-claim window. Never create another PR or claim if the previous action already succeeded.\n` :
      `The previous attempt invoked NO tools, so it made no claims or external writes. Follow the original task's selected-ticket and DRY_RUN instructions exactly.\n`) +
    `The constitution, DRY_RUN restrictions and all verification/review gates still apply. Do not treat this handover as evidence that any repair was completed.\n`;
}
export async function executeWithFallback(input: {
  providers: Provider[]; prompt: string; signal: AbortSignal;
  purpose?: "dispatch" | "monitor";
  allowedIssueIds?: readonly string[];
  canAttempt: (p: Provider) => boolean;
  execute: (p: Provider, prompt: string) => Promise<AttemptResult>;
  record: (attempt: ProviderAttempt) => void;
}): Promise<{ results: AttemptResult[]; output: string; error: string | null }> {
  const results: AttemptResult[] = [];
  let prompt = input.prompt;
  for (const provider of input.providers) {
    if (input.signal.aborted) break;
    if (!input.canAttempt(provider)) continue;
    const result = await input.execute(provider, prompt);
    results.push(result);
    input.record(result.attempt);
    if (input.allowedIssueIds && result.issueIds.some(id => !input.allowedIssueIds!.includes(id))) {
      return { results, output: result.output, error: "Provider claimed outside the exact selected candidate; refusing continuation" };
    }
    if (result.attempt.status === "completed") return { results, output: result.output, error: null };
    if (!fallbackAllowed(result, input.purpose)) break;
    prompt = handoverPrompt(input.prompt, result, input.purpose);
  }
  const last = results.at(-1);
  return { results, output: last?.output ?? "", error: input.signal.aborted ? "watchdog: run aborted before provider completion" : last?.attempt.error ?? "No provider available; waiting for provider retry window" };
}
