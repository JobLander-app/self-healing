/**
 * Pure extractors: raw source payload → { event, entities }. NO I/O, NO clock,
 * NO inference — these are the unit-tested heart of ingest quality (§2). Each
 * maps ONE source. v1 extracts the directly-named entity (the deleted instance,
 * the deployed service, the merged repo); path-derived enrichment is v2.
 *
 * Determinism is the whole point: given the same payload these return the same
 * ChangeEvent every time, so the store's idempotent id upsert holds and the
 * AU-replay test is reproducible.
 */

import { EntityRef, ExtractedChange, truncateIntent } from "./model";

// ---------------------------------------------------------------------------
// GCP Cloud Audit Logs (the au-delete piece, §4).
// ---------------------------------------------------------------------------

/** The subset of a Cloud Audit `logEntry` we read. Everything is optional
 *  because gcloud omits empty fields; the extractor is defensive. */
export interface GcpAuditLogEntry {
  insertId?: string;
  timestamp?: string; // RFC3339
  protoPayload?: {
    methodName?: string;
    resourceName?: string;
    authenticationInfo?: { principalEmail?: string };
  };
  resource?: {
    labels?: Record<string, string>;
  };
}

/** zone `australia-southeast1-a` → region `australia-southeast1`. A region
 *  value passed in (no trailing `-<letter>`) is returned unchanged. */
export function regionFromZone(zone: string): string {
  const m = /^(.*)-[a-z]$/.exec(zone);
  return m ? m[1] : zone;
}

/** Map an audit methodName to a fine-grained `kind`. */
function auditKind(methodName: string): string {
  if (methodName.endsWith("compute.instances.delete")) return "instance_delete";
  if (methodName.endsWith("compute.instances.insert")) return "instance_create";
  if (methodName.includes("run.v2.Services") || methodName.includes("run.v1.ReplaceService")) return "run_deploy";
  if (methodName.includes("SetIamPolicy") || methodName.includes("iam.admin")) return "iam_change";
  return "audit_event";
}

/**
 * Derive entities from a resourceName. Handles the two shapes slice-0 cares
 * about — GCE instances (→ gcp_instance + region from zone) and Cloud Run
 * services (→ service + region from location). Unknown shapes yield [].
 */
export function entitiesFromResourceName(resourceName: string): EntityRef[] {
  const entities: EntityRef[] = [];

  // .../zones/<zone>/instances/<name>
  const inst = /\/zones\/([^/]+)\/instances\/([^/]+)/.exec(resourceName);
  if (inst) {
    const [, zone, name] = inst;
    entities.push({ type: "gcp_instance", id: name });
    entities.push({ type: "region", id: regionFromZone(zone) });
    return entities;
  }

  // .../locations/<region>/services/<name>   (Cloud Run)
  const svc = /\/locations\/([^/]+)\/services\/([^/]+)/.exec(resourceName);
  if (svc) {
    const [, region, name] = svc;
    entities.push({ type: "service", id: name });
    entities.push({ type: "region", id: region });
    return entities;
  }

  return entities;
}

export function gcpAuditExtract({ entry }: { entry: GcpAuditLogEntry }): ExtractedChange {
  const proto = entry.protoPayload ?? {};
  const methodName = proto.methodName ?? "unknown.method";
  const resourceName = proto.resourceName ?? "";
  const insertId = entry.insertId ?? `${methodName}@${entry.timestamp ?? "unknown"}`;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;

  const entities = entitiesFromResourceName(resourceName);

  return {
    event: {
      id: `audit:${insertId}`,
      source: "gcp_audit",
      kind: auditKind(methodName),
      ts: Number.isNaN(ts) ? 0 : ts,
      actor: proto.authenticationInfo?.principalEmail ?? null,
      title: `${methodName} ${resourceName}`.trim(),
      intent_text: truncateIntent(`${methodName} ${resourceName}`.trim()),
      raw_ref: entry.insertId ? `audit:${entry.insertId}` : null,
    },
    entities,
  };
}

// ---------------------------------------------------------------------------
// GitHub PR merges (§3.3).
// ---------------------------------------------------------------------------

