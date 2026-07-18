/**
 * Seed util + CLI. Inserts arbitrary ChangeEvents into the store — used by the
 * AU-replay test (deterministic fixtures) and for a manual demo (`npm run
 * seed`). The AU incident is built through the REAL extractors, so seeding also
 * exercises the extract → store path end-to-end.
 *
 * NO inference — pure fixtures + deterministic mappers.
 */

import { config } from "./config";
import { ChangeStore } from "./store";
import { ExtractedChange } from "./model";
import { GcpAuditLogEntry, LinearIssueNode, gcpAuditExtract, linearExtract } from "./extract";

/** Insert one already-extracted change (optionally with an explicit ingest time). */
export function seedExtracted({
  store,
  extracted,
  ingestedAt,
}: {
  store: ChangeStore;
  extracted: ExtractedChange;
  ingestedAt?: number;
}): void {
  store.upsert({ ...extracted, ingestedAt });
}

/**
 * The real `lk-au-southeast1` incident, as two ChangeEvents (the failure that
 * motivates the whole feature, §0):
 *   (a) a GCE `instances.delete` audit event on lk-au-southeast1 in zone
 *       australia-southeast1-a  → gcp_instance + region entities;
 *   (b) a closed (Canceled) Linear issue "Decommission lk-au / AU region"
 *       labelled `region:australia-southeast1` → region entity.
 *
 * `now` is injectable so tests can place both inside a known window.
 */
export function buildAuIncident({ now = Date.now() }: { now?: number } = {}): ExtractedChange[] {
  const deleteTs = new Date(now - 90 * 60 * 1000).toISOString(); // 90 min ago — the effect
  const decisionTs = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2h ago — the decision

  const auditEntry: GcpAuditLogEntry = {
    insertId: "au-delete-0001",
    timestamp: deleteTs,
    protoPayload: {
      methodName: "v1.compute.instances.delete",
      resourceName: "projects/meet-assistant-6d8ad/zones/australia-southeast1-a/instances/lk-au-southeast1",
      authenticationInfo: { principalEmail: "agent@joblander.app" },
    },
  };

  const linearIssue: LinearIssueNode = {
    identifier: "JOB-AU1",
    title: "Decommission lk-au / AU region",
    description: "AU has no backend serving traffic; retire the lk-au-southeast1 LiveKit VM and stop monitoring it.",
    updatedAt: decisionTs,
    canceledAt: decisionTs,
    state: { name: "Canceled", type: "canceled" },
    labels: { nodes: [{ name: "region:australia-southeast1" }] },
    closingComment: "Deleted the AU instance and removed it from the monitor target list.",
  };

  return [gcpAuditExtract({ entry: auditEntry }), linearExtract({ issue: linearIssue })];
}

function main(): void {
  const store = new ChangeStore(config.changesDb);
  const changes = buildAuIncident({});
  for (const c of changes) seedExtracted({ store, extracted: c });
  console.log(`[seed] Inserted ${changes.length} AU-incident change(s) into ${config.changesDb}`);
  console.log(`[seed] Store now has ${store.rowCount()} row(s).`);
  store.close();
}

if (require.main === module) main();
