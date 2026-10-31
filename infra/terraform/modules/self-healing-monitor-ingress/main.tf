terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 5.0, < 7.0" }
  }
}

variable "project_id" { type = string }
variable "project_number" { type = string }
variable "endpoint" { type = string }
variable "trigger_config" {
  type = object({ project = string, filter = string })
}

resource "google_pubsub_topic" "errors" {
  project = var.project_id
  name    = "self-healing-monitor-errors"
}

# This identity has no project roles. Only Pub/Sub can mint its push token.
resource "google_service_account" "push" {
  project      = var.project_id
  account_id   = "self-healing-monitor-push"
  display_name = "Authenticated monitor wake-ups"
}

resource "google_service_account_iam_member" "token_creator" {
  service_account_id = google_service_account.push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "push" {
  project                    = var.project_id
  name                       = "self-healing-monitor-errors"
  topic                      = google_pubsub_topic.errors.id
  ack_deadline_seconds       = 30
  message_retention_duration = "86400s"
  expiration_policy { ttl = "" }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "300s"
  }
  push_config {
    push_endpoint = var.endpoint
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = var.endpoint
    }
  }
  depends_on = [google_service_account_iam_member.token_creator]
}

# A log stream has no Monitoring notification quota. The receiver coalesces
# bursts; severity thresholds and suppression still belong to the shared monitor.
resource "google_logging_project_sink" "errors" {
  project                = var.project_id
  name                   = "self-healing-monitor-errors"
  destination            = "pubsub.googleapis.com/${google_pubsub_topic.errors.id}"
  filter                 = var.trigger_config.filter
  unique_writer_identity = true
  lifecycle {
    precondition {
      condition     = var.trigger_config.project == var.project_id && var.trigger_config.filter != ""
      error_message = "Generate a non-empty trigger config from this consumer's targets.json."
    }
  }
}

resource "google_pubsub_topic_iam_member" "logging" {
  project = var.project_id
  topic   = google_pubsub_topic.errors.name
  role    = "roles/pubsub.publisher"
  member  = google_logging_project_sink.errors.writer_identity
}

output "topic" { value = google_pubsub_topic.errors.id }
output "subscription" { value = google_pubsub_subscription.push.id }
output "push_identity" { value = google_service_account.push.email }
