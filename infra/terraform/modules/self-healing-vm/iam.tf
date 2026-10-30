
resource "google_service_account" "agent" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "Self-healing loop VM (${var.vm_name})"
  description  = "Dedicated SA for the self-healing loop VM. Minimal: log read/write, metric write, per-secret access, optional logs bucket."
}

# Project-level roles — only what the loop actually does:
#   logging.viewer       agents read prod logs during investigation
#   logging.logWriter    VM writes its own logs (incl. the WATCHER_HEARTBEAT
#                        entries the dead-man alert watches)
#   monitoring.metricWriter  ops metrics from the VM
#   datastore.viewer     read-only Firestore for the vendored firebase MCP
#                        (ADC — no key file); dispatcher reads meetings/users
#                        docs while investigating a bug. Read-only on purpose.
resource "google_project_iam_member" "roles" {
  for_each = toset(concat([
    "roles/logging.viewer",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ], var.firebase_enabled ? ["roles/datastore.viewer"] : []))

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.agent.email}"
}

# Compare the reviewed monitor contract with deployed Cloud Run configuration.
# No invoke, update, delete, IAM-policy or secret-value permissions.
resource "google_project_iam_custom_role" "monitor_topology" {
  project     = var.project_id
  role_id     = "selfHealingMonitorTopology"
  title       = "Self-healing monitoring topology reader"
  description = "Read service configuration and worker-pool readiness for drift detection."
  permissions = ["run.services.get", "run.workerpools.get"]
}

resource "google_project_iam_member" "monitor_topology" {
  project = var.project_id
  role    = google_project_iam_custom_role.monitor_topology.name
  member  = "serviceAccount:${google_service_account.agent.email}"
}

# Per-secret accessor grants instead of project-wide
# secretmanager.secretAccessor — the SA can read exactly the secrets the
# loop needs and nothing else. Includes the Grafana admin password secret
# and, when set, the Google OAuth id/secret (empty strings compacted out —
# v1 is admin-login only).
resource "google_secret_manager_secret_iam_member" "secrets" {
  for_each = toset(compact(concat(
    var.secret_ids,
    var.extra_secret_ids,
    [
      var.grafana_admin_secret,
      var.grafana_google_oauth_client_id_secret,
      var.grafana_google_oauth_client_secret_secret,
    ],
  )))

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent.email}"
}

# Session logs / QA reports / backups bucket — objectAdmin on this ONE
# bucket, not project-wide storage roles.
resource "google_storage_bucket_iam_member" "logs_bucket" {
  count  = var.logs_bucket == "" ? 0 : 1
  bucket = var.logs_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent.email}"
}

moved {
  from = google_storage_bucket_iam_member.logs_bucket
  to   = google_storage_bucket_iam_member.logs_bucket[0]
}
