import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";
import { sendTelegram } from "./notify";
import { providerReadiness, safeError } from "./providerState";

interface Alert { active: boolean; message: string; pending: boolean; deliveredAt?: number }
const file = path.join(path.dirname(config.logDir), "health-alerts.json");
let alerts: Record<string, Alert> | undefined;
function state() {
  if (!alerts) { try { alerts = JSON.parse(fs.readFileSync(file, "utf8")); } catch { alerts = {}; } }
  return alerts!;
}
function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(state()), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
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
  if (!active && !previous?.active) return;
  if (previous?.active === active && !previous.pending && Date.now() - (previous.deliveredAt ?? 0) < 6 * 3_600_000) return;
  state()[key] = { active, message: safeError(message), pending: true };
  save();
  await deliver(key, send);
}
export async function retryHealthAlerts(send = sendTelegram): Promise<void> {
  for (const key of Object.keys(state())) await deliver(key, send);
}
export async function alertProviderReadiness(): Promise<void> {
  const r = providerReadiness();
  // Unknown on first boot is not a quota incident. A real availability error
  // makes the operational failure actionable; don't create a repair ticket
  // for routine subscription exhaustion.
  if (!r.ready && r.providers.some(p => p.status === "blocked")) {
    await healthAlert("providers", true, `⚠️ Repair capability unavailable. ${r.providers.map(p => `${p.provider}: ${p.status}${p.retryAt ? `; retry ${p.retryAt}` : ""}`).join(". ")}. VM is alive; provider quota/authentication needs attention.`);
  } else if (r.ready) await healthAlert("providers", false, "✅ Repair capability recovered: a subscription provider completed a real turn successfully.");
}
export function startHealthAlertRetry(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void retryHealthAlerts().catch(err => console.error("[health-alert] retry failed:", err));
  }, 60_000);
  timer.unref();
  return timer;
}
