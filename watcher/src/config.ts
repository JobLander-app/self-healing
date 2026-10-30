/** Runtime configuration supplied by a consumer profile. */
import { homedir } from "node:os";
export interface WatchConfig {
  url: string;
  path?: string;
  project: string;
  threshold: number;
  stateFile: string;
  notifyScript: string;

  tgEnvFile: string;
  triggerUrl: string;
  /** DISPATCH_TOKEN env override (falls back to Secret Manager when unset). */
  dispatchToken: string | null;

  metricsFile: string;
  dryRun: boolean;
  forceBad: boolean;
}

/** Routing shared with the dispatcher through the consumer profile. */
export const LINEAR = {
  teamId: process.env.LINEAR_TEAM_ID || "",
  labels: (process.env.WATCH_LABEL_IDS || process.env.LINEAR_MONITOR_LABEL_ID || "").split(",").filter(Boolean),
} as const;

export const SECRETS = {
  hmacKey: process.env.WATCH_HMAC_SECRET || "self-healing-output-hmac",
  linearKey: process.env.LINEAR_API_KEY_SECRET || "linear-api-key",
  triggerToken: "self-healing-trigger-token",
} as const;

const parseThreshold = ({ raw }: { raw: string | undefined }): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
};

export const readConfig = ({ env }: { env: NodeJS.ProcessEnv }): WatchConfig => ({
  url: env.WATCH_URL ?? "",
  path: env.WATCH_PATH ?? "/health/output?window_min=30",
  project: env.WATCH_PROJECT ?? env.GCP_PROJECT ?? "",
  threshold: parseThreshold({ raw: env.WATCH_THRESHOLD }),
  stateFile: env.WATCH_STATE_FILE ?? `${homedir()}/.output-watch-state`,
  notifyScript:
    env.WATCH_NOTIFY_SCRIPT ?? "",
  tgEnvFile: env.WATCH_TG_ENV_FILE ?? `${homedir()}/.config/self-healing/telegram.env`,
  triggerUrl: env.WATCH_TRIGGER_URL ?? "http://localhost:4100/trigger",
  dispatchToken:
    env.DISPATCH_TOKEN !== undefined && env.DISPATCH_TOKEN.length > 0
      ? env.DISPATCH_TOKEN
      : null,
  metricsFile:
    env.WATCH_METRICS_FILE ?? "/var/lib/node_exporter/textfile/selfheal_watcher.prom",
  dryRun: env.DRY_RUN !== "false" && env.DRY_RUN !== "0",
  forceBad: env.FORCE_BAD === "1",
});
