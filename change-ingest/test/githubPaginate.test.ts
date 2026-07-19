/**
 * Pagination correctness for the GitHub puller (Codex P2, PR #13): a merge on
 * page 2 must be found, the scan must stop once it passes the cursor, and a
 * rate-limit must fail open — all without touching live GitHub (injected fetcher).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { collectMergedSince, PageFetcher } from "../src/ingest/github";
import { GithubPr } from "../src/extract";

const HOUR = 60 * 60 * 1000;

function pr({
  number,
  updatedMsAgo,
  mergedMsAgo,
}: {
  number: number;
  updatedMsAgo: number;
  mergedMsAgo: number | null;
}): GithubPr {
  const now = Date.now();
  return {
    number,
    title: `PR ${number}`,
    updated_at: new Date(now - updatedMsAgo).toISOString(),
    merged_at: mergedMsAgo === null ? null : new Date(now - mergedMsAgo).toISOString(),
    base: { repo: { name: "backend", full_name: "JobLander-app/backend", owner: { login: "JobLander-app" } } },
    merged_by: { login: "sorokinvj" },
  };
}

// 30 recently-updated but UNMERGED closures fill page 1; the real merge is on
// page 2. Pre-fix this merge was invisible (only page 1 was ever read).
test("collectMergedSince: finds a merge on page 2 behind a full page of unmerged closures", async () => {
  const page1: GithubPr[] = Array.from({ length: 30 }, (_v, i) =>
    pr({ number: 100 + i, updatedMsAgo: (i + 1) * 60_000, mergedMsAgo: null }),
  );
  const page2: GithubPr[] = [pr({ number: 262, updatedMsAgo: 40 * 60_000, mergedMsAgo: 45 * 60_000 })];

  const fetchPage: PageFetcher = async ({ page }) =>
    page === 1 ? page1 : page === 2 ? page2 : [];

  const merged = await collectMergedSince({
    owner: "JobLander-app",
    repo: "backend",
    token: "t",
    since: Date.now() - 72 * HOUR,
    fetchPage,
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].number, 262);
});

// The scan stops the moment a PR's updated_at is at/before the cursor — later
// (older) pages are never fetched, and older merges are excluded.
test("collectMergedSince: stops at the cursor and excludes older merges", async () => {
  const since = Date.now() - 2 * HOUR;
  const page1: GithubPr[] = [
    pr({ number: 1, updatedMsAgo: 30 * 60_000, mergedMsAgo: 30 * 60_000 }), // newer than cursor, merged → keep
    pr({ number: 2, updatedMsAgo: 3 * HOUR, mergedMsAgo: 3 * HOUR }), // older than cursor → stop here
    pr({ number: 3, updatedMsAgo: 4 * HOUR, mergedMsAgo: 4 * HOUR }), // never reached
  ];
  let page2Fetched = false;
  const fetchPage: PageFetcher = async ({ page }) => {
    if (page === 2) page2Fetched = true;
    return page === 1 ? page1 : [];
  };

  const merged = await collectMergedSince({ owner: "o", repo: "backend", token: "t", since, fetchPage });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].number, 1);
  assert.equal(page2Fetched, false, "must not page past the cursor");
});

// A rate-limit on the first page fails open (returns what was collected so far).
test("collectMergedSince: rate-limit fails open", async () => {
  const fetchPage: PageFetcher = async () => "rate-limited";
  const merged = await collectMergedSince({
    owner: "o",
    repo: "backend",
    token: "t",
    since: Date.now() - HOUR,
    fetchPage,
  });
  assert.equal(merged.length, 0);
});
