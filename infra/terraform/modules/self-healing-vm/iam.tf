# Dedicated service account with MINIMAL grants. The legacy
# joblander-agents VM runs as the project default compute SA — this module
# deliberately breaks with that.

resource "google_service_account" "agent" {
  project      = var.project_id
  account_id   = var.service_account_id
  display_name = "Self-healing loop VM (${var.vm_name})"
  description  = "Dedicated SA for the self-healing loop VM. Minimal: log read/write, metric write, per-secret access, agent-logs bucket. JOB-731."
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
  for_each = toset([
    "roles/logging.viewer",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/datastore.viewer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.agent.email}"
}

# Per-secret accessor grants instead of project-wide
# secretmanager.secretAccessor — the SA can read exactly the secrets the
# loop needs and nothing else.
resource "google_secret_manager_secret_iam_member" "secrets" {
  for_each = toset(concat(var.secret_ids, var.extra_secret_ids))

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent.email}"
}

# Session logs / QA reports / backups bucket — objectAdmin on this ONE
# bucket, not project-wide storage roles.
resource "google_storage_bucket_iam_member" "logs_bucket" {
  bucket = var.logs_bucket
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.agent.email}"
}
