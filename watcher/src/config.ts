/** Env-driven config with the same defaults as watcher/output-watch.sh. */
export interface WatchConfig {
  url: string;
  project: string;
  threshold: number;
  stateFile: string;
  notifyScript: string;
  triggerUrl: string;
  /** DISPATCH_TOKEN env override (falls back to Secret Manager when unset). */
  dispatchToken: string | null;
  dryRun: boolean;
  forceBad: boolean;
}

/** Linear routing — identical IDs to the bash watcher. */
export const LINEAR = {
  jobTeam: "b12df7a0-4845-47fd-be59-8f6d03d9ae8d",
  lblMonitor: "3cf3f731-dccf-43fa-861e-cba73998b183",
  lblBug: "1d25b456-393f-4567-9980-e1bb98d3b069",
  lblRepoBackend: "636d11e1-7544-4755-bd8d-2446b248a9c6",
} as const;

export const SECRETS = {
  hmacKey: "HEALTH_OUTPUT_HMAC_KEY",
  linearKey: "linear-api-key",
  triggerToken: "self-healing-trigger-token",
} as const;

const parseThreshold = ({ raw }: { raw: string | undefined }): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
};

export const readConfig = ({ env }: { env: NodeJS.ProcessEnv }): WatchConfig => ({
  url: env.WATCH_URL ?? "https://joblander-audio-engine-p26anqucmq-ew.a.run.app",
  project: env.WATCH_PROJECT ?? "meet-assistant-6d8ad",
  threshold: parseThreshold({ raw: env.WATCH_THRESHOLD }),
  stateFile: env.WATCH_STATE_FILE ?? "/home/joblander/.output-watch-state",
  notifyScript:
    env.WATCH_NOTIFY_SCRIPT ?? "/home/joblander/joblander/workspace/scripts/notify.sh",
  triggerUrl: env.WATCH_TRIGGER_URL ?? "http://localhost:4100/trigger",
  dispatchToken:
    env.DISPATCH_TOKEN !== undefined && env.DISPATCH_TOKEN.length > 0
      ? env.DISPATCH_TOKEN
      : null,
  dryRun: env.DRY_RUN === "1",
  forceBad: env.FORCE_BAD === "1",
});
