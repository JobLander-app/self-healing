# Off-box watchdog for the self-healing loop.
#
# WHY THIS MODULE EXISTS
# On 2026-08-26 the loop's VM lost its DHCP address under memory pressure and
# ran blind for six days: cron ticked, the dispatcher restarted, the watcher
# watched — and none of it could reach Cloud Logging, Linear, Telegram or the
# metadata server. Every mechanism that was supposed to notice lived on the
# same VM or reported through the same dead network, and not one of them could
# ACT. Recovery required a human to look.
#
# Everything here is deliberately somewhere else: a Cloud Function on Cloud
# Run, driven by Cloud Scheduler, reading Cloud Logging and holding reset
# permission on exactly one instance. It is entirely deterministic — no model
# call, per the single-provider rule in CLAUDE.md.
#
#   Scheduler (*/5) ──> watchdog fn ──> Cloud Logging (heartbeat age?)
#                             │
#                             ├─ stale ──> Telegram page ──> compute.reset (budgeted)
#                             └─ writes its own WATCHDOG_HEARTBEAT
#
#   Alert policies ──> Pub/Sub ──> alertRelay fn ──> Telegram
#     (Monitoring's webhook channel cannot speak to the Bot API: it posts its
#      own incident JSON and Telegram answers 400. That is why five policies in
#      this project notified nobody for months.)

locals {
  fn_name    = "self-healing-watchdog"
  relay_name = "self-healing-alert-relay"
}

# ---- service accounts -------------------------------------------------------

resource "google_service_account" "watchdog" {
  project      = var.project_id
  account_id   = "self-healing-watchdog"
  display_name = "Self-healing watchdog (off-box liveness + recovery)"
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "self-healing-wd-invoker"
  display_name = "Cloud Scheduler identity that invokes the self-healing watchdog"
}

# ---- permissions ------------------------------------------------------------
# Read heartbeats, write its own, and reset ONE instance. Nothing else.

resource "google_project_iam_member" "watchdog_project_roles" {
  for_each = toset([
    "roles/logging.viewer",    # entries:list — read the heartbeat streams
    "roles/logging.logWriter", # entries:write — its own WATCHDOG_HEARTBEAT
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.watchdog.email}"
}

# Reset/start rights are bound to the single instance, not the project. A
# watchdog that can power-cycle the fleet is a bigger risk than the outage.
resource "google_compute_instance_iam_member" "watchdog_instance_admin" {
  project       = var.project_id
  zone          = var.vm_zone
  instance_name = var.vm_name
  role          = "roles/compute.instanceAdmin.v1"
  member        = "serviceAccount:${google_service_account.watchdog.email}"
}

resource "google_secret_manager_secret_iam_member" "watchdog_secrets" {
  for_each  = toset([var.telegram_token_secret, var.telegram_chat_id_secret])
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.watchdog.email}"
}

# ---- state (reset budget / last-seen condition) -----------------------------

resource "google_storage_bucket" "state" {
  project                     = var.project_id
  name                        = "${var.project_id}-self-healing-watchdog"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  labels                      = var.labels

  # Function source archives are versioned by content hash; keep the bucket
  # from growing without bound.
  lifecycle_rule {
    condition { age = 90 }
    action { type = "Delete" }
  }
}

resource "google_storage_bucket_iam_member" "watchdog_state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.watchdog.email}"
}

# ---- function source --------------------------------------------------------

data "archive_file" "source" {
  type        = "zip"
  source_dir  = "${path.module}/../../../../watchdog"
  output_path = "${path.module}/.build/watchdog-source.zip"
  excludes    = ["node_modules", ".build", "test"]
}

resource "google_storage_bucket_object" "source" {
  # Content hash in the name: a code change is a new object, which is what
  # makes the function actually redeploy.
  name   = "source/watchdog-${data.archive_file.source.output_md5}.zip"
  bucket = google_storage_bucket.state.name
  source = data.archive_file.source.output_path
}

# ---- the watchdog function --------------------------------------------------

