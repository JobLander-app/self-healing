
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "Self-healing loop alerts (${var.alert_email})"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# --- 1. Dead-man: watcher heartbeat -----------------------------------------
#
# The TS watcher ends every successful tick with a `WATCHER_HEARTBEAT {json}`
# line on stdout; cron redirects stdout to a local file AND (on exit 0)
# ships one heartbeat entry to Cloud Logging via
# `gcloud logging write <heartbeat_log_id> "WATCHER_HEARTBEAT ..."`.
# See deploy/cron/self-healing.crontab. A crashed tick (exit != 0) writes
# no heartbeat — by design, that is exactly what this alert catches.

resource "google_logging_metric" "watcher_heartbeat" {
  project = var.project_id
  name    = "self_healing_watcher_heartbeat"
  filter  = "logName=\"projects/${var.project_id}/logs/${var.heartbeat_log_id}\" AND textPayload:\"WATCHER_HEARTBEAT\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "watcher_dead_man" {
  project      = var.project_id
  display_name = "P0: self-healing watcher heartbeat absent ${var.heartbeat_absence_seconds / 60} min (dead-man)"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      The output-watcher on the `${var.vm_name}` VM has not written a
      `WATCHER_HEARTBEAT` Cloud Logging entry for ${var.heartbeat_absence_seconds / 60}+ minutes.
      The watcher pages on product-output failure. Check its independent heartbeat.

      Check, in order:
      1. VM up? `gcloud compute instances describe ${var.vm_name} --zone=<zone>`
      2. Cron running? `ssh` (via IAP) → `crontab -l -u ${var.agent_user}`, `tail /home/${var.agent_user}/output-watch.log`
      3. Tick crashing? Exit != 0 suppresses the heartbeat on purpose — read the log tail for the error.
    EOT
  }

  conditions {
    display_name = "WATCHER_HEARTBEAT absent ${var.heartbeat_absence_seconds / 60}m"

    condition_absent {
      filter   = "resource.type = \"global\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.watcher_heartbeat.name}\""
      duration = "${var.heartbeat_absence_seconds}s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = concat([google_monitoring_notification_channel.email.id], var.extra_notification_channel_ids)

  alert_strategy {
    auto_close = "86400s"
  }
}

# Successful quiet runs count too. Failed collection, missing providers, failed
# P0 delivery or incomplete escalation deliberately do not publish this signal.
# Two hours allow the hourly interval plus bounded collection/escalation time.
resource "google_logging_metric" "monitor_heartbeat" {
  project = var.project_id
  name    = "self_healing_monitor_heartbeat"
  filter  = "logName=\"projects/${var.project_id}/logs/self-healing-monitor\" AND textPayload:\"MONITOR_HEARTBEAT success\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "monitor_dead_man" {
  project      = var.project_id
  display_name = "P1: self-healing monitor success absent 2h (dead-man)"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      The hourly monitor on `${var.vm_name}` has not completed successfully for
      two hours. The watcher/dispatcher heartbeats do not cover this process.
      A quiet collection emits success without inference; an empty queue is healthy.

      Check `/home/${var.agent_user}/.local/state/self-healing/monitor/last-session.json`,
      `last-triage-run.log`, and `journalctl -t self-healing-monitor`. Provider attempts
      are retained under `/var/log/self-healing-monitor`; inspect quota/auth state
      and pending `p0-outbox.json` deliveries. Verify the single hourly cron still
      points to `self-healing/monitor/run-monitor-session.sh`.
      Do not reset the VM for this signal: a model quota or tool failure needs
      diagnosis, not a reboot of a healthy host.
    EOT
  }

  conditions {
    display_name = "MONITOR_HEARTBEAT success absent 2h"
    condition_absent {
      filter   = "resource.type = \"global\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.monitor_heartbeat.name}\""
      duration = "7200s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }

  notification_channels = concat([google_monitoring_notification_channel.email.id], var.extra_notification_channel_ids)
  alert_strategy { auto_close = "86400s" }
}

resource "google_logging_metric" "product_output" {
  count   = var.product_output_filter == "" ? 0 : 1
  project = var.project_id
  name    = var.product_output_metric_name
  filter  = var.product_output_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "no_product_output" {
  count        = var.product_output_filter == "" ? 0 : 1
  project      = var.project_id
  display_name = "P0: Product output absent"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      No application output was observed during the configured absence window.
      Check the consumer detector and recent deployment intent before repairing.
    EOT
  }

  conditions {
    display_name = "Product output absent"

    condition_absent {
      filter   = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.product_output[0].name}\""
      duration = "${var.product_output_absence_seconds}s"

      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  notification_channels = concat([google_monitoring_notification_channel.email.id], var.extra_notification_channel_ids)

  alert_strategy {
    auto_close = "86400s"
  }
}

moved {
  from = google_logging_metric.meetings_saved
  to   = google_logging_metric.product_output[0]
}
moved {
  from = google_monitoring_alert_policy.no_meetings_saved
  to   = google_monitoring_alert_policy.no_product_output[0]
}
