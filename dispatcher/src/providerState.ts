import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import { isLimitError, isThrottleError, parseResetTime, readPause } from "./pause";
import type { Provider, ProviderAttempt, FailureKind } from "./providerTypes";

export interface ProviderState {
  status: "unknown" | "available" | "blocked";
  checkedAt?: string;
  retryAt?: string;
  failureKind?: FailureKind;
  reason?: string;
}
const stateFile = path.join(path.dirname(config.logDir), "providers.json");
let states: Record<Provider, ProviderState> | undefined;
export function parseProviderState(value: unknown): ProviderState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as ProviderState;
  if (!["unknown", "available", "blocked"].includes(raw.status)) return null;
  return { status: raw.status,
    ...(typeof raw.checkedAt === "string" && Number.isFinite(Date.parse(raw.checkedAt)) ? { checkedAt: raw.checkedAt } : {}),
    ...(typeof raw.retryAt === "string" && Number.isFinite(Date.parse(raw.retryAt)) ? { retryAt: raw.retryAt } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason.slice(0, 1000) } : {}),
    ...(typeof raw.failureKind === "string" && ["quota", "throttle", "auth", "unavailable", "task", "timeout"].includes(raw.failureKind) ? { failureKind: raw.failureKind } : {}),
  };
}
function state(): Record<Provider, ProviderState> {
  if (states) return states;
  states = { claude: { status: "unknown" }, codex: { status: "unknown" } };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const provider of ["claude", "codex"] as const) {
      const parsed = parseProviderState(saved?.[provider]);
      if (parsed) states[provider] = parsed;
    }
  } catch { /* first install */ }
  // A pre-upgrade Claude quota pause remains evidence of failure. It must not
  // globally suppress the newly enabled Codex fallback.
  const legacy = readPause();
  if (states.claude.status === "unknown" && legacy) {
    states.claude = { status: "blocked", retryAt: legacy.until, checkedAt: legacy.setAt, failureKind: "quota", reason: legacy.reason };
  }
  return states;
}
export function nextProviderRetry(after = -Infinity): number | null {
  const values = providerOrder().filter(p => state()[p].status === "blocked").map(p => Date.parse(state()[p].retryAt ?? "")).filter(value => Number.isFinite(value) && value > after);
  return values.length ? Math.min(...values) : null;
}
export function classifyFailure(message: string): FailureKind {
  if (isLimitError(message)) return "quota";
  if (isThrottleError(message)) return "throttle";
  if (/unauthenticated|unauthorized|authentication|auth token|oauth|(?:access|refresh) token|refresh_token_reused|token.{0,30}expired|invalid.{0,20}token|not logged in|please (?:run .{0,10})?login|\b401\b/i.test(message)) return "auth";
  if (/overloaded|service unavailable|connection (?:refused|reset|closed)|ECONN(?:RESET|REFUSED)|ETIMEDOUT|fetch failed|error sending request|stream disconnected|network error|\b(?:500|502|503|504|529)\b|spawn .+ ENOENT|model.{0,120}(?:not (?:available|supported|found)|does not exist)|(?:invalid|unsupported) model/i.test(message)) return "unavailable";
  return "task";
}
export function safeError(message: string): string {
  let safe = message;
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|KEY|PASSWORD/.test(name) && value && value.length >= 8) safe = safe.split(value).join("[REDACTED]");
  }
  return safe.replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_.-]+)/g, "[REDACTED]").slice(0, 1000);
}
export function availableToAttempt(provider: Provider, now = Date.now()): boolean {
  return stateCanAttempt(state()[provider], now);
}
export function stateCanAttempt(s: ProviderState, now = Date.now()): boolean {
  return s.status !== "blocked" || !Number.isFinite(Date.parse(s.retryAt ?? "")) || Date.parse(s.retryAt!) <= now;
}
export function providerOrder(): Provider[] {
  return config.codexEnabled ? ["claude", "codex"] : ["claude"];
}
export function updateProvider(attempt: ProviderAttempt): void {
  const all = state();
  if (attempt.status === "completed") {
    all[attempt.provider] = { status: "available", checkedAt: attempt.finishedAt };
  } else if (attempt.failureKind && ["quota", "throttle", "auth", "unavailable"].includes(attempt.failureKind)) {
    const now = new Date(attempt.finishedAt);
    all[attempt.provider] = {
      status: "blocked", checkedAt: attempt.finishedAt, failureKind: attempt.failureKind,
      reason: attempt.error,
      retryAt: (parseResetTime(attempt.error ?? "", now) ?? new Date(now.getTime() + (attempt.failureKind === "throttle" ? config.providerThrottleRetryMs : config.providerRetryMs))).toISOString(),
    };
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + ".tmp", JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(stateFile + ".tmp", stateFile);
}
export function providerReadiness(now = Date.now()) {
  const providers = providerOrder().map(provider => {
    const s = state()[provider];
    const fresh = !!s.checkedAt && now - Date.parse(s.checkedAt) < config.providerEvidenceMaxMs;
    return { provider, ...s, ready: s.status === "available" && fresh, canAttempt: availableToAttempt(provider, now) };
  });
  return { ready: providers.some(p => p.ready), providers };
}
