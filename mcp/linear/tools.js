import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "child_process";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const CHARACTER_LIMIT = 25000;

// Secret Manager fallback — used when LINEAR_API_KEY* env vars are absent so
// the dispatcher need not pass the key via --mcp-config argv (JOB-916).
const LINEAR_SECRET = "linear-api-key";
const GCP_PROJECT = (process.env.GCP_PROJECT_ID || "meet-assistant-6d8ad").trim();
const FETCH_TIMEOUT_MS = 15_000;

// ── Per-request context (agent key selection) ────────────
//
// Each HTTP request may carry an `x-agent-id` header that selects
// which Linear API key to use.  The mapping is:
//
//   x-agent-id   →  env var
//   ─────────────────────────────────
//   (none/atlas)  →  LINEAR_API_KEY          (default)
//   beacon        →  LINEAR_API_KEY_BEACON
//   handy         →  LINEAR_API_KEY_HANDY
//
// AsyncLocalStorage propagates the agent ID from the Express layer
// into tool handlers without changing the MCP SDK contract.

export const requestContext = new AsyncLocalStorage();

// All available API keys, loaded once at startup
const ALL_KEYS = [];

function loadKeys() {
  const keyEnvVars = ["LINEAR_API_KEY", "LINEAR_API_KEY_BEACON", "LINEAR_API_KEY_HANDY"];
  for (const envVar of keyEnvVars) {
    const key = (process.env[envVar] || "").trim();
    if (key) ALL_KEYS.push(key);
  }

  // When no key is found in env, fall back to Secret Manager (JOB-916).
  // This mirrors the sentry MCP's gcloud-fallback pattern and avoids the
  // dispatcher having to pass LINEAR_API_KEY via --mcp-config argv (where it
  // is readable by any user on the host via `ps` / /proc/<pid>/cmdline).
  if (ALL_KEYS.length === 0) {
    try {
      const key = execFileSync(
        "gcloud",
        [
          "secrets", "versions", "access", "latest",
          `--secret=${LINEAR_SECRET}`,
          `--project=${GCP_PROJECT}`,
        ],
        { encoding: "utf8", timeout: FETCH_TIMEOUT_MS },
      ).trim();
      if (key) ALL_KEYS.push(key);
    } catch {
      // fall through; getApiKey() will throw "No LINEAR_API_KEY..."
    }
  }

  // stderr, not stdout: stdout is the stdio JSON-RPC channel — any stray
  // stdout write corrupts the MCP framing (firebase/sentry servers follow the
  // same rule).
  console.error(`[keys] Loaded ${ALL_KEYS.length} Linear API key(s)`);
}

// Simple string hash → distribute agents across available keys
function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── Shared utilities ─────────────────────────────────────

function getApiKey() {
  if (ALL_KEYS.length === 0) loadKeys();
  if (ALL_KEYS.length === 0) {
    throw new Error("No LINEAR_API_KEY environment variables are set");
  }

  // If only one key, always use it
  if (ALL_KEYS.length === 1) return ALL_KEYS[0];

  // Pick key based on agent ID hash % number of keys
  const store = requestContext.getStore();
  const agentId = (store?.agentId || "").toLowerCase().trim();

  if (!agentId) return ALL_KEYS[0]; // no agent ID → default key

  const idx = hashCode(agentId) % ALL_KEYS.length;
  return ALL_KEYS[idx];
}

async function linearQuery(query, variables = {}) {
  const apiKey = getApiKey();
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(
      `Linear GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`
    );
  }
  return json.data;
}

function handleError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  // Sanitize: never expose API keys or internal paths
  const sanitized = msg
    .replace(/lin_api_[A-Za-z0-9_-]{30,}/g, "lin_api_***")
    .replace(/Bearer\s+[A-Za-z0-9_-]{10,}/g, "Bearer ***")
    .replace(/\/home\/[^\s]*/g, "[path]");
  return {
    content: [{ type: "text", text: `Error: ${sanitized}` }],
    isError: true,
  };
}

