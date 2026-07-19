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

export interface RepoScan {
  /** Merged PRs with merged_at > since, across all scanned pages. */
  merged: GithubPr[];
  /** True iff we stopped because MAX_PAGES was hit (or a rate-limit) WITHOUT
   *  reaching the cursor — i.e. older un-scanned PRs may remain. When capped, the
   *  caller must NOT advance the cursor at all: because we page newest-first from
   *  `now`, ANY forward cursor (even the oldest we scanned) would make the next
   *  scan stop above the un-scanned older PRs and skip them permanently (Codex
   *  P2, PR #13). The cursor stays at `since` and the newest page is re-ingested
   *  (idempotent) each tick until the burst clears. */
  capped: boolean;
}

/**
 * Fetch closed PRs for one repo, following pages (sorted updated desc) until we
 * pass `since`. Stopping on `updated_at <= since` is safe because the list is
 * ordered by update time: once a PR was last updated at/before the cursor, every
 * later page is older still. Without this a repo with >30 recently-updated
 * closed PRs would miss a merge on page 2, and a first page of only unmerged
 * closures would re-scan page 1 forever (Codex P2, PR #13).
 *
 * Returns `capped` so the caller keeps the shared cursor from advancing while a
 * repo's older PRs remain unscanned.
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
}): Promise<RepoScan> {
  const merged: GithubPr[] = [];
  let capped = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageResult = await fetchPage({ owner, repo, token, page });
    if (pageResult === "rate-limited") {
      // Rate-limited after some pages → older PRs may be unscanned → capped.
      capped = true;
      break;
    }
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
      capped = true;
      console.warn(
        `[ingest:github] ${owner}/${repo} hit MAX_PAGES=${MAX_PAGES} (>${MAX_PAGES * PER_PAGE} closed PRs since cursor) — cursor HELD at 'since'; newest page re-ingested each tick until the burst clears`,
      );
    }
  }
  return { merged, capped };
}

/**
 * Pull merged PRs across all tracked repos with `merged_at > since` (epoch ms).
 * Independent per repo — one repo's failure never drops another's results.
 *
 * The github cursor is shared across all repos, so it may only advance to a point
 * below which EVERY repo is fully covered. Because we page newest-first from `now`
 * with no server-side since-filter, a capped repo cannot drain its older tail via
 * any forward cursor, so it PINS the shared cursor at `since` (the newest page is
 * re-ingested idempotently each tick). Only when ALL repos fully drain does the
 * cursor advance to the poll start. Realistic 72h volume for these repos is far
 * below the cap, so the pin is a pathological-burst safeguard, always logged.
 */
export async function pull({ since }: { since: number }): Promise<{ changes: ExtractedChange[]; nextCursor: number }> {
  let token: string;
  try {
    token = await resolveGithubToken();
  } catch (err) {
    console.error("[ingest:github] token resolve failed (fail open):", err instanceof Error ? err.message : err);
    return { changes: [], nextCursor: since };
  }

  const pullStart = Date.now();
  const out: ExtractedChange[] = [];
  let allDrained = true; // becomes false if any repo is capped or fails

  for (const { owner, repo } of config.trackedRepos) {
    try {
      const scan = await collectMergedSince({ owner, repo, token, since });
      for (const pr of scan.merged) out.push(githubExtract({ pr }));
      if (scan.capped) allDrained = false;
    } catch (err) {
      console.error(`[ingest:github] ${owner}/${repo} pull failed (fail open):`, err instanceof Error ? err.message : err);
      // A failed repo's state is unknown → hold the cursor for safety.
      allDrained = false;
    }
  }

  // Advance only when every repo fully drained; otherwise hold at `since` so no
  // unscanned older merge is skipped.
  return { changes: out, nextCursor: allDrained ? pullStart : since };
}
