/**
 * Linear issue-status poller (§3.4). Reuses `linear-api-key` and the EXACT
 * GraphQL-over-fetch pattern from dispatcher/src/poller.ts::precheckCandidates
 * (10s abort, fail-open). Query issues updatedAt > cursor that reached a
 * terminal state (Done/Canceled) and emit `issue_status` ChangeEvents carrying
 * title + description + closing comment.
 *
 * FAIL OPEN: any error → [] (never a throw into the cron loop).
 */

import { config, resolveLinearApiKey } from "../config";
import { LinearIssueNode, linearExtract } from "../extract";
import { ExtractedChange } from "../model";

const FETCH_TIMEOUT_MS = 10_000;
const PAGE = 50;

const QUERY = `query IngestLinear($filter: IssueFilter!, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {
      identifier
      title
      description
      updatedAt
      completedAt
      canceledAt
      state { name type }
      assignee { name displayName }
      labels { nodes { name } }
      comments(last: 1) { nodes { body } }
    }
  }
}`;

interface LinearGqlNode {
  identifier: string;
  title?: string;
  description?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: { name?: string; displayName?: string } | null;
  labels?: { nodes?: { name?: string }[] } | null;
  comments?: { nodes?: { body?: string }[] } | null;
}

/**
 * Pull terminal-state Linear issues with `updatedAt > since` (epoch ms). The
 * closing comment (last comment on the issue) is folded into the node so
 * linearExtract can inline it in intent_text.
 */
export async function pull({ since }: { since: number }): Promise<ExtractedChange[]> {
  let key: string;
  try {
    key = await resolveLinearApiKey();
  } catch (err) {
    console.error("[ingest:linear] key resolve failed (fail open):", err instanceof Error ? err.message : err);
    return [];
  }

  const filter = {
    team: { or: [{ name: { eq: config.linearTeam } }, { key: { eq: config.linearTeam } }] },
    updatedAt: { gt: new Date(since).toISOString() },
    state: { type: { in: ["completed", "canceled"] } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(config.linearApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: QUERY, variables: { filter, first: PAGE } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { issues?: { nodes?: LinearGqlNode[] } };
      errors?: unknown[];
    };
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    }
    const nodes = body.data?.issues?.nodes;
    if (!Array.isArray(nodes)) throw new Error("Linear: malformed response shape");

    return nodes.map((n) => {
      const issue: LinearIssueNode = {
        identifier: n.identifier,
        title: n.title,
        description: n.description,
        updatedAt: n.updatedAt,
        completedAt: n.completedAt,
        canceledAt: n.canceledAt,
        state: n.state,
        assignee: n.assignee,
        labels: n.labels,
        closingComment: n.comments?.nodes?.[0]?.body ?? null,
      };
      return linearExtract({ issue });
    });
  } catch (err) {
    console.error("[ingest:linear] pull failed (fail open):", err instanceof Error ? err.message : err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