resource "google_cloudfunctions2_function" "watchdog" {
  project     = var.project_id
  name        = local.fn_name
  location    = var.region
  description = "Off-box liveness check for ${var.vm_name}: heartbeat staleness -> Telegram page -> budgeted instance reset."
  labels      = var.labels

  build_config {
    runtime     = "nodejs20"
    entry_point = "watchdog"
    source {
      storage_source {
        bucket = google_storage_bucket.state.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    # One instance, one job. Concurrent runs would race on the reset budget.
    max_instance_count    = 1
    min_instance_count    = 0
    available_memory      = "256Mi"
    timeout_seconds       = 120
    service_account_email = google_service_account.watchdog.email
    ingress_settings      = "ALLOW_ALL" # protected by IAM (run.invoker), not by network

    environment_variables = {
      PROJECT_ID           = var.project_id
      VM_ZONE              = var.vm_zone
      VM_NAME              = var.vm_name
      WATCHER_LOG_ID       = var.watcher_log_id
      DISPATCHER_LOG_ID    = var.dispatcher_log_id
      WATCHDOG_LOG_ID      = var.watchdog_log_id
      STATE_BUCKET         = google_storage_bucket.state.name
      STATE_OBJECT         = "watchdog-state.json"
      WATCHER_PAGE_SEC     = tostring(var.watcher_page_seconds)
      WATCHER_RESET_SEC    = tostring(var.watcher_reset_seconds)
      DISPATCHER_PAGE_SEC  = tostring(var.dispatcher_page_seconds)
      DISPATCHER_RESET_SEC = tostring(var.dispatcher_reset_seconds)
      RESET_COOLDOWN_SEC   = tostring(var.reset_cooldown_seconds)
      RESET_MAX_PER_WINDOW = tostring(var.reset_max_per_window)
      RESET_WINDOW_SEC     = tostring(var.reset_window_seconds)
      RELAY_LOG_ID         = var.relay_log_id
      CANARY_STALE_SEC     = tostring(var.canary_stale_seconds)
    }

    secret_environment_variables {
      key        = "TELEGRAM_BOT_TOKEN"
      project_id = var.project_id
      secret     = var.telegram_token_secret
      version    = "latest"
    }
    secret_environment_variables {
      key        = "TELEGRAM_CHAT_ID"
      project_id = var.project_id
      secret     = var.telegram_chat_id_secret
      version    = "latest"
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.watchdog_secrets]
}

resource "google_cloud_run_service_iam_member" "watchdog_invoker" {
  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.watchdog.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "watchdog" {
  project          = var.project_id
  region           = var.region
  name             = local.fn_name
  description      = "Drives the off-box self-healing watchdog."
  schedule         = var.schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "180s"

  retry_config {
    retry_count = 1
  }

  http_target {
    uri         = google_cloudfunctions2_function.watchdog.service_config[0].uri
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = google_cloudfunctions2_function.watchdog.service_config[0].uri
    }
  }

  depends_on = [google_cloud_run_service_iam_member.watchdog_invoker]
}

# ---- alert delivery that actually delivers ----------------------------------

resource "google_pubsub_topic" "alerts" {
  project = var.project_id
  name    = "self-healing-alerts"
  labels  = var.labels
}

# Cloud Monitoring publishes as its own service agent; without this the
# notification channel silently drops every incident.
resource "google_pubsub_topic_iam_member" "monitoring_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.alerts.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${var.project_number}@gcp-sa-monitoring-notification.iam.gserviceaccount.com"

  # The agent is created lazily by Google on first use of the notification
  # channel API, so the channel must exist before this grant can name it.
  depends_on = [google_monitoring_notification_channel.telegram]
}

# The alert path is only proven while something keeps proving it. Once a day
# this publishes a canary onto the same topic Cloud Monitoring uses; the relay
# delivers it to Telegram with disable_notification (visible in the chat, no
# sound) and logs RELAY_DELIVERED. The watchdog — a separate deployment — pages
# if that proof goes stale. Without this, a broken relay is indistinguishable
# from a quiet week, which is precisely how six days were lost on 2026-08-26.
resource "google_cloud_scheduler_job" "alert_canary" {
  project     = var.project_id
  region      = var.region
  name        = "self-healing-alert-canary"
  description = "Daily proof that Monitoring -> Pub/Sub -> relay -> Telegram still delivers."
  schedule    = var.canary_schedule
  time_zone   = "Etc/UTC"

  pubsub_target {
    topic_name = google_pubsub_topic.alerts.id
    data       = base64encode("{\"canary\":true,\"source\":\"cloud-scheduler\"}")
  }
}

resource "google_cloudfunctions2_function" "alert_relay" {
  project     = var.project_id
  name        = local.relay_name
  location    = var.region
  description = "Cloud Monitoring incident (Pub/Sub) -> Telegram. Replaces the webhook channel that answers 400."
  labels      = var.labels

  build_config {
    runtime     = "nodejs20"
    entry_point = "alertRelay"
    source {
      storage_source {
        bucket = google_storage_bucket.state.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    # One instance: the relay's rate-limit state is a single GCS object and
    # concurrent instances would race on read-modify-write, which shows up as
    # exactly the thing the state exists to prevent — duplicate pages.
    max_instance_count    = 1
    available_memory      = "256Mi"
    timeout_seconds       = 60
    service_account_email = google_service_account.watchdog.email
    ingress_settings      = "ALLOW_INTERNAL_ONLY"

    environment_variables = {
      PROJECT_ID         = var.project_id
      VM_ZONE            = var.vm_zone
      VM_NAME            = var.vm_name
      WATCHER_LOG_ID     = var.watcher_log_id
      DISPATCHER_LOG_ID  = var.dispatcher_log_id
      STATE_BUCKET       = google_storage_bucket.state.name
      RELAY_LOG_ID       = var.relay_log_id
      RELAY_COOLDOWN_SEC = tostring(var.relay_cooldown_seconds)
    }

    secret_environment_variables {
      key        = "TELEGRAM_BOT_TOKEN"
      project_id = var.project_id
      secret     = var.telegram_token_secret
      version    = "latest"
    }
    secret_environment_variables {
      key        = "TELEGRAM_CHAT_ID"
      project_id = var.project_id
      secret     = var.telegram_chat_id_secret
      version    = "latest"
    }
  }

  event_trigger {
    trigger_region        = var.region
    event_type            = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic          = google_pubsub_topic.alerts.id
    retry_policy          = "RETRY_POLICY_RETRY"
    service_account_email = google_service_account.watchdog.email
  }

  depends_on = [
    google_secret_manager_secret_iam_member.watchdog_secrets,
    google_project_iam_member.watchdog_eventarc,
  ]
}

# Eventarc delivers the Pub/Sub push as this service account, so it needs
# run.invoker on the relay itself — eventarc.eventReceiver alone is not enough.
# Without it the relay answers 401 to every delivery and the alert is dropped
# after the retry window, silently: exactly the failure mode this module exists
# to end. Found by publishing a synthetic incident before repointing any real
# alert policy at the topic.
resource "google_cloud_run_service_iam_member" "relay_invoker" {
  project  = var.project_id
  location = var.region
  service  = google_cloudfunctions2_function.alert_relay.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.watchdog.email}"
}

resource "google_project_iam_member" "watchdog_eventarc" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.watchdog.email}"
}

resource "google_monitoring_notification_channel" "telegram" {
  project      = var.project_id
  display_name = "Telegram via self-healing alert relay"
  type         = "pubsub"
  labels = {
    topic = google_pubsub_topic.alerts.id
  }
  description = "Cloud Monitoring -> Pub/Sub -> alertRelay function -> Telegram. Use this instead of a raw api.telegram.org webhook channel, which cannot parse Monitoring's payload (HTTP 400)."
}

# ---- who watches the watchdog ----------------------------------------------
# Not circular: this alert is delivered by the RELAY function, which is a
# separate deployment from the watchdog. The watchdog dying does not silence
# its own alarm.

resource "google_logging_metric" "watchdog_heartbeat" {
  project = var.project_id
  name    = "self_healing_watchdog_heartbeat"
  filter  = "logName=\"projects/${var.project_id}/logs/${var.watchdog_log_id}\" AND textPayload:\"WATCHDOG_HEARTBEAT\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "watchdog_silent" {
  project      = var.project_id
  display_name = "P1: self-healing WATCHDOG silent 20 min — the recovery layer is down"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      The off-box watchdog has not run for 20+ minutes. While it is silent,
      nothing outside `${var.vm_name}` can notice the VM dying and nothing can
      reset it — the exact condition that produced the six-day blackout of
      2026-08-26 (docs/POSTMORTEM-2026-08-26-network-blackout.md).

      Check, in order:
      1. Scheduler job: `gcloud scheduler jobs describe ${local.fn_name} --location=${var.region}`
      2. Function logs: `gcloud functions logs read ${local.fn_name} --region=${var.region} --limit=50`
      3. A config error fails the run loudly — look for `config:` in those logs.
    EOT
  }

  conditions {
    display_name = "WATCHDOG_HEARTBEAT absent 20m"
    condition_absent {
      filter   = "resource.type = \"global\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.watchdog_heartbeat.name}\""
      duration = "1200s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }

  notification_channels = [google_monitoring_notification_channel.telegram.id]

  alert_strategy {
    auto_close = "86400s"
  }
}
