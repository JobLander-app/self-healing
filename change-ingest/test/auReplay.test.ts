/**
 * THE proof: the AU incident replays through extract → store → query and comes
 * back as two correlated ChangeEvents the dispatcher gate can judge — plus unit
 * tests for the three pure extract mappers (the heart of ingest quality).
 *
 * Built-in node:test + assert only (no jest) — minimal deps. Uses a temp DB.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { ChangeStore } from "../src/store";
import { buildAuIncident, seedExtracted } from "../src/seed";
import {
  gcpAuditExtract,
  githubExtract,
  linearExtract,
  regionFromZone,
  entitiesFromResourceName,
  GcpAuditLogEntry,
  GithubPr,
  LinearIssueNode,
} from "../src/extract";

function tempStore(): { store: ChangeStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "change-ingest-test-"));
  const dbPath = path.join(dir, "changes.db");
  const store = new ChangeStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The AU replay (end-to-end: seed via real extractors → query).
// ---------------------------------------------------------------------------

test("AU replay: querying the incident's entities returns both changes, ts DESC, with intent_text", () => {
  const { store, cleanup } = tempStore();
  try {
    const now = Date.now();
    const changes = buildAuIncident({ now });
    for (const c of changes) seedExtracted({ store, extracted: c });

    const rows = store.queryChanges({
      since: now - 72 * HOUR, // real Stage-A LOOKBACK
      entities: [
        { type: "gcp_instance", id: "lk-au-southeast1" },
        { type: "region", id: "australia-southeast1" },
      ],
    });

    // Both the audit delete AND the decommission ticket come back.
    assert.equal(rows.length, 2, "expected both AU changes");

    // Ordered ts DESC — the delete (90 min ago) before the decision (2h ago).
    assert.ok(rows[0].ts >= rows[1].ts, "rows must be ordered ts DESC");
    assert.equal(rows[0].source, "gcp_audit");
    assert.equal(rows[0].id, "audit:au-delete-0001");
    assert.equal(rows[1].source, "linear");
    assert.equal(rows[1].id, "linear:JOB-AU1");

    // Each carries the LLM's input inline.
    for (const r of rows) {
      assert.ok(r.intent_text.length > 0, `${r.id} must carry intent_text`);
    }
    assert.match(rows[0].intent_text, /instances\.delete/);
    assert.match(rows[0].intent_text, /lk-au-southeast1/);
    assert.match(rows[1].intent_text, /Decommission/);

    // Entities are attached to each served row.
    const auditEntityTypes = rows[0].entities.map((e) => e.type).sort();
    assert.deepEqual(auditEntityTypes, ["gcp_instance", "region"]);
  } finally {
    cleanup();
  }
});

test("AU replay: entity OR-match — gcp_instance alone returns only the delete; region returns both", () => {
  const { store, cleanup } = tempStore();
  try {
    const now = Date.now();
    for (const c of buildAuIncident({ now })) seedExtracted({ store, extracted: c });

    const instanceOnly = store.queryChanges({
      since: now - 72 * HOUR,
      entities: [{ type: "gcp_instance", id: "lk-au-southeast1" }],
    });
    assert.equal(instanceOnly.length, 1);
    assert.equal(instanceOnly[0].source, "gcp_audit");

    const regionMatch = store.queryChanges({
      since: now - 72 * HOUR,
      entities: [{ type: "region", id: "australia-southeast1" }],
    });
    assert.equal(regionMatch.length, 2, "both changes carry the AU region entity");
  } finally {
    cleanup();
  }
});

test("AU replay: [since, until] window bounds the result (until below the delete ts drops it)", () => {
  const { store, cleanup } = tempStore();
  try {
    const now = Date.now();
    for (const c of buildAuIncident({ now })) seedExtracted({ store, extracted: c });

    // Window upper edge between the decision (2h ago) and the delete (90 min ago):
    // only the decision falls inside [since, until].
    const rows = store.queryChanges({
      since: now - 72 * HOUR,
      until: now - 100 * 60 * 1000,
      entities: [{ type: "region", id: "australia-southeast1" }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "linear");
  } finally {
    cleanup();
  }
});

test("store: idempotent upsert — seeding the same incident twice does not duplicate", () => {
  const { store, cleanup } = tempStore();
  try {
    const now = Date.now();
    const changes = buildAuIncident({ now });
    for (const c of changes) seedExtracted({ store, extracted: c });
    for (const c of changes) seedExtracted({ store, extracted: c });
    assert.equal(store.rowCount(), 2, "id PK dedupes re-ingest");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unit tests — the three pure extract mappers.
// ---------------------------------------------------------------------------

test("regionFromZone: strips the zone suffix, leaves a bare region unchanged", () => {
  assert.equal(regionFromZone("australia-southeast1-a"), "australia-southeast1");
  assert.equal(regionFromZone("us-central1-b"), "us-central1");
  assert.equal(regionFromZone("europe-west1"), "europe-west1"); // already a region
});

test("entitiesFromResourceName: GCE instance → gcp_instance + region", () => {
  const ents = entitiesFromResourceName(
    "projects/meet-assistant-6d8ad/zones/australia-southeast1-a/instances/lk-au-southeast1",
  );
  assert.deepEqual(ents, [
    { type: "gcp_instance", id: "lk-au-southeast1" },
    { type: "region", id: "australia-southeast1" },
  ]);
});

test("entitiesFromResourceName: Cloud Run service → service + region", () => {
  const ents = entitiesFromResourceName(
    "projects/meet-assistant-6d8ad/locations/europe-west1/services/joblander-audio-engine",
  );
  assert.deepEqual(ents, [
    { type: "service", id: "joblander-audio-engine" },
    { type: "region", id: "europe-west1" },
  ]);
});

test("gcpAuditExtract: instance delete → id, kind, actor, entities, ts, intent_text", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "abc123",
    timestamp: "2026-07-18T04:00:00Z",
    protoPayload: {
      methodName: "v1.compute.instances.delete",
      resourceName: "projects/meet-assistant-6d8ad/zones/australia-southeast1-a/instances/lk-au-southeast1",
      authenticationInfo: { principalEmail: "human@joblander.app" },
    },
  };
  const { event, entities } = gcpAuditExtract({ entry });
  assert.equal(event.id, "audit:abc123");
  assert.equal(event.source, "gcp_audit");
  assert.equal(event.kind, "instance_delete");
  assert.equal(event.actor, "human@joblander.app");
  assert.equal(event.ts, Date.parse("2026-07-18T04:00:00Z"));
  assert.equal(event.raw_ref, "audit:abc123");
  assert.match(event.intent_text, /v1\.compute\.instances\.delete/);
  assert.deepEqual(entities, [
    { type: "gcp_instance", id: "lk-au-southeast1" },
    { type: "region", id: "australia-southeast1" },
  ]);
});

test("gcpAuditExtract: Cloud Run update → run_deploy kind + service/region entities", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "run-1",
    timestamp: "2026-07-18T05:00:00Z",
    protoPayload: {
      methodName: "google.cloud.run.v2.Services.UpdateService",
      resourceName: "projects/meet-assistant-6d8ad/locations/europe-west1/services/joblander-audio-engine",
      authenticationInfo: { principalEmail: "cloudbuild@meet-assistant-6d8ad.iam.gserviceaccount.com" },
    },
  };
  const { event, entities } = gcpAuditExtract({ entry });
  assert.equal(event.kind, "run_deploy");
  assert.deepEqual(entities, [
    { type: "service", id: "joblander-audio-engine" },
    { type: "region", id: "europe-west1" },
  ]);
});

test("gcpAuditExtract: Cloud Run v1 ReplaceService → run_deploy (not misclassified)", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "run-v1",
    timestamp: "2026-07-18T06:00:00Z",
    protoPayload: {
      methodName: "google.cloud.run.v1.Services.ReplaceService",
      resourceName: "projects/meet-assistant-6d8ad/locations/europe-west1/services/joblander-audio-engine",
      authenticationInfo: { principalEmail: "cloudbuild@meet-assistant-6d8ad.iam.gserviceaccount.com" },
    },
  };
  const { event, entities } = gcpAuditExtract({ entry });
  assert.equal(event.kind, "run_deploy");
  assert.deepEqual(entities, [
    { type: "service", id: "joblander-audio-engine" },
    { type: "region", id: "europe-west1" },
  ]);
});

test("entitiesFromResourceName: Cloud Run v1 namespaces shape → service (no region)", () => {
  const ents = entitiesFromResourceName("namespaces/meet-assistant-6d8ad/services/joblander-audio-engine");
  assert.deepEqual(ents, [{ type: "service", id: "joblander-audio-engine" }]);
});

test("gcpAuditExtract: v1 namespaces ReplaceService takes its region from resource labels", () => {
  // Shape of the prod rows (2026-10-01): no region in resourceName, location label set.
  const entry: GcpAuditLogEntry = {
    insertId: "run-v1-ns",
    timestamp: "2026-10-01T14:08:46.160835Z",
    protoPayload: {
      methodName: "google.cloud.run.v1.Services.ReplaceService",
      resourceName: "namespaces/meet-assistant-6d8ad/services/joblander-audio-engine",
      authenticationInfo: { principalEmail: "cloud-build@meet-assistant-6d8ad.iam.gserviceaccount.com" },
    },
    resource: { labels: { location: "asia-south1", service_name: "joblander-audio-engine" } },
  };
  const { event, entities } = gcpAuditExtract({ entry });
  assert.equal(event.kind, "run_deploy");
  assert.deepEqual(entities, [
    { type: "service", id: "joblander-audio-engine" },
    { type: "region", id: "asia-south1" },
  ]);
});

test("gcpAuditExtract: a region already in resourceName is not duplicated by the label", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "run-v2-dup",
    timestamp: "2026-10-01T14:08:46Z",
    protoPayload: {
      methodName: "google.cloud.run.v2.Services.UpdateService",
      resourceName: "projects/p/locations/europe-west1/services/joblander-app",
    },
    resource: { labels: { location: "europe-west1" } },
  };
  assert.deepEqual(gcpAuditExtract({ entry }).entities, [
    { type: "service", id: "joblander-app" },
    { type: "region", id: "europe-west1" },
  ]);
});

test("gcpAuditExtract: Cloud Run SetIamPolicy is an IAM change, not a deploy", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "run-iam",
    timestamp: "2026-10-01T14:14:12.950315Z",
    protoPayload: {
      methodName: "google.cloud.run.v1.Services.SetIamPolicy",
      resourceName: "projects/meet-assistant-6d8ad/locations/asia-south1/services/joblander-audio-engine",
    },
    resource: { labels: { location: "asia-south1" } },
  };
  const { event, entities } = gcpAuditExtract({ entry });
  assert.equal(event.kind, "iam_change");
  assert.deepEqual(entities, [
    { type: "service", id: "joblander-audio-engine" },
    { type: "region", id: "asia-south1" },
  ]);
});

test("gcpAuditExtract: a failed Cloud Run update is not a deploy", () => {
  // A non-zero google.rpc.Status means no new revision went out; the monitor
  // reads the first run_deploy after a fix as "the fix went live".
  const entry: GcpAuditLogEntry = {
    insertId: "run-failed",
    timestamp: "2026-10-01T14:08:46Z",
    protoPayload: {
      methodName: "google.cloud.run.v1.Services.ReplaceService",
      resourceName: "namespaces/meet-assistant-6d8ad/services/joblander-audio-engine",
      status: { code: 3, message: "Revision template is invalid" },
    },
    resource: { labels: { location: "asia-south1" } },
  };
  assert.equal(gcpAuditExtract({ entry }).event.kind, "run_deploy_failed");
});

test("gcpAuditExtract: a long-running deploy counts only at its terminal entry", () => {
  const base: GcpAuditLogEntry = {
    timestamp: "2026-10-01T14:00:00Z",
    protoPayload: {
      methodName: "google.cloud.run.v2.Services.UpdateService",
      resourceName: "projects/p/locations/europe-west1/services/joblander-app",
    },
  };
  const start = gcpAuditExtract({ entry: { ...base, insertId: "op-first", operation: { id: "op", first: true } } });
  const done = gcpAuditExtract({ entry: { ...base, insertId: "op-last", operation: { id: "op", last: true } } });
  assert.equal(start.event.kind, "run_deploy_started");
  assert.equal(done.event.kind, "run_deploy");
});

test("gcpAuditExtract: only create/update/replace count as a deploy", () => {
  const kind = (methodName: string) => gcpAuditExtract({ entry: { insertId: methodName, timestamp: "2026-10-01T14:00:00Z",
    protoPayload: { methodName, resourceName: "projects/p/locations/europe-west1/services/joblander-app" } } }).event.kind;
  assert.equal(kind("google.cloud.run.v2.Services.CreateService"), "run_deploy");
  assert.equal(kind("google.cloud.run.v1.Services.ReplaceService"), "run_deploy");
  assert.equal(kind("google.cloud.run.v2.Services.DeleteService"), "run_delete");
  assert.equal(kind("google.cloud.run.v1.Services.SetIamPolicy"), "iam_change");
});

test("gcpAuditExtract: resource-scoped setIamPolicy → iam_change (lowercase method)", () => {
  const entry: GcpAuditLogEntry = {
    insertId: "iam-1",
    timestamp: "2026-07-18T07:00:00Z",
    protoPayload: {
      methodName: "v1.compute.instances.setIamPolicy",
      resourceName: "projects/meet-assistant-6d8ad/zones/europe-west1-b/instances/some-vm",
      authenticationInfo: { principalEmail: "human@joblander.app" },
    },
  };
  const { event } = gcpAuditExtract({ entry });
  assert.equal(event.kind, "iam_change");
});

test("githubExtract: merged PR → gh id, repo entity, ts=merged_at, title+body intent", () => {
  const pr: GithubPr = {
    number: 262,
    title: "feat: Cerebras hint fallback",
    body: "Adds a decommission-safe model cutover path.",
    merged_at: "2026-07-17T12:00:00Z",
    html_url: "https://github.com/JobLander-app/backend/pull/262",
    merged_by: { login: "sorokinvj" },
    base: { repo: { name: "backend", full_name: "JobLander-app/backend", owner: { login: "JobLander-app" } } },
  };
  const { event, entities } = githubExtract({ pr });
  assert.equal(event.id, "gh:JobLander-app/backend#262");
  assert.equal(event.source, "github");
  assert.equal(event.kind, "pr_merged");
  assert.equal(event.actor, "sorokinvj");
  assert.equal(event.ts, Date.parse("2026-07-17T12:00:00Z"));
  assert.equal(event.raw_ref, "https://github.com/JobLander-app/backend/pull/262");
  assert.match(event.intent_text, /Cerebras hint fallback/);
  assert.match(event.intent_text, /decommission-safe/);
  assert.deepEqual(entities, [{ type: "repo", id: "backend" }]);
});

test("linearExtract: closed issue → linear id, issue_status, labels→entities (instance alias), closing comment in intent", () => {
  const issue: LinearIssueNode = {
    identifier: "JOB-710",
    title: "Retire AU",
    description: "Remove the AU LiveKit VM.",
    updatedAt: "2026-07-18T03:00:00Z",
    completedAt: "2026-07-18T03:00:00Z",
    state: { name: "Done", type: "completed" },
    assignee: { displayName: "Atlas" },
    labels: { nodes: [{ name: "region:australia-southeast1" }, { name: "instance:lk-au-southeast1" }, { name: "bug" }] },
    closingComment: "Instance deleted, monitor list updated.",
  };
  const { event, entities } = linearExtract({ issue });
  assert.equal(event.id, "linear:JOB-710");
  assert.equal(event.kind, "issue_status");
  assert.equal(event.actor, "Atlas");
  assert.equal(event.ts, Date.parse("2026-07-18T03:00:00Z"));
  assert.match(event.intent_text, /Retire AU/);
  assert.match(event.intent_text, /monitor list updated/); // closing comment inlined
  // `instance:` is aliased to the canonical gcp_instance type; bare `bug` label ignored.
  assert.deepEqual(entities, [
    { type: "region", id: "australia-southeast1" },
    { type: "gcp_instance", id: "lk-au-southeast1" },
  ]);
});
