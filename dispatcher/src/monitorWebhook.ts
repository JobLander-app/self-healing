import { Router, json } from "express";
import { OAuth2Client, TokenPayload } from "google-auth-library";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isDeploymentInProgress } from "./deployment";

export interface MonitorIngress {
  audience: string;
  email: string;
  subscription: string;
  project: string;
  stateFile: string;
}
interface QueueState {
  version: 1;
  generation: number;
  pending: boolean;
  dueAt: number;
  followUp: boolean;
  nextAllowedAt: number;
  seen: Record<string, number>;
  lastAcceptedAt?: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastExitCode?: number;
}
const INTERVAL = 300_000;
const identityClient = new OAuth2Client();

/** One durable wake-up batch. Bodies contain hints, never commands or evidence.
 * The existing monitor re-reads trusted sources and owns all filing decisions.
 */
export class MonitorWakeups {
  private state: QueueState;
  private running = false;
  constructor(private file: string, private run: () => Promise<number>, private now = Date.now) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
      version: 1, generation: 0, pending: false, dueAt: 0, followUp: false, nextAllowedAt: 0, seen: {},
    };
    // Corrupt state must fail closed, never discard an acknowledged wake-up.
    const s = this.state;
    if (s.version !== 1 || !Number.isSafeInteger(s.generation) || s.generation < 0 ||
        typeof s.pending !== "boolean" || typeof s.followUp !== "boolean" ||
        !Number.isFinite(s.dueAt) || !Number.isFinite(s.nextAllowedAt) ||
        !s.seen || typeof s.seen !== "object" || Array.isArray(s.seen) ||
        Object.values(s.seen).some(at => !Number.isFinite(at))) throw new Error("Invalid monitor wake-up state");
  }
  private save(next: QueueState): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const directory = openSync(dirname(this.file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    this.state = next;
  }
  accept(id: string): boolean {
    const now = this.now();
    if (this.state.seen[id] !== undefined) return false;
    const seen = Object.fromEntries(Object.entries(this.state.seen)
      .filter(([, at]) => now - at < 86_400_000).slice(-511));
    seen[id] = now;
    this.save({ ...this.state, seen, generation: this.state.generation + 1, pending: true,
      dueAt: this.state.pending ? this.state.dueAt : Math.max(now + 10_000, this.state.nextAllowedAt),
      followUp: true, lastAcceptedAt: now });
    return true;
  }
  status(): Readonly<QueueState> & { running: boolean } {
    return { ...this.state, seen: {}, running: this.running };
  }
  async tick(): Promise<void> {
    if (this.running || !this.state.pending || this.now() < this.state.dueAt || isDeploymentInProgress()) return;
    this.running = true;
    try {
      const generation = this.state.generation;
      this.save({ ...this.state, lastStartedAt: this.now() });
      let code: number;
      try { code = await this.run(); } catch { code = 1; }
      const now = this.now();
      // Events accepted during a run remain pending. A successful first run also
      // schedules a second read: Logging may lag or the burst may still be growing.
      const more = this.state.generation !== generation;
      const pending = code !== 0 || more || this.state.followUp;
      const delay = code === 75 ? 30_000 : INTERVAL; // cron owns the shared flock
      this.save({ ...this.state, pending, dueAt: pending ? now + delay : 0,
        nextAllowedAt: now + INTERVAL, followUp: code !== 0 || more ? this.state.followUp : false,
        lastFinishedAt: now, lastExitCode: code });
      console.log("MONITOR_WEBHOOK_RUN " + JSON.stringify({ code, pending, generation }));
    } finally { this.running = false; }
  }
}

export function validIdentity(payload: TokenPayload | undefined, options: MonitorIngress): boolean {
  return !!payload && payload.aud === options.audience && payload.email === options.email &&
    payload.email_verified === true && ["accounts.google.com", "https://accounts.google.com"].includes(payload.iss);
}

