import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { config, LINEAR_API_KEY_SECRET, LINEAR_TEAM_ID } from "./config";
import type { SelectedCandidate } from "./queue";

type Linear = (query: string, variables: object) => Promise<any>;
const exec = promisify(execFile);
const file = () => path.join(path.dirname(config.logDir), "false-positive-outbox.json");
interface Decision { candidate: SelectedCandidate; reason: string; evidence: string[]; decidedAt: string }
interface Conflict { decision: Decision; reason: string; quarantinedAt: string }
class SnapshotConflict extends Error {}

export const linearRequest: Linear = async (query, variables) => {
  const key = process.env.LINEAR_API_KEY || (await exec("gcloud", ["secrets", "versions", "access", "latest",
    `--secret=${LINEAR_API_KEY_SECRET}`, `--project=${config.gcpProject}`], { timeout: 15_000 })).stdout.trim();
  const response = await fetch("https://api.linear.app/graphql", { method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as any;
  if (!response.ok || body.errors?.length || !body.data) throw new Error("Linear false-positive update failed");
  return body.data;
};

function read<T = Decision>(target = file()): Record<string, T> {
  if (!fs.existsSync(target)) return {};
  const data = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid false-positive outbox");
  return data;
}

function save(data: Record<string, unknown>, target = file()): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target + ".tmp", "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(target + ".tmp", target);
  const dir = fs.openSync(path.dirname(target), "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

/** Linear is the source of truth; the local file only retries interrupted writes. */
export async function applyFalsePositive(decision: Decision, request: Linear = linearRequest): Promise<void> {
  const { candidate, reason, evidence } = decision;
  if (reason.trim().length < 20 || !evidence.length || evidence.some(e => !e.trim())) {
    throw new Error("A false-positive verdict requires a reason and concrete evidence");
  }
  if (!Number.isFinite(Date.parse(decision.decidedAt))) throw new Error("Invalid false-positive decision time");
  const data = await request(`query($id:String!){issue(id:$id){id description priority team{id} labels{nodes{id name}}}}`, { id: candidate.id });
  const issue = data.issue;
  const signature = issue?.description?.match(/\*\*Signature:\*\*\s*\x60([^\x60\n]+)\x60/)?.[1];
  if (issue?.id !== candidate.id || issue.team?.id !== LINEAR_TEAM_ID ||
      signature !== candidate.signature || (candidate.priority && issue.priority !== candidate.priority)) {
    throw new SnapshotConflict("False-positive source ticket changed; refusing suppression");
  }
  const routing = await request(`query($team:ID!){issueLabels(filter:{name:{eq:"false-positive"}}){nodes{id team{id}}} workflowStates(filter:{team:{id:{eq:$team}},type:{eq:"canceled"}}){nodes{id}}}`, { team: issue.team.id });
  let label = routing.issueLabels.nodes.find((l: any) => !l.team || l.team.id === issue.team.id)?.id;
  if (!label) {
    const created = await request(`mutation($input:IssueLabelCreateInput!){issueLabelCreate(input:$input){success issueLabel{id}}}`,
      { input: { name: "false-positive", teamId: issue.team.id } });
    if (!created.issueLabelCreate?.success) throw new Error("Cannot create false-positive label");
    label = created.issueLabelCreate.issueLabel.id;
  }
  const state = routing.workflowStates.nodes[0]?.id;
  if (!state) throw new Error("Consumer team has no canceled workflow state");
  // One atomic update avoids duplicate comments and terminal tickets without labels
  // when the server commits a write but its response is lost.
  const marker = "<!-- self-healing:false-positive -->";
  const description = (issue.description || "").split(marker)[0].trimEnd() +
    `\n\n${marker}\n### False-positive decision\n**Verdict recorded at:** \`${decision.decidedAt}\`\n\n${reason}\n\nEvidence:\n` + evidence.map(e => `- ${e}`).join("\n");
  const labels = [...new Set([...issue.labels.nodes.filter((l: any) => l.name !== "agent-claimed").map((l: any) => l.id), label])];
  const changed = await request(`mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}`,
    { id: candidate.id, input: { stateId: state, labelIds: labels, description } });
  if (!changed.issueUpdate?.success) throw new Error("False-positive label/closure not confirmed");
}

let operation: Promise<void> = Promise.resolve();
function serialized(work: () => Promise<void>): Promise<void> {
  const next = operation.then(work);
  operation = next.catch(() => {});
  return next;
}

export async function closeFalsePositive(candidate: SelectedCandidate, reason: string, evidence: string[], request: Linear = linearRequest): Promise<void> {
  if (config.dryRun) return;
  if (reason.trim().length < 20 || !evidence.length || evidence.some(e => !e.trim())) throw new Error("A false-positive verdict requires reason and evidence");
  return serialized(async () => {
    const pending = read();
    pending[candidate.id] ??= { candidate, reason, evidence, decidedAt: new Date().toISOString() };
    save(pending);
    await applyFalsePositive(pending[candidate.id], request);
    delete pending[candidate.id];
    save(pending);
  });
}

/** Run before queue discovery, even if the ticket already moved to Canceled. */
export async function retryFalsePositives(request: Linear = linearRequest): Promise<void> {
  if (config.dryRun) return;
  return serialized(async () => {
    const pending = read();
    for (const [id, decision] of Object.entries(pending)) {
      // Upgrade older delivery files once; retries keep the same decision time.
      if (!decision.decidedAt) {
        decision.decidedAt = new Date().toISOString();
        save(pending);
      }
      try {
        await applyFalsePositive(decision, request);
      } catch (error) {
        if (!(error instanceof SnapshotConflict)) throw error;
        // Human edits invalidate this snapshot permanently. Preserve evidence
        // before removing it from retries, without blocking unrelated tickets.
        const destination = path.join(path.dirname(file()), "false-positive-conflicts.json");
        const conflicts = read<Conflict>(destination);
        conflicts[id] = { decision, reason: error.message, quarantinedAt: new Date().toISOString() };
        save(conflicts, destination);
        console.warn(`[false-positive] ${decision.candidate.identifier}: changed ticket; decision quarantined`);
      }
      delete pending[id];
      save(pending);
    }
  });
}
