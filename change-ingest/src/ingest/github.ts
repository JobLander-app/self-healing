/**
 * GitHub PR-merge poller (§3.3). For each tracked repo, GET closed PRs sorted
 * by updated desc, keep those merged after the cursor, map via githubExtract.
 *
 * FAIL OPEN, exactly like dispatcher/src/poller.ts: a network error, a non-2xx,
 * a rate-limit, or a malformed body yields [] for that repo — never a throw
 * into the cron loop. A missed tick self-heals next poll (idempotent id upsert).
 */

import { config, resolveGithubToken } from "../config";
import { GithubPr, githubExtract } from "../extract";
import { ExtractedChange } from "../model";

const FETCH_TIMEOUT_MS = 10_000;
const PER_PAGE = 30;
// Safety cap on pages per repo per tick (PER_PAGE * MAX_PAGES = 300 closed PRs).
// A tick that hits this is logged, never silently truncated — the cursor still
// advances to the oldest scanned page, so the next tick continues from there.
const MAX_PAGES = 10;

async function fetchClosedPrsPage({
  owner,
  repo,
  token,
  page,
}: {
  owner: string;
  repo: string;
  token: string;
  page: number;
}): Promise<GithubPr[] | "rate-limited"> {
  const url =
    `${config.githubApiBase}/repos/${owner}/${repo}/pulls` +
    `?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "self-healing-change-ingest",
      },
      signal: controller.signal,
    });
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      console.error(`[ingest:github] ${owner}/${repo} rate-limited — skipping tick (fail open)`);
      return "rate-limited";
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${owner}/${repo}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error(`GitHub: non-array pulls body for ${owner}/${repo}`);
    return body as GithubPr[];
  } finally {
    clearTimeout(timer);
  }
}

/** Injectable so the pagination logic is unit-testable without live GitHub. */
export type PageFetcher = (args: {
  owner: string;
  repo: string;
  token: string;
  page: number;
}) => Promise<GithubPr[] | "rate-limited">;

/**
 * Fetch closed PRs for one repo, following pages (sorted updated desc) until we
 * pass `since`. Stopping on `updated_at <= since` is safe because the list is
 * ordered by update time: once a PR was last updated at/before the cursor, every
 * later page is older still. Without this a repo with >30 recently-updated
 * closed PRs would miss a merge on page 2, and a first page of only unmerged
 * closures would re-scan page 1 forever (Codex P2, PR #13).
 */
export async function collectMergedSince({
  owner,
  repo,
  token,
  since,
  fetchPage = fetchClosedPrsPage,
}: {
  owner: string;
  repo: string;
  token: string;
  since: number;
  fetchPage?: PageFetcher;
}): Promise<GithubPr[]> {
  const merged: GithubPr[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageResult = await fetchPage({ owner, repo, token, page });
    if (pageResult === "rate-limited") break;
    if (pageResult.length === 0) break; // past the last page

    let reachedCursor = false;
    for (const pr of pageResult) {
      const updatedAt = pr.updated_at ? Date.parse(pr.updated_at) : NaN;
      // Ordered updated-desc: the first PR at/older than the cursor means every
      // remaining PR (this page's tail + all later pages) is older → stop.
      if (Number.isFinite(updatedAt) && updatedAt <= since) {
        reachedCursor = true;
        break;
      }
      if (!pr.merged_at) continue;
      const mergedAt = Date.parse(pr.merged_at);
      if (Number.isNaN(mergedAt) || mergedAt <= since) continue;
      merged.push(pr);
    }

    if (reachedCursor) break;
    if (pageResult.length < PER_PAGE) break; // short page = last page
    if (page === MAX_PAGES) {
      console.warn(
        `[ingest:github] ${owner}/${repo} hit MAX_PAGES=${MAX_PAGES} (>${MAX_PAGES * PER_PAGE} closed PRs since cursor) — remaining older PRs drain on the next tick`,
      );
    }
  }
  return merged;
}

/**
 * Pull merged PRs across all tracked repos with `merged_at > since` (epoch ms).
 * Independent per repo — one repo's failure never drops another's results.
 */
export async function pull({ since }: { since: number }): Promise<ExtractedChange[]> {
  let token: string;
  try {
    token = await resolveGithubToken();
  } catch (err) {
    console.error("[ingest:github] token resolve failed (fail open):", err instanceof Error ? err.message : err);
    return [];
  }

  const out: ExtractedChange[] = [];
  for (const { owner, repo } of config.trackedRepos) {
    try {
      const prs = await collectMergedSince({ owner, repo, token, since });
      for (const pr of prs) out.push(githubExtract({ pr }));
    } catch (err) {
      console.error(`[ingest:github] ${owner}/${repo} pull failed (fail open):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