export interface GithubPr {
  number: number;
  title?: string;
  body?: string | null;
  merged_at?: string | null;
  html_url?: string;
  merged_by?: { login?: string } | null;
  user?: { login?: string } | null;
  base?: {
    repo?: {
      name?: string;
      full_name?: string;
      owner?: { login?: string };
    };
  };
}

export function githubExtract({ pr }: { pr: GithubPr }): ExtractedChange {
  const repoName = pr.base?.repo?.name ?? "unknown";
  const fullName = pr.base?.repo?.full_name ?? `unknown/${repoName}`;
  const actor = pr.merged_by?.login ?? pr.user?.login ?? null;
  const title = pr.title ?? `PR #${pr.number}`;
  const body = pr.body ?? "";
  const ts = pr.merged_at ? Date.parse(pr.merged_at) : Number.NaN;

  return {
    event: {
      id: `gh:${fullName}#${pr.number}`,
      source: "github",
      kind: "pr_merged",
      ts: Number.isNaN(ts) ? 0 : ts,
      actor,
      title,
      intent_text: truncateIntent(body ? `${title}\n\n${body}` : title),
      raw_ref: pr.html_url ?? null,
    },
    entities: [{ type: "repo", id: repoName }],
  };
}

// ---------------------------------------------------------------------------
// Linear issue status changes (§3.4).
// ---------------------------------------------------------------------------

export interface LinearIssueNode {
  identifier: string;
  title?: string;
  description?: string | null;
  updatedAt?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: { name?: string; displayName?: string } | null;
  labels?: { nodes?: { name?: string }[] } | null;
  /** the closing comment body, if the caller resolved it. */
  closingComment?: string | null;
}

/**
 * Best-effort label → entity mapping. Convention (deterministic, documented in
 * README): a label of the form `type:id` (e.g. `region:australia-southeast1`,
 * `service:joblander-audio-engine`, `instance:lk-au-southeast1`, `repo:backend`)
 * maps straight to an EntityRef. Labels without a recognized `type:` prefix are
 * ignored (v1 stays shallow-but-correct — no guessing).
 */
export function entitiesFromLinearLabels(labelNames: string[]): EntityRef[] {
  const known = new Set(["region", "service", "gcp_instance", "instance", "repo", "endpoint"]);
  const out: EntityRef[] = [];
  for (const name of labelNames) {
    const idx = name.indexOf(":");
    if (idx <= 0) continue;
    const rawType = name.slice(0, idx).trim().toLowerCase();
    const id = name.slice(idx + 1).trim();
    if (!id || !known.has(rawType)) continue;
    // `instance` is an accepted alias for the canonical `gcp_instance` type.
    const type = rawType === "instance" ? "gcp_instance" : rawType;
    out.push({ type, id });
  }
  return out;
}

export function linearExtract({ issue }: { issue: LinearIssueNode }): ExtractedChange {
  const labelNames = (issue.labels?.nodes ?? []).map((n) => n.name ?? "").filter((n) => n.length > 0);
  const title = issue.title ?? issue.identifier;
  const description = issue.description ?? "";
  const closing = issue.closingComment ?? "";
  const actor = issue.assignee?.displayName ?? issue.assignee?.name ?? null;
  // ts = effective time: prefer completedAt (when it closed), else updatedAt.
  const tsSource = issue.completedAt || issue.canceledAt || issue.updatedAt;
  const ts = tsSource ? Date.parse(tsSource) : Number.NaN;

  const intentParts = [title, description, closing].map((s) => s.trim()).filter((s) => s.length > 0);

  return {
    event: {
      id: `linear:${issue.identifier}`,
      source: "linear",
      kind: "issue_status",
      ts: Number.isNaN(ts) ? 0 : ts,
      actor,
      title: issue.state?.name ? `${title} [${issue.state.name}]` : title,
      intent_text: truncateIntent(intentParts.join("\n\n")),
      raw_ref: `linear:${issue.identifier}`,
    },
    entities: entitiesFromLinearLabels(labelNames),
  };
}