export function parseWakeup(body: unknown, options: MonitorIngress): string | null {
  const b = body as { subscription?: string; message?: { messageId?: unknown; data?: unknown } } | null;
  if (!b || b.subscription !== options.subscription || !b.message ||
      typeof b.message.messageId !== "string" || !/^\d{1,80}$/.test(b.message.messageId) ||
      typeof b.message.data !== "string" || b.message.data.length > 2_000_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(b.message.data)) throw new Error("Invalid Pub/Sub envelope");
  const value = JSON.parse(Buffer.from(b.message.data, "base64").toString("utf8"));
  // The probe exercises transport + the real collector without inventing an error.
  if (value?.kind === "monitor-wakeup" && value.project === options.project) return b.message.messageId;
  // Cloud Logging exports each LogEntry as JSON. Contents are only a wake-up;
  // the collector independently reads its configured project and service scope.
  if (typeof value?.logName === "string" && value.logName.startsWith(`projects/${options.project}/logs/`) &&
      value.resource?.labels?.project_id === options.project &&
      ["cloud_run_revision", "cloud_function"].includes(value.resource?.type)) return b.message.messageId;
  const incident = value?.incident;
  if (!incident || incident.scoping_project_id !== options.project ||
      !["open", "closed"].includes(incident.state)) throw new Error("Invalid Monitoring incident");
  return incident.state === "open" ? b.message.messageId : null;
}

export function monitorRouter(options: MonitorIngress, queue: MonitorWakeups,
  verify = async (token: string) => (await identityClient.verifyIdToken({
    idToken: token, audience: options.audience,
  })).getPayload()): Router {
  const router = Router();
  router.post("/", async (req, res, next) => {
    const match = /^Bearer ([^\s]+)$/.exec(req.header("authorization") || "");
    if (!match) { res.sendStatus(401); return; }
    try {
      if (!validIdentity(await verify(match[1]), options)) { res.sendStatus(403); return; }
    } catch { res.sendStatus(401); return; }
    next();
  }, json({ limit: "2mb" }), (req, res) => {
    let id: string | null;
    try { id = parseWakeup(req.body, options); }
    catch { res.sendStatus(400); return; }
    try {
      if (id) queue.accept(id); // fsync BEFORE acknowledging Pub/Sub
      res.sendStatus(204);
    } catch {
      console.error("MONITOR_WEBHOOK_ERROR durable acceptance failed");
      res.sendStatus(503); // Pub/Sub retries; the hourly monitor remains independent
    }
  });
  return router;
}

export function configuredMonitorIngress(): MonitorIngress | null {
  const audience = process.env.MONITOR_WEBHOOK_AUDIENCE;
  if (!audience) return null;
  const email = process.env.MONITOR_WEBHOOK_EMAIL || "";
  const subscription = process.env.MONITOR_WEBHOOK_SUBSCRIPTION || "";
  const project = process.env.GCP_PROJECT || "";
  if (!audience.startsWith("https://") || !email.endsWith(".iam.gserviceaccount.com") ||
      !subscription.startsWith(`projects/${project}/subscriptions/`) || !process.env.MONITOR_STATE_DIR) {
    throw new Error("Incomplete monitor webhook configuration");
  }
  return { audience, email, subscription, project,
    stateFile: resolve(process.env.MONITOR_STATE_DIR, "webhook-queue.json") };
}

export function runTriggeredMonitor(): Promise<number> {
  return new Promise(resolveCode => {
    // Fixed executable + arguments; no webhook contents enter the child process.
    const child = spawn("bash", [resolve(__dirname, "../../monitor/run-monitor-session.sh"), "--trigger", "webhook"], {
      stdio: "inherit", env: process.env,
    });
    child.once("error", () => resolveCode(1));
    child.once("exit", code => resolveCode(code ?? 1));
    const timeout = setTimeout(() => child.kill("SIGTERM"), 35 * 60_000);
    child.once("close", () => clearTimeout(timeout));
  });
}
