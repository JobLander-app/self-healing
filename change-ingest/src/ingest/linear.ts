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
// Safety cap on pages per tick (PAGE * MAX_PAGES = 2500 issues). A 72h window of
// completed/canceled issues is far below this; hitting it is logged, and the
// cursor is held (not advanced) so nothing is skipped (Codex P2, PR #13).
const MAX_PAGES = 50;

const QUERY = `query IngestLinear($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
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

/** One page fetch — throws on transport/GraphQL error (caught by pull's loop). */
async function fetchPage({
  key,
  filter,
  after,
}: {
  key: string;
  filter: unknown;
  after: string | null;
}): Promise<{ nodes: LinearGqlNode[]; hasNextPage: boolean; endCursor: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(config.linearApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: QUERY, variables: { filter, first: PAGE, after } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { issues?: { nodes?: LinearGqlNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      errors?: unknown[];
    };
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Linear GraphQL errors: ${JSON.stringify(body.errors).slice(0, 300)}`);
    }
    const issues = body.data?.issues;
    if (!issues || !Array.isArray(issues.nodes)) throw new Error("Linear: malformed response shape");
    return {
      nodes: issues.nodes,
      hasNextPage: issues.pageInfo?.hasNextPage ?? false,
      endCursor: issues.pageInfo?.endCursor ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull terminal-state Linear issues with `updatedAt > since` (epoch ms),
 * following `pageInfo.after` until the whole window is drained. Without full
 * pagination a >50-issue backfill would read only the first page and advance the
 * cursor off a partial result, dropping older decommission/decision tickets
 * (Codex P2, PR #13). The closing comment (last comment) is folded into each node
 * so linearExtract can inline it in intent_text.
 *
 * nextCursor: on a FULLY drained window, the max `updatedAt` ingested is safe
 * (everything > since is in). If the MAX_PAGES safety cap is hit (pathological),
 * hold the cursor at `since` and re-drain next tick — never advance past unread.
 */
export async function pull({ since }: { since: number }): Promise<{ changes: ExtractedChange[]; nextCursor: number }> {
  let key: string;
  try {
    key = await resolveLinearApiKey();
  } catch (err) {
    console.error("[ingest:linear] key resolve failed (fail open):", err instanceof Error ? err.message : err);
    return { changes: [], nextCursor: since };
  }

  const filter = {
    team: { or: [{ name: { eq: config.linearTeam } }, { key: { eq: config.linearTeam } }] },
    updatedAt: { gt: new Date(since).toISOString() },
    state: { type: { in: ["completed", "canceled"] } },
  };

  const pullStart = Date.now();
  const changes: ExtractedChange[] = [];
  let after: string | null = null;
  let drained = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { nodes, hasNextPage, endCursor }: { nodes: LinearGqlNode[]; hasNextPage: boolean; endCursor: string | null } =
        await fetchPage({ key, filter, after });
      for (const n of nodes) {
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
        changes.push(linearExtract({ issue }));
      }
      if (!hasNextPage || !endCursor) {
        drained = true;
        break;
      }
      after = endCursor;
      if (page === MAX_PAGES - 1) {
        console.warn(
          `[ingest:linear] hit MAX_PAGES=${MAX_PAGES} (>${MAX_PAGES * PAGE} issues since cursor) — holding cursor, re-draining next tick`,
        );
      }
    }
  } catch (err) {
    console.error("[ingest:linear] pull failed (fail open):", err instanceof Error ? err.message : err);
    // Partial result: keep what we ingested (idempotent) but do NOT advance the
    // cursor past a window we could not fully read.
    return { changes, nextCursor: since };
  }

  // Advance the cursor in the SAME field the filter uses (updatedAt), NOT the
  // effective event.ts (completedAt/canceledAt) — a terminal issue edited after
  // it closed has updatedAt in-window but completedAt <= since, which would pin
  // the cursor and re-fetch it forever (Codex P2, PR #13). A fully drained window
  // means everything with updatedAt > since up to the poll start is ingested, so
  // the poll start is the correct high-water mark; a capped run holds at `since`.
  return { changes, nextCursor: drained ? pullStart : since };
}
