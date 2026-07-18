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

async function fetchClosedPrs({
  owner,
  repo,
  token,
}: {
  owner: string;
  repo: string;
  token: string;
}): Promise<GithubPr[]> {
  const url =
    `${config.githubApiBase}/repos/${owner}/${repo}/pulls` +
    `?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}`;
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
      return [];
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${owner}/${repo}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new Error(`GitHub: non-array pulls body for ${owner}/${repo}`);
    return body as GithubPr[];
  } finally {
    clearTimeout(timer);
  }
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
      const prs = await fetchClosedPrs({ owner, repo, token });
      for (const pr of prs) {
        if (!pr.merged_at) continue;
        const mergedAt = Date.parse(pr.merged_at);
        if (Number.isNaN(mergedAt) || mergedAt <= since) continue;
        out.push(githubExtract({ pr }));
      }
    } catch (err) {
      console.error(`[ingest:github] ${owner}/${repo} pull failed (fail open):`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}