function truncateResponse(text) {
  if (text.length <= CHARACTER_LIMIT) return text;
  const truncated = text.slice(0, CHARACTER_LIMIT);
  return truncated + "\n\n[Response truncated. Use limit parameter to reduce result set.]";
}

function jsonResponse(data) {
  return {
    content: [{ type: "text", text: truncateResponse(JSON.stringify(data, null, 2)) }],
  };
}

function formatIssue(issue) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    priorityLabel: issue.priorityLabel,
    state: issue.state,
    assignee: issue.assignee,
    labels: issue.labels?.nodes || [],
    project: issue.project || null,
    cycle: issue.cycle || null,
    parent: issue.parent || null,
    children: issue.children?.nodes || [],
    estimate: issue.estimate,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

/**
 * Resolve an issue identifier (e.g. "JOB-123") to a UUID.
 * If the input is already a UUID, returns it as-is.
 */
async function resolveIssueId(idOrIdentifier) {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrIdentifier
    )
  ) {
    return idOrIdentifier;
  }

  const match = idOrIdentifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) {
    throw new Error(
      `Invalid issue identifier: ${idOrIdentifier}. Expected format: TEAM-123 or a UUID.`
    );
  }
  const [, teamKey, numberStr] = match;
  const number = parseInt(numberStr, 10);

  const query = `
    query {
      issues(filter: { number: { eq: ${number} }, team: { key: { eq: ${JSON.stringify(teamKey)} } } }, first: 1) {
        nodes { id }
      }
    }
  `;
  const data = await linearQuery(query);
  const issue = data.issues.nodes[0];
  if (!issue) {
    throw new Error(`Issue not found: ${idOrIdentifier}`);
  }
  return issue.id;
}

// ── Tool registration ────────────────────────────────────

