import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LINEAR, SECRETS, type WatchConfig } from "./config.js";
import { buildLinearTicket } from "./messages.js";
import { writeWatcherMetrics } from "./metricsFile.js";
import type { TickEffects } from "./processSample.js";
import { saveStateFile } from "./state.js";
import { buildNotifyOwner } from "./telegram.js";

const execFileAsync = promisify(execFile);

/**
 * Secret access — same mechanism as bash (`gcloud secrets versions access`
 * subprocess, no SDK deps). Returns null on any failure / empty value.
 */
export type SecretReader = (input: {
  secret: string;
  project: string;
}) => Promise<string | null>;

export const gcloudSecretReader: SecretReader = async ({ secret, project }) => {
  try {
    const { stdout } = await execFileAsync("gcloud", [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${secret}`,
      "--project",
      project,
    ], { timeout: 15_000 });
    // Mirror bash `$(...)`: strip trailing newlines only.
    const value = stdout.replace(/\n+$/, "");
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

const LINEAR_MUTATION =
  "mutation($i:IssueCreateInput!){issueCreate(input:$i){success issue{identifier}}}";

/** Real effects wiring for prod. Tests inject their own TickEffects. */
export const buildRealEffects = ({
  config,
  secretReader,
}: {
  config: WatchConfig;
  secretReader: SecretReader;
}): TickEffects => ({
  // JOB-731: direct plain-text Telegram send (no parse_mode), notify.sh as
  // fallback, PAGE_FAILED log when both fail — see telegram.ts.
  notifyOwner: buildNotifyOwner({ config, env: process.env }),

  createLinearTicket: async ({ incidentId, status, httpCode, regions }) => {
    const key = await secretReader({
      secret: SECRETS.linearKey,
      project: config.project,
    });
    if (key === null) throw new Error("Linear credential unavailable");
    const gql = async <T>(query: string, variables: unknown): Promise<T> => {
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
      const body = await response.json() as { errors?: unknown[]; data?: unknown };
      if (body.errors?.length || !body.data) throw new Error("Linear GraphQL request failed");
      return body.data as T;
    };
    // Query by immutable client-generated UUID before every create. A response
    // timeout after commit is reconciled on the next attempt, with no duplicate.
    const existing = await gql<{ issues?: { nodes?: { identifier?: string }[] } }>("query($id:ID!){issues(filter:{id:{eq:$id}},first:1){nodes{identifier}}}", { id: incidentId });
    if (!Array.isArray(existing.issues?.nodes)) throw new Error("Malformed Linear lookup response");
    if (existing.issues.nodes[0]?.identifier) return existing.issues.nodes[0].identifier as string;
    const { title, description } = buildLinearTicket({ status, httpCode, regions });
    const created = await gql<{ issueCreate?: { success?: boolean; issue?: { identifier?: string } } }>(LINEAR_MUTATION, { i: { id: incidentId, teamId: LINEAR.jobTeam,
      title, description: `${description}\n\nWatcher incident: ${incidentId}`,
      labelIds: [LINEAR.lblMonitor, LINEAR.lblBug, LINEAR.lblRepoBackend], priority: 1 } });
    if (created.issueCreate?.success !== true || !created.issueCreate.issue?.identifier) {
      throw new Error("Linear issueCreate did not confirm success");
    }
    return created.issueCreate.issue.identifier as string;
  },

  triggerDispatcher: async ({ incidentId }) => {
    const token = config.dispatchToken ?? await secretReader({ secret: SECRETS.triggerToken, project: config.project });
    if (!token) throw new Error("Dispatcher trigger credential unavailable");
    const response = await fetch(config.triggerUrl, { method: "POST",
      headers: { "X-Dispatch-Token": token, "Idempotency-Key": `output-watch:${incidentId}` },
      signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Dispatcher trigger HTTP ${response.status}`);
  },

  saveState: async ({ state }) => {
    await saveStateFile({ path: config.stateFile, state });
  },

  log: ({ line }) => {
    console.log(line);
  },

  // JOB-731: Prometheus textfile write. writeWatcherMetrics is itself fail-soft
  // (skips when the node_exporter textfile dir is absent, never throws).
  writeMetrics: async ({ detectorOk, consecutiveBad, pagedThisTick, recoveredThisTick, pendingActions }) => {
    await writeWatcherMetrics({
      path: config.metricsFile,
      now: Date.now(),
      detectorOk,
      consecutiveBad,
      pagedThisTick,
      recoveredThisTick,
      pendingActions,
    });
  },
});
