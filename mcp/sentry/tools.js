import { z } from "zod";
import { execFileSync } from "child_process";

// Same constants the deterministic monitor (monitor/triage.py) uses.
const SENTRY_ORG = "joblander-z2";
const SENTRY_PROJECT_ID = "4511020395069520";
const SENTRY_SECRET = "joblander-sentry-monitor-token";
const GCP_PROJECT = (process.env.GCP_PROJECT_ID || "meet-assistant-6d8ad").trim();
const FETCH_TIMEOUT_MS = 15000;
const CHARACTER_LIMIT = 200000;

let cachedToken = null;

/**
 * Resolve the Sentry API token lazily (never at registration time, so
 * `tools/list` works with no creds). Prefer the SENTRY_TOKEN env; otherwise
 * pull it from Secret Manager via gcloud at first tool call. The resolved
 * value is cached for the life of the process.
 */
function getToken() {
  if (cachedToken) return cachedToken;
  let token = (process.env.SENTRY_TOKEN || "").trim();
  if (!token) {
    try {
      token = execFileSync(
        "gcloud",
        [
          "secrets", "versions", "access", "latest",
          `--secret=${SENTRY_SECRET}`,
          `--project=${GCP_PROJECT}`,
        ],
        { encoding: "utf8", timeout: FETCH_TIMEOUT_MS },
      ).trim();
    } catch {
      // fall through to the empty-token error below
    }
  }
  if (!token) {
    throw new Error(
      `No Sentry token available: set SENTRY_TOKEN or grant Secret Manager ` +
      `access to '${SENTRY_SECRET}' in project ${GCP_PROJECT}.`,
    );
  }
  cachedToken = token;
  return token;
}

function scrub(text) {
  const token = cachedToken || process.env.SENTRY_TOKEN || "";
  let out = String(text);
  if (token) out = out.split(token).join("[token]");
  // Bearer tokens / long opaque credentials.
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [token]");
  return out;
}

function handleError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${scrub(msg)}` }],
    isError: true,
  };
}

function truncateResponse(text) {
  if (text.length <= CHARACTER_LIMIT) return text;
  return JSON.stringify({
    error: "response_truncated",
    message:
      `Result (${text.length} chars) exceeds the ${CHARACTER_LIMIT}-char limit. ` +
      "Narrow with a smaller 'limit' or a more specific 'query'.",
  });
}

function jsonResponse(data) {
  return {
    content: [{ type: "text", text: truncateResponse(JSON.stringify(data, null, 2)) }],
  };
}

/**
 * GET a Sentry API URL with a hard 15s timeout. Never leaks the token into
 * thrown errors (the caller scrubs, and we keep messages structured).
 */
async function sentryGet(url) {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 300);
      throw new Error(`Sentry API ${resp.status} ${resp.statusText}: ${body}`);
    }
    return await resp.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Sentry request timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Compact an issue object down to the fields useful for triage.
function slimIssue(issue) {
  const meta = issue.metadata || {};
  return {
    id: issue.id,
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    status: issue.status,
    count: issue.count,
    userCount: issue.userCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
    type: meta.type,
    value: meta.value,
  };
}

export function registerTools(server) {
  // ── sentry_list_issues ──────────────────────────────────
  server.registerTool(
    "sentry_list_issues",
    {
      title: "List Sentry Issues",
      description: `List recent unresolved Sentry issues for the joblander-app frontend project.

Args:
  - query (string, optional): Sentry search query. Default: "is:unresolved".
  - statsPeriod (string, optional): Time window (e.g. "24h", "7d", "14d"). Default: "24h".
  - limit (number, optional): Max issues to return (1-100). Default: 25.

Returns:
  { "org": string, "projectId": string, "count": number, "issues": [slimmed issue objects] }

Examples:
  - Recent unresolved: {}
  - Last 7 days, top errors: { "statsPeriod": "7d", "limit": 50 }
  - Filter by text: { "query": "is:unresolved TypeError" }

Error Handling:
  - Missing token — set SENTRY_TOKEN or grant Secret Manager access.
  - Non-200 from Sentry — status + short body are returned as a structured error.`,
      inputSchema: {
        query: z.string().default("is:unresolved").describe("Sentry search query"),
        statsPeriod: z.string().default("24h").describe("Time window, e.g. '24h', '7d'"),
        limit: z.coerce.number().int().min(1).max(100).default(25).describe("Max issues to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, statsPeriod, limit }) => {
      try {
        const params = new URLSearchParams({
          project: SENTRY_PROJECT_ID,
          query: query || "is:unresolved",
          statsPeriod: statsPeriod || "24h",
          sort: "freq",
          limit: String(limit),
        });
        const url =
          `https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/?${params.toString()}`;
        const issues = await sentryGet(url);
        const list = Array.isArray(issues) ? issues : [];
        return jsonResponse({
          org: SENTRY_ORG,
          projectId: SENTRY_PROJECT_ID,
          count: list.length,
          issues: list.map(slimIssue),
        });
      } catch (error) {
        return handleError(error);
      }
    },
  );

  // ── sentry_get_issue ────────────────────────────────────
  server.registerTool(
    "sentry_get_issue",
    {
      title: "Get Sentry Issue",
      description: `Get one Sentry issue by id, together with its latest event (stacktrace-bearing detail).

Args:
  - issueId (string, required): Sentry issue id (numeric) or shortId (e.g. "JOBLANDER-APP-1A2B").

Returns:
  { "issue": {full issue object}, "latestEvent": {event object or null}, "latestEventError": string|null }

Examples:
  - By numeric id: { "issueId": "4511020395069520" }
  - By short id: { "issueId": "JOBLANDER-APP-1A2B" }

Error Handling:
  - "404" — no issue with that id.
  - The latest event is best-effort: if it can't be fetched, "latestEvent" is null
    and "latestEventError" carries the reason (the issue itself is still returned).`,
      inputSchema: {
        issueId: z.string().min(1, "issueId cannot be empty").describe("Sentry issue id or shortId"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ issueId }) => {
      try {
        const id = encodeURIComponent(issueId);
        const issue = await sentryGet(`https://sentry.io/api/0/issues/${id}/`);
        let latestEvent = null;
        let latestEventError = null;
        try {
          latestEvent = await sentryGet(`https://sentry.io/api/0/issues/${id}/events/latest/`);
        } catch (evErr) {
          latestEventError = scrub(evErr instanceof Error ? evErr.message : String(evErr));
        }
        return jsonResponse({ issue, latestEvent, latestEventError });
      } catch (error) {
        return handleError(error);
      }
    },
  );
}
