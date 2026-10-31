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

resource "google_monitoring_notification_channel" "monitor" {
  project      = var.project_id
  display_name = "Self-healing monitor wake-up (no human page)"
  type         = "pubsub"
  labels       = { topic = google_pubsub_topic.errors.id }
}

resource "google_pubsub_topic_iam_member" "monitoring" {
  project    = var.project_id
  topic      = google_pubsub_topic.errors.name
  role       = "roles/pubsub.publisher"
  member     = "serviceAccount:service-${var.project_number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com"
  depends_on = [google_monitoring_notification_channel.monitor]
}

resource "google_monitoring_alert_policy" "errors" {
  project      = var.project_id
  display_name = "Self-healing: production error wakes monitor"
  combiner     = "OR"
  conditions {
    display_name = "An error in the monitored application scope"
    condition_matched_log { filter = var.trigger_config.filter }
  }
  documentation {
    mime_type = "text/markdown"
    content   = "Wake-up only. The monitor re-reads production logs and applies the same thresholds, ticket decisions and suppressions as its hourly fallback. This notification never pages a person."
  }
  alert_strategy {
    notification_rate_limit { period = "300s" }
    auto_close = "1800s"
  }
  notification_channels = [google_monitoring_notification_channel.monitor.id]
  depends_on            = [google_pubsub_topic_iam_member.monitoring]
  lifecycle {
    precondition {
      condition     = var.trigger_config.project == var.project_id && var.trigger_config.filter != ""
      error_message = "Generate a non-empty trigger config from this consumer's targets.json."
    }
  }
}

output "topic" { value = google_pubsub_topic.errors.id }
output "subscription" { value = google_pubsub_subscription.push.id }
output "push_identity" { value = google_service_account.push.email }
