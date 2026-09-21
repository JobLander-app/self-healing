import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import { accountingStatus } from "./accountingState";
import { sendTelegram } from "./notify";
import { providerReadiness, safeError } from "./providerState";

interface Alert { active: boolean; message: string; pending: boolean; deliveredAt?: number }
const file = path.join(path.dirname(config.logDir), "health-alerts.json");
let alerts: Record<string, Alert> | undefined;
export function parseAlertState(value: unknown): Record<string, Alert> {
  const valid: Record<string, Alert> = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return valid;
  for (const [key, raw] of Object.entries(value)) {
    const item = raw as Partial<Alert> | null;
    if (!item || typeof item.active !== "boolean" || typeof item.pending !== "boolean" || typeof item.message !== "string") continue;
    valid[key] = { active: item.active, pending: item.pending, message: item.message,
      ...(typeof item.deliveredAt === "number" && Number.isFinite(item.deliveredAt) ? { deliveredAt: item.deliveredAt } : {}) };
  }
  return valid;
}
function state() {
  if (!alerts) { try { alerts = parseAlertState(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { alerts = Object.create(null); } }
  return alerts!;
}
function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file + ".tmp", "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(state())); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(file + ".tmp", file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
const sending = new Set<string>();
async function deliver(key: string, send = sendTelegram): Promise<void> {
  const item = state()[key];
  if (!item?.pending || sending.has(key)) return;
  sending.add(key);
  try {
    if (await send(item.message)) {
      // A recovery can supersede an in-flight down notification.
      if (state()[key] === item) { item.pending = false; item.deliveredAt = Date.now(); save(); }
    }
  } finally { sending.delete(key); }
}
export async function healthAlert(key: string, active: boolean, message: string, send = sendTelegram): Promise<void> {
  const previous = state()[key];
  // One delivered notification per state transition. Repeated probes must
  // retry pending delivery without re-enqueuing an acknowledged outage.
  if (previous?.active === active) {
    if (previous.pending) await deliver(key, send);
    return;
  }
  if (!active && !previous) return;
  state()[key] = { active, message: safeError(message), pending: true };
  save();
  await deliver(key, send);
}
export async function retryHealthAlerts(send = sendTelegram): Promise<void> {
  for (const key of Object.keys(state())) await deliver(key, send);
}
export async function alertProviderReadiness(): Promise<void> {
  const r = providerReadiness();
  const codex = r.providers.find(p => p.provider === "codex");
  if (codex?.requiresLogin && codex.status === "blocked") {
    await healthAlert("codex-auth", true, "⚠️ Codex authentication needs a new VM login. Attempts are suspended until credentials change. Use the serialized login in docs/CODEX-FALLBACK.md; do not copy another machine's auth.json.");
  } else if (codex?.ready) {
    await healthAlert("codex-auth", false, "✅ Codex authentication recovered: the current VM credentials completed a real turn.");
  }
  // Unknown on first boot is not a quota incident. A real availability error
  // makes the operational failure actionable; don't create a repair ticket
  // for routine subscription exhaustion.
  // An unverified fallback (e.g. first boot after a credential change) is not
  // evidence that every provider failed. Readiness stays false until verified.
  if (!r.ready && r.providers.every(p => p.status === "blocked")) {
    await healthAlert("providers", true, `⚠️ Repair capability unavailable. ${r.providers.map(p => `${p.provider}: ${p.status}${p.retryAt ? `; retry ${p.retryAt}` : ""}`).join(". ")}. VM is alive; provider quota/authentication needs attention.`);
  } else if (r.ready) await healthAlert("providers", false, "✅ Repair capability recovered: a subscription provider completed a real turn successfully.");
}
export async function alertAccounting(send = sendTelegram): Promise<void> {
  const s = accountingStatus();
  await healthAlert("accounting", !s.healthy, !s.healthy
    ? `⚠️ Repair accounting unavailable: ${s.error}. New provider attempts are suspended; VM liveness is unaffected. Preserve usage-ledger.jsonl and repair storage. Replay retries automatically.`
    : "✅ Repair accounting recovered: the preserved ledger replayed successfully and storage is writable.", send);
  // A prior size warning must not suppress the more serious outage alert.
  await healthAlert("accounting-maintenance", s.warning, s.warning
    ? `⚠️ Repair accounting needs maintenance: ledger ${s.bytes}/${s.maxBytes} bytes; ${s.rejectedRecords} malformed/partial records skipped. Preserve the ledger and investigate before the size cap is reached.`
    : "✅ Repair accounting maintenance warning cleared after storage replay.", send);

}
export function startHealthAlertRetry(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void alertAccounting().catch(err => console.error("[health-alert] accounting alert failed:", err));
    void alertProviderReadiness().catch(err => console.error("[health-alert] provider alert failed:", err));
    void retryHealthAlerts().catch(err => console.error("[health-alert] retry failed:", err));
  }, 60_000);
  timer.unref();
  return timer;
}
