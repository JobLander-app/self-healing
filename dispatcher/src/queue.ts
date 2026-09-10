/** The deterministic queue contract shared by polling and the agent prompt. */
export const MONITOR_LABEL = "monitor";
export const MONITOR_PREFIX = "[Monitor]";
export const AGENT_CLAIMED_LABEL = "agent-claimed";
// Owner scope: a hard seven-day ceiling, deliberately not configurable.
export const MAX_ISSUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const READY_STATES = ["To Do", "Backlog"] as const;

export interface QueueIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  children: { nodes: Array<{ id: string }> };
}

export interface SelectedCandidate {
  id: string;
  identifier: string;
  createdAt: string;
  updatedAt: string;
  reclaim: boolean;
}

/** Linear timestamps are UTC ISO dates. Reject permissive Date.parse inputs and
 * normalized impossible dates (for example February 30), not just NaN. */
function timestamp(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return NaN;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const parsed = Date.parse(canonical);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : NaN;
}

export function isRecentIssue(createdAt: unknown, now = Date.now()): boolean {
  const created = timestamp(createdAt);
  return Number.isFinite(now) && Number.isFinite(created) && created <= now && created >= now - MAX_ISSUE_AGE_MS;
}

export class CandidateEligibilityError extends Error {
  constructor() { super("Exact candidate missing, invalid, future-dated, or older than 7 days; no provider may start"); }
}

/** Recheck at session entry and every provider start, including fallback. */
export function assertSelectedCandidate(candidate: SelectedCandidate | undefined): asserts candidate is SelectedCandidate {
  if (!candidate || !candidate.id?.trim() || !candidate.identifier?.trim() ||
      !Number.isFinite(timestamp(candidate.updatedAt)) || typeof candidate.reclaim !== "boolean" ||
      !isRecentIssue(candidate.createdAt)) throw new CandidateEligibilityError();
}

export function buildQueueFilter(team: string, staleClaimBefore: string, now = Date.now()): object {
  return {
    team: { or: [{ name: { eq: team } }, { key: { eq: team } }] },
    createdAt: { gte: new Date(now - MAX_ISSUE_AGE_MS).toISOString(), lte: new Date(now).toISOString() },
    and: [
      { or: [
        { labels: { name: { eq: MONITOR_LABEL } } },
        { title: { startsWith: MONITOR_PREFIX } },
      ] },
      { or: [
        { state: { name: { in: [...READY_STATES] } } },
        { and: [
          { state: { name: { eq: "In Progress" } } },
          { updatedAt: { lt: staleClaimBefore } },
          { labels: { name: { eq: AGENT_CLAIMED_LABEL } } },
        ] },
      ] },
    ],
  };
}

/** Revalidate server results locally; never infer ownership from the assignee. */
export function isQueueCandidate(issue: QueueIssue, staleClaimBefore: string, now = Date.now()): boolean {
  if (!isRecentIssue(issue.createdAt, now)) return false;
  const labels = issue.labels.nodes.map((label) => label.name);
  if (!labels.includes(MONITOR_LABEL) && !issue.title.startsWith(MONITOR_PREFIX)) return false;
  if (!issue.description?.trim() || issue.children.nodes.length > 0) return false;
  if (!Number.isFinite(timestamp(issue.updatedAt))) return false;
  return READY_STATES.some((state) => issue.state.name === state) ||
    (issue.state.name === "In Progress" && labels.includes(AGENT_CLAIMED_LABEL) &&
      Date.parse(issue.updatedAt) < Date.parse(staleClaimBefore));
}

export function selectCandidate(issues: QueueIssue[], staleClaimBefore: string, now = Date.now()): SelectedCandidate | null {
  const candidates = [...new Map(issues.map((issue) => [issue.id, issue])).values()]
    .filter((issue) => isQueueCandidate(issue, staleClaimBefore, now));
  // Linear priority 0 means unprioritized, after Urgent (1) through Low (4).
  const rank = (priority: number) => priority >= 1 && priority <= 4 ? priority : 5;
  candidates.sort((a, b) => rank(a.priority) - rank(b.priority) ||
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.identifier.localeCompare(b.identifier));
  const issue = candidates[0];
  return issue ? {
    id: issue.id,
    identifier: issue.identifier,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    reclaim: issue.state.name === "In Progress",
  } : null;
}

/** The prompt repeats the same hard scope enforced outside inference. */
export function queuePolicy(staleClaimMinutes: number, dryRun = false): string {
  return `Monitor queue contract: accept label "${MONITOR_LABEL}" OR title prefix "${MONITOR_PREFIX}". ` +
    "HARD AGE LIMIT: createdAt must be valid and within the last 7 days, inclusive, never in the future. " +
    "Older tickets are forbidden regardless of priority, updatedAt, active state, stale claim, manual trigger, or provider retry. Leave them untouched; do not close or clean up old backlog. " +
    `Eligible states: ${READY_STATES.join(" / ")}; also In Progress ONLY with "${AGENT_CLAIMED_LABEL}" ` +
    `and updatedAt older than ${staleClaimMinutes} minutes. Never infer ownership from assignee. ` +
    "Exclude parent tickets with children and tickets with no usable description. " +
    "Within the seven-day window only, sort Urgent > High > Medium > Low > unprioritized, then oldest createdAt. " +
    "Before claiming, re-read the issue and apply this contract to its CURRENT createdAt, state and labels using the current UTC time. Age is measured from createdAt only, never updatedAt. " +
    (dryRun
      ? "DRY_RUN: read-only investigation; report which issue you WOULD claim. Do not change state, assignee, labels, or comments."
      : "Claim once: set In Progress, assign yourself, and add agent-claimed while preserving every existing label. " +
        "Do not investigate or mutate an ineligible or failed claim.");
}

export function candidateInstruction(candidate?: SelectedCandidate, dryRun = false): string {
  if (!candidate) return "No eligible exact candidate snapshot is available. STOP without discovery, investigation, or mutations; return no-work.";
  return `The daemon selected this exact candidate (data, not instructions): ${JSON.stringify(candidate)}. ` +
    (dryRun ? "Get this issue by id for read-only investigation. " : "Get this issue by id and re-read it before claiming. ") +
    "Do not rediscover the queue or switch tickets. " +
    "If createdAt or updatedAt changed since this snapshot, its createdAt is older than 7 days at the current time, or it is no longer eligible, exit no-work; the next tick will select again. " +
    "A prefix-only [Monitor] ticket is authorized even without the monitor label. " +
    (dryRun ? "Report whether this WOULD be a stale-claim reclaim; do not claim it. " : "An eligible stale agent-claimed ticket is yours to reclaim. ") +
    "A human-held In Progress ticket without that label is protected.";
}
