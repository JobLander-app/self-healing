import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import { isLimitError, isThrottleError, parseResetTime, readPause } from "./pause";
import type { Provider, ProviderAttempt, FailureKind } from "./providerTypes";
import { credentialFingerprint, readCodexAuthState } from "./codexAuth";

export interface ProviderState {
  status: "unknown" | "available" | "blocked";
  checkedAt?: string;
  retryAt?: string;
  failureKind?: FailureKind;
  reason?: string;
  credentialFingerprint?: string;
  requiresLogin?: boolean;
}
const stateFile = path.join(path.dirname(config.logDir), "providers.json");
let states: Record<Provider, ProviderState> | undefined;
export function parseProviderState(value: unknown): ProviderState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as ProviderState;
  if (!["unknown", "available", "blocked"].includes(raw.status)) return null;
  return { status: raw.status,
    ...(raw.requiresLogin === true ? { requiresLogin: true } : {}),
    ...(typeof raw.credentialFingerprint === "string" && /^(?:[a-f0-9]{64}|missing)$/.test(raw.credentialFingerprint) ? { credentialFingerprint: raw.credentialFingerprint } : {}),
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
  const values = providerOrder().map(providerState).filter(s => s.status === "blocked" && !s.requiresLogin).map(s => Date.parse(s.retryAt ?? "")).filter(value => Number.isFinite(value) && value > after);
  return values.length ? Math.min(...values) : null;
}
export function classifyFailure(message: string): FailureKind {
  if (requiresCodexLogin(message)) return "auth";
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
  return stateCanAttempt(providerState(provider), now);
}
export function stateCanAttempt(s: ProviderState, now = Date.now()): boolean {
  if (s.status === "blocked" && s.requiresLogin) return false;
  return s.status !== "blocked" || !Number.isFinite(Date.parse(s.retryAt ?? "")) || Date.parse(s.retryAt!) <= now;
}
/** Read the shared auth result on every decision; another process or login can
 * recover the session without restarting the dispatcher. File existence alone
 * is never proof of readiness. Do not carry evidence across credential changes. */
export function providerState(provider: Provider): ProviderState {
  const local = state()[provider];
  if (provider !== "codex") return local;
  try {
    const fingerprint = credentialFingerprint();
    const raw = readCodexAuthState();
    const shared = parseProviderState(raw);
    if (raw !== null && (!shared?.credentialFingerprint || !shared.checkedAt)) throw new Error("invalid auth state");
    if (shared && shared.credentialFingerprint !== fingerprint) return { status: "unknown", credentialFingerprint: fingerprint };
    const candidates = [local, shared].filter((s): s is ProviderState => !!s && s.credentialFingerprint === fingerprint);
    return candidates.sort((a, b) => Date.parse(b.checkedAt ?? "1970-01-01") - Date.parse(a.checkedAt ?? "1970-01-01"))[0]
      ?? { status: "unknown", credentialFingerprint: fingerprint };
  } catch {
    return { status: "blocked", failureKind: "unavailable", reason: "Codex auth coordination unavailable", retryAt: "9999-01-01T00:00:00.000Z" };
  }
}
export function providerOrder(): Provider[] {
  return config.codexEnabled ? ["claude", "codex"] : ["claude"];
}
export function stateForAttempt(attempt: ProviderAttempt): ProviderState | null {
  if (attempt.providerSkipped) return null; // preserve the original cooldown/evidence
  const binding = attempt.provider === "codex" ? { credentialFingerprint: attempt.credentialFingerprint ?? credentialFingerprint() } : {};
  // A required MCP server's 401 is not proof that the Codex session is invalid.
  const requiresLogin = attempt.provider === "codex" && attempt.failureKind === "auth" &&
    requiresCodexLogin(attempt.error ?? "");
  if (attempt.status === "completed") {
    return { status: "available", checkedAt: attempt.finishedAt, ...binding };
  } else if (attempt.failureKind && ["quota", "throttle", "auth", "unavailable"].includes(attempt.failureKind)) {
    const now = new Date(attempt.finishedAt);
    return {
      status: "blocked", checkedAt: attempt.finishedAt, failureKind: attempt.failureKind,
      reason: attempt.error, ...binding,
      ...(requiresLogin ? { requiresLogin: true } : {
        retryAt: (parseResetTime(attempt.error ?? "", now) ?? new Date(now.getTime() + (attempt.failureKind === "throttle" ? config.providerThrottleRetryMs : config.providerRetryMs))).toISOString(),
      }),
    };
  }
  return null;
}
/** Use the same terminal-session vocabulary for classification and suspension. */
export function requiresCodexLogin(message: string): boolean {
  // Access tokens normally expire and generic refresh failures can be network
  // errors. Only confirmed refresh-credential invalidation requires a login.
  return /\b(?:refresh_token_(?:reused|expired|invalidated)|invalid_grant)\b/i.test(message)
    || /\brefresh token(?:\s+(?:has|had|is|was|been|already)){0,5}\s+(?:expired|revoked|invalid(?:ated)?|used|no longer valid)\b/i.test(message)
    || /\b(?:expired|revoked|invalid(?:ated)?|reused) refresh token\b/i.test(message)
    || /\bnot logged in\b|authentication blocked; sign in/i.test(message);
}
export function updateProvider(attempt: ProviderAttempt): void {
  const all = state();
  const next = stateForAttempt(attempt);
  if (next) all[attempt.provider] = next;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + ".tmp", JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(stateFile + ".tmp", stateFile);
}
export function providerReadiness(now = Date.now()) {
  const providers = providerOrder().map(provider => {
    const s = providerState(provider);
    const fresh = !!s.checkedAt && now - Date.parse(s.checkedAt) < config.providerEvidenceMaxMs;
    const { credentialFingerprint: _private, ...publicState } = s;
    return { provider, ...publicState, ready: s.status === "available" && fresh, canAttempt: stateCanAttempt(s, now) };
  });
  return { ready: providers.some(p => p.ready), providers };
}
