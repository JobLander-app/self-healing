import { buildQueueFilter, selectCandidate, type QueueIssue, type SelectedCandidate } from "./queue";

const QUERY = `query DispatcherQueue($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id identifier title description priority createdAt updatedAt
      state { name }
      labels { nodes { name } }
      children(first: 1) { nodes { id } }
    }
  }
}`;

function isIssue(value: unknown): value is QueueIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as QueueIssue;
  return [issue.id, issue.identifier, issue.title, issue.createdAt, issue.updatedAt]
    .every((field) => typeof field === "string" && field.length > 0) &&
    (issue.description === null || typeof issue.description === "string") &&
    typeof issue.priority === "number" && typeof issue.state?.name === "string" &&
    Array.isArray(issue.labels?.nodes) && issue.labels.nodes.every((label) => typeof label?.name === "string") &&
    Array.isArray(issue.children?.nodes);
}

/** Read-only selection: drain every page before sorting so page order cannot starve old urgent issues. */
export async function readCandidate({
  key, team, staleClaimBefore, fetchImpl = fetch,
}: {
  key: string;
  team: string;
  staleClaimBefore: string;
  fetchImpl?: typeof fetch;
}): Promise<SelectedCandidate | null> {
  const filter = buildQueueFilter(team, staleClaimBefore);
  const issues: QueueIssue[] = [];
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(60_000);
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: QUERY, variables: { filter, after } }),
      signal,
    });
    if (!response.ok) throw new Error(`Linear queue HTTP ${response.status}`);
    const body = await response.json() as {
      data?: { issues?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      errors?: unknown[];
    };
    if (body.errors?.length) throw new Error("Linear queue GraphQL errors");
    const result = body.data?.issues;
    if (!Array.isArray(result?.nodes) || !result.nodes.every(isIssue) ||
        typeof result.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("Linear queue malformed response");
    }
    issues.push(...result.nodes);
    if (!result.pageInfo.hasNextPage) return selectCandidate(issues, staleClaimBefore);
    const cursor = result.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Linear queue pagination did not advance");
    cursors.add(cursor);
    after = cursor;
  }
  throw new Error("Linear queue pagination limit reached; refusing an incomplete selection");
}
