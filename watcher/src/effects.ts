import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LINEAR, SECRETS, type WatchConfig } from "./config.js";
import { buildLinearTicket } from "./messages.js";
import type { TickEffects } from "./processSample.js";
import { saveStateFile } from "./state.js";

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
    ]);
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
  notifyOwner: async ({ message }) => {
    await execFileAsync("bash", [config.notifyScript, message]);
  },

  createLinearTicket: async ({ status, httpCode, regions }) => {
    const key = await secretReader({
      secret: SECRETS.linearKey,
      project: config.project,
    });
    if (key === null) return; // bash skips silently when the key is empty
    const { title, description } = buildLinearTicket({ status, httpCode, regions });
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: LINEAR_MUTATION,
        variables: {
          i: {
            teamId: LINEAR.jobTeam,
            title,
            description,
            labelIds: [LINEAR.lblMonitor, LINEAR.lblBug, LINEAR.lblRepoBackend],
            priority: 1,
          },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`linear issueCreate HTTP ${response.status}`);
    }
  },

  triggerDispatcher: async () => {
    const token =
      config.dispatchToken ??
      (await secretReader({
        secret: SECRETS.triggerToken,
        project: config.project,
      })) ??
      "";
    await fetch(config.triggerUrl, {
      method: "POST",
      headers: { "X-Dispatch-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
  },

  saveState: async ({ state }) => {
    await saveStateFile({ path: config.stateFile, state });
  },

  log: ({ line }) => {
    console.log(line);
  },
});