export function registerTools(server) {
  // Eagerly load keys at registration time
  loadKeys();
  if (ALL_KEYS.length === 0) {
    console.error("WARNING: No LINEAR_API_KEY* env vars set. All tool calls will fail.");
  } else {
    console.error(`Key distribution: any agent ID → hash %% ${ALL_KEYS.length} keys`);
  }

  // ── list_issues ──────────────────────────────────────

  server.registerTool(
    "list_issues",
    {
      title: "List Issues",
      description: `List Linear issues with optional filters. Returns issue summaries sorted by updatedAt.

Args:
  - team (string, optional): Filter by team name or key (e.g. "JobLander" or "JOB").
  - state (string, optional): Filter by workflow state name (e.g. "To Do", "In Progress", "Done", "QA").
  - assignee (string, optional): Filter by assignee display name (case-insensitive contains).
  - labels (array of strings, optional): Filter by label names.
  - limit (number, optional): Max issues to return, 1-100. Default: 50.

Returns:
  { "count": number, "issues": [{ "id", "identifier", "title", "priority", "priorityLabel", "state", "assignee", "labels", "project", "cycle", "createdAt", "updatedAt", "url" }] }

Examples:
  - All team issues: { "team": "JobLander" }
  - Issues in state: { "team": "JOB", "state": "In Progress" }
  - By assignee: { "assignee": "Vlad" }

Error Handling:
  - Empty result: returns { "count": 0, "issues": [] }
  - Invalid team name: returns all issues (no filter applied)`,
      inputSchema: {
        team: z.string().optional().describe("Filter by team name or key"),
        state: z.string().optional().describe("Filter by workflow state name"),
        assignee: z.string().optional().describe("Filter by assignee display name"),
        labels: z.array(z.string()).optional().describe("Filter by label names"),
        limit: z.number().int().min(1).max(100).default(50).describe("Max issues to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ team, state, assignee, labels, limit }) => {
      try {
        const filters = [];

        if (team) {
          filters.push(
            `team: { or: [{ name: { eqIgnoreCase: ${JSON.stringify(team)} } }, { key: { eqIgnoreCase: ${JSON.stringify(team)} } }] }`
          );
        }
        if (state) {
          filters.push(
            `state: { name: { eqIgnoreCase: ${JSON.stringify(state)} } }`
          );
        }
        if (assignee) {
          filters.push(
            `assignee: { displayName: { containsIgnoreCase: ${JSON.stringify(assignee)} } }`
          );
        }
        if (labels && labels.length > 0) {
          filters.push(
            `labels: { name: { in: ${JSON.stringify(labels)} } }`
          );
        }

        const filterClause =
          filters.length > 0 ? `filter: { ${filters.join(", ")} }` : "";

        const query = `
          query {
            issues(first: ${limit}, ${filterClause} orderBy: updatedAt) {
              nodes {
                id
                identifier
                title
                priority
                priorityLabel
                state { id name type }
                assignee { id displayName email }
                labels { nodes { id name } }
                project { id name }
                cycle { id name number }
                createdAt
                updatedAt
                url
              }
            }
          }
        `;

        const data = await linearQuery(query);
        const issues = data.issues.nodes.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          priority: issue.priority,
          priorityLabel: issue.priorityLabel,
          state: issue.state,
          assignee: issue.assignee,
          labels: issue.labels?.nodes || [],
          project: issue.project || null,
          cycle: issue.cycle || null,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          url: issue.url,
        }));

        return jsonResponse({ count: issues.length, issues });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── get_issue ────────────────────────────────────────

  server.registerTool(
    "get_issue",
    {
      title: "Get Issue Details",
      description: `Get full details of a Linear issue by ID or identifier, including description, children, parent, labels, and more.

Args:
  - id (string, required): Issue ID (UUID) or identifier (e.g. "JOB-123").

Returns:
  { "id", "identifier", "title", "description", "priority", "priorityLabel", "state", "assignee", "labels", "project", "cycle", "parent", "children", "estimate", "createdAt", "updatedAt", "url" }

Examples:
  - By identifier: { "id": "JOB-123" }
  - By UUID: { "id": "550e8400-e29b-41d4-a716-446655440000" }

Error Handling:
  - "Issue not found" — the identifier or UUID does not match any issue.
  - "Invalid issue identifier" — format must be TEAM-123 or a valid UUID.`,
      inputSchema: {
        id: z.string().min(1).describe("Issue ID (UUID) or identifier (e.g. 'JOB-123')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        const issueId = await resolveIssueId(id);
        const query = `
          query($id: String!) {
            issue(id: $id) {
              id identifier title description priority priorityLabel
              state { id name type }
              assignee { id displayName email }
              labels { nodes { id name } }
              project { id name }
              cycle { id name number }
              parent { id identifier title }
              children { nodes { id identifier title state { name } } }
              createdAt updatedAt url
              estimate
            }
          }
        `;
        const data = await linearQuery(query, { id: issueId });
        if (!data.issue) {
          return jsonResponse({ found: false, id });
        }
        return jsonResponse(formatIssue(data.issue));
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── create_issue ─────────────────────────────────────

  server.registerTool(
    "create_issue",
    {
      title: "Create Issue",
      description: `Create a new Linear issue in a team. Returns the created issue with its identifier and URL.

Args:
  - title (string, required): Issue title.
  - teamId (string, required): Team ID (UUID). Use list_teams to find it.
  - description (string, optional): Issue description in markdown.
  - priority (number, optional): 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.
  - stateId (string, optional): Workflow state ID. Use list_states to find it.
  - assigneeId (string, optional): Assignee user ID (UUID).
  - labelIds (array of strings, optional): Label IDs to attach.
  - parentId (string, optional): Parent issue ID for sub-issues.
  - projectId (string, optional): Project ID to assign to.
  - cycleId (string, optional): Cycle/sprint ID to assign to.

Returns:
  { "created": true, "id": string, "identifier": string, "title": string, "url": string, "state": string, "priority": string }

Examples:
  - Basic: { "title": "Fix login bug", "teamId": "uuid-here" }
  - Full: { "title": "Add dark mode", "teamId": "uuid", "description": "Implement dark theme", "priority": 2 }

Error Handling:
  - "Failed to create issue" — check teamId is valid (use list_teams).`,
      inputSchema: {
        title: z.string().min(1).describe("Issue title"),
        teamId: z.string().min(1).describe("Team ID (UUID)"),
        description: z.string().optional().describe("Issue description (markdown)"),
        priority: z.number().int().min(0).max(4).optional().describe("Priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low"),
        stateId: z.string().optional().describe("Workflow state ID"),
        assigneeId: z.string().optional().describe("Assignee user ID (UUID)"),
        labelIds: z.array(z.string()).optional().describe("Label IDs to attach"),
        parentId: z.string().optional().describe("Parent issue ID for sub-issues"),
        projectId: z.string().optional().describe("Project ID to assign to"),
        cycleId: z.string().optional().describe("Cycle/sprint ID to assign to"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, teamId, description, priority, stateId, assigneeId, labelIds, parentId, projectId, cycleId }) => {
      try {
        const input = { title, teamId };
        if (description) input.description = description;
        if (priority !== undefined) input.priority = priority;
        if (stateId) input.stateId = stateId;
        if (assigneeId) input.assigneeId = assigneeId;
        if (labelIds) input.labelIds = labelIds;
        if (parentId) input.parentId = parentId;
        if (projectId) input.projectId = projectId;
        if (cycleId) input.cycleId = cycleId;

        const query = `
          mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue {
                id identifier title url
                state { name }
                priority priorityLabel
              }
            }
          }
        `;
        const data = await linearQuery(query, { input });
        const result = data.issueCreate;
        if (!result.success) {
          return handleError(new Error("Failed to create issue"));
        }
        return jsonResponse({
          created: true,
          id: result.issue.id,
          identifier: result.issue.identifier,
          title: result.issue.title,
          url: result.issue.url,
          state: result.issue.state?.name,
          priority: result.issue.priorityLabel,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── update_issue ─────────────────────────────────────

  server.registerTool(
    "update_issue",
    {
      title: "Update Issue",
      description: `Update fields on an existing Linear issue. Only provided fields are changed; omitted fields remain unchanged.

Args:
  - id (string, required): Issue ID (UUID) or identifier (e.g. "JOB-123").
  - title (string, optional): New title.
  - description (string, optional): New description (markdown).
  - stateId (string, optional): New workflow state ID. Use list_states to find it.
  - priority (number, optional): New priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.
  - assigneeId (string, optional): New assignee user ID.
  - labelIds (array of strings, optional): New label IDs (replaces existing).
  - projectId (string, optional): Project ID to move issue to.
  - cycleId (string, optional): Cycle/sprint ID to assign to.

Returns:
  { "updated": true, "id": string, "identifier": string, "title": string, "state": string, "priority": string, "assignee": string, "url": string }

Examples:
  - Change state: { "id": "JOB-123", "stateId": "uuid-of-in-progress" }
  - Change priority: { "id": "JOB-123", "priority": 1 }

Error Handling:
  - "Issue not found" — identifier does not match any issue.
  - "Failed to update issue" — check that field values (stateId, assigneeId) are valid UUIDs.`,
      inputSchema: {
        id: z.string().min(1).describe("Issue ID (UUID) or identifier (e.g. 'JOB-123')"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description (markdown)"),
        stateId: z.string().optional().describe("New workflow state ID"),
        priority: z.number().int().min(0).max(4).optional().describe("New priority: 0-4"),
        assigneeId: z.string().optional().describe("New assignee user ID"),
        labelIds: z.array(z.string()).optional().describe("New label IDs (replaces existing)"),
        projectId: z.string().optional().describe("Project ID to move issue to"),
        cycleId: z.string().optional().describe("Cycle/sprint ID to assign to"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, title, description, stateId, priority, assigneeId, labelIds, projectId, cycleId }) => {
      try {
        const issueId = await resolveIssueId(id);

        const input = {};
        if (title) input.title = title;
        if (description !== undefined) input.description = description;
        if (stateId) input.stateId = stateId;
        if (priority !== undefined) input.priority = priority;
        if (assigneeId) input.assigneeId = assigneeId;
        if (labelIds) input.labelIds = labelIds;
        if (projectId) input.projectId = projectId;
        if (cycleId) input.cycleId = cycleId;

        const query = `
          mutation($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue {
                id identifier title url
                state { name }
                priority priorityLabel
                assignee { displayName }
              }
            }
          }
        `;
        const data = await linearQuery(query, { id: issueId, input });
        const result = data.issueUpdate;
        if (!result.success) {
          return handleError(new Error("Failed to update issue"));
        }
        return jsonResponse({
          updated: true,
          id: result.issue.id,
          identifier: result.issue.identifier,
          title: result.issue.title,
          state: result.issue.state?.name,
          priority: result.issue.priorityLabel,
          assignee: result.issue.assignee?.displayName,
          url: result.issue.url,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_comments ────────────────────────────────────

  server.registerTool(
    "list_comments",
    {
      title: "List Comments",
      description: `List all comments on a Linear issue, ordered by creation time.

Args:
  - issueId (string, required): Issue ID (UUID) or identifier (e.g. "JOB-123").

Returns:
  { "count": number, "comments": [{ "id": string, "body": string, "author": string, "createdAt": string, "updatedAt": string }] }

Examples:
  - By identifier: { "issueId": "JOB-123" }

Error Handling:
  - "Issue not found" — the identifier or UUID does not match any issue.`,
      inputSchema: {
        issueId: z.string().min(1).describe("Issue ID (UUID) or identifier (e.g. 'JOB-123')"),
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
        const resolvedId = await resolveIssueId(issueId);
        const query = `
          query($issueId: String!) {
            issue(id: $issueId) {
              comments {
                nodes {
                  id body createdAt updatedAt
                  user { id displayName email }
                }
              }
            }
          }
        `;
        const data = await linearQuery(query, { issueId: resolvedId });
        const comments = data.issue.comments.nodes.map((c) => ({
          id: c.id,
          body: c.body,
          author: c.user?.displayName || c.user?.email || "unknown",
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        }));
        return jsonResponse({ count: comments.length, comments });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── create_comment ───────────────────────────────────

  server.registerTool(
    "create_comment",
    {
      title: "Create Comment",
      description: `Add a comment to a Linear issue. Supports markdown formatting.

Args:
  - issueId (string, required): Issue ID (UUID) or identifier (e.g. "JOB-123").
  - body (string, required): Comment body in markdown.

Returns:
  { "created": true, "id": string, "body": string, "author": string, "createdAt": string }

Examples:
  - Simple: { "issueId": "JOB-123", "body": "Fixed in PR #42" }
  - With markdown: { "issueId": "JOB-123", "body": "## QA Report\\n- [x] Login works\\n- [ ] Signup broken" }

Error Handling:
  - "Issue not found" — the identifier does not match any issue.
  - "Failed to create comment" — check issueId is valid.`,
      inputSchema: {
        issueId: z.string().min(1).describe("Issue ID (UUID) or identifier (e.g. 'JOB-123')"),
        body: z.string().min(1).describe("Comment body (markdown)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ issueId, body }) => {
      try {
        const resolvedId = await resolveIssueId(issueId);
        const query = `
          mutation($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment {
                id body createdAt
                user { displayName }
              }
            }
          }
        `;
        const data = await linearQuery(query, {
          input: { issueId: resolvedId, body },
        });
        const result = data.commentCreate;
        if (!result.success) {
          return handleError(new Error("Failed to create comment"));
        }
        return jsonResponse({
          created: true,
          id: result.comment.id,
          body: result.comment.body,
          author: result.comment.user?.displayName,
          createdAt: result.comment.createdAt,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── search_issues ────────────────────────────────────

  server.registerTool(
    "search_issues",
    {
      title: "Search Issues",
      description: `Search Linear issues by text query. Searches across title, description, and comments.

Args:
  - query (string, required): Search query text.
  - limit (number, optional): Max results, 1-50. Default: 20.

Returns:
  { "count": number, "issues": [{ "id", "identifier", "title", "priority", "state", "assignee", "labels", "url" }] }

Examples:
  - Search: { "query": "dark mode" }
  - Limited: { "query": "login bug", "limit": 5 }

Error Handling:
  - Empty results: returns { "count": 0, "issues": [] }`,
      inputSchema: {
        query: z.string().min(1).describe("Search query text"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max results to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query: searchQuery, limit }) => {
      try {
        const query = `
          query($query: String!, $first: Int) {
            searchIssues(term: $query, first: $first) {
              nodes {
                id identifier title priority priorityLabel
                state { name }
                assignee { displayName }
                labels { nodes { name } }
                url
              }
            }
          }
        `;
        const data = await linearQuery(query, {
          query: searchQuery,
          first: limit,
        });
        const issues = data.searchIssues.nodes.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          priority: issue.priorityLabel,
          state: issue.state?.name,
          assignee: issue.assignee?.displayName,
          labels: issue.labels?.nodes?.map((l) => l.name) || [],
          url: issue.url,
        }));
        return jsonResponse({ count: issues.length, issues });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_teams ───────────────────────────────────────

  server.registerTool(
    "list_teams",
    {
      title: "List Teams",
      description: `List all Linear teams in the workspace. Use team IDs from the result to filter issues, list states, etc.

Returns:
  { "count": number, "teams": [{ "id": string, "name": string, "key": string, "description": string }] }

Examples:
  - List all: {}

Error Handling:
  - Returns empty list if no teams exist.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const query = `
          query {
            teams {
              nodes {
                id name key description
              }
            }
          }
        `;
        const data = await linearQuery(query);
        return jsonResponse({
          count: data.teams.nodes.length,
          teams: data.teams.nodes,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_states ──────────────────────────────────────

  server.registerTool(
    "list_states",
    {
      title: "List Workflow States",
      description: `List workflow states for a team (e.g. Backlog, To Do, In Progress, Done). States are sorted by position. Use state IDs to create or update issues.

Args:
  - teamId (string, required): Team ID (UUID). Use list_teams to find it.

Returns:
  { "count": number, "states": [{ "id": string, "name": string, "type": string, "position": number }] }

Examples:
  - List states: { "teamId": "uuid-here" }

Error Handling:
  - Invalid teamId: returns Linear API error.`,
      inputSchema: {
        teamId: z.string().min(1).describe("Team ID (UUID)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ teamId }) => {
      try {
        const query = `
          query($teamId: String!) {
            team(id: $teamId) {
              states {
                nodes {
                  id name type position
                }
              }
            }
          }
        `;
        const data = await linearQuery(query, { teamId });
        const states = data.team.states.nodes.sort(
          (a, b) => a.position - b.position
        );
        return jsonResponse({ count: states.length, states });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_labels ──────────────────────────────────────

  server.registerTool(
    "list_labels",
    {
      title: "List Labels",
      description: `List labels for a team or workspace. If teamId is provided, returns team-specific labels; otherwise returns all workspace labels.

Args:
  - teamId (string, optional): Team ID (UUID). Omit to list workspace-level labels.

Returns:
  { "count": number, "labels": [{ "id": string, "name": string, "color": string }] }

Examples:
  - Team labels: { "teamId": "uuid-here" }
  - Workspace labels: {}

Error Handling:
  - Invalid teamId: returns Linear API error.`,
      inputSchema: {
        teamId: z.string().optional().describe("Team ID (UUID). Omit for workspace labels."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ teamId }) => {
      try {
        if (teamId) {
          const query = `
            query($teamId: String!) {
              team(id: $teamId) {
                labels {
                  nodes { id name color }
                }
              }
            }
          `;
          const data = await linearQuery(query, { teamId });
          const labels = data.team.labels.nodes;
          return jsonResponse({ count: labels.length, labels });
        } else {
          const query = `
            query {
              issueLabels {
                nodes { id name color }
              }
            }
          `;
          const data = await linearQuery(query);
          const labels = data.issueLabels.nodes;
          return jsonResponse({ count: labels.length, labels });
        }
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_projects ────────────────────────────────────

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description: `List Linear projects with their progress, teams, and dates.

Args:
  - limit (number, optional): Max projects to return, 1-100. Default: 50.

Returns:
  { "count": number, "projects": [{ "id", "name", "state", "description", "startDate", "targetDate", "progress", "teams", "url" }] }

Examples:
  - List all: {}
  - Limited: { "limit": 10 }

Error Handling:
  - Returns empty list if no projects exist.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50).describe("Max projects to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      try {
        const query = `
          query($first: Int) {
            projects(first: $first) {
              nodes {
                id name state description
                startDate targetDate
                progress
                teams { nodes { name key } }
                url
              }
            }
          }
        `;
        const data = await linearQuery(query, { first: limit });
        return jsonResponse({
          count: data.projects.nodes.length,
          projects: data.projects.nodes,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── create_project ───────────────────────────────────

  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description: `Create a new Linear project associated with one or more teams.

Args:
  - name (string, required): Project name.
  - teamIds (array of strings, required): Team IDs (UUIDs) to associate. At least one required.
  - description (string, optional): Project description (markdown).
  - targetDate (string, optional): Target completion date (ISO 8601, e.g. "2026-06-30").
  - icon (string, optional): Project icon emoji.
  - color (string, optional): Project color hex (e.g. "#4285f4").

Returns:
  { "created": true, "id": string, "name": string, "state": string, "teams": array, "targetDate": string, "url": string }

Examples:
  - Basic: { "name": "Q3 Launch", "teamIds": ["uuid"] }
  - Full: { "name": "Redesign", "teamIds": ["uuid"], "description": "Full UI redesign", "targetDate": "2026-09-01" }

Error Handling:
  - "Failed to create project" — check teamIds are valid UUIDs.`,
      inputSchema: {
        name: z.string().min(1).describe("Project name"),
        teamIds: z.array(z.string()).min(1).describe("Team IDs (UUIDs) to associate"),
        description: z.string().optional().describe("Project description (markdown)"),
        targetDate: z.string().optional().describe("Target date (ISO 8601, e.g. '2026-06-30')"),
        icon: z.string().optional().describe("Project icon emoji"),
        color: z.string().optional().describe("Project color hex"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, teamIds, description, targetDate, icon, color }) => {
      try {
        const input = { name, teamIds };
        if (description) input.description = description;
        if (targetDate) input.targetDate = targetDate;
        if (icon) input.icon = icon;
        if (color) input.color = color;

        const query = `
          mutation($input: ProjectCreateInput!) {
            projectCreate(input: $input) {
              success
              project {
                id name state description
                startDate targetDate
                icon color
                teams { nodes { name key } }
                url
              }
            }
          }
        `;
        const data = await linearQuery(query, { input });
        const result = data.projectCreate;
        if (!result.success) {
          return handleError(new Error("Failed to create project"));
        }
        return jsonResponse({
          created: true,
          id: result.project.id,
          name: result.project.name,
          state: result.project.state,
          teams: result.project.teams?.nodes || [],
          targetDate: result.project.targetDate,
          url: result.project.url,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── list_cycles ──────────────────────────────────────

  server.registerTool(
    "list_cycles",
    {
      title: "List Cycles",
      description: `List cycles (sprints) for a team. Returns active, upcoming, and recent past cycles sorted by start date.

Args:
  - teamId (string, required): Team ID (UUID). Use list_teams to find it.
  - limit (number, optional): Max cycles to return, 1-50. Default: 20.

Returns:
  { "count": number, "cycles": [{ "id": string, "name": string, "number": number, "startsAt": string, "endsAt": string, "progress": number }] }

Examples:
  - List cycles: { "teamId": "uuid-here" }

Error Handling:
  - Invalid teamId: returns Linear API error.`,
      inputSchema: {
        teamId: z.string().min(1).describe("Team ID (UUID)"),
        limit: z.number().int().min(1).max(50).default(20).describe("Max cycles to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ teamId, limit }) => {
      try {
        const query = `
          query($teamId: String!, $first: Int) {
            team(id: $teamId) {
              cycles(first: $first, orderBy: startsAt) {
                nodes {
                  id name number
                  startsAt endsAt
                  progress
                  issueCountHistory
                  scopeHistory
                }
              }
            }
          }
        `;
        const data = await linearQuery(query, { teamId, first: limit });
        const cycles = data.team.cycles.nodes.map((c) => ({
          id: c.id,
          name: c.name,
          number: c.number,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          progress: c.progress,
        }));
        return jsonResponse({ count: cycles.length, cycles });
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
