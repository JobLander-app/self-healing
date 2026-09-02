# Alerting for the self-healing loop itself — "who watches the watcher".
#
# Two absence (dead-man style) policies:
#   1. WATCHER_HEARTBEAT absent 5 min  → the watcher cron is dead/broken.
#   2. meetings_saved absent 4h        → product-level STT outage backstop
#      (codifies the hand-made JOB-651 policy; the hand-made one stays
#      until cutover, Phase 4 — resources here use distinct names so the
#      two coexist).

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
  display_name = "P0: self-healing watcher heartbeat absent ${var.heartbeat_absence_seconds / 60} min (dead-man) — JOB-731"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      The output-watcher on the `${var.vm_name}` VM has not written a
      `WATCHER_HEARTBEAT` Cloud Logging entry for ${var.heartbeat_absence_seconds / 60}+ minutes.
      The watcher is the layer that pages on product-output death (JOB-670);
      if it is dead, prod outages go unnoticed (JOB-651 class).

      Check, in order:
      1. VM up? `gcloud compute instances describe ${var.vm_name} --zone=<zone>`
      2. Cron running? `ssh` (via IAP) → `crontab -l -u joblander`, `tail /home/joblander/output-watch.log`
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

# --- 2. Backstop: no meetings saved for 4h (JOB-651) ------------------------
#
# Codified from the hand-made policy
# `projects/.../alertPolicies/5688661871276971454` ("P0: No meetings saved
# for 4h (product-level STT outage) — JOB-651", introspected 2026-07-15).
# Differences vs the hand-made one, on purpose:
#   - distinct metric/policy names (coexistence until Phase 4 cutover);
#   - absence duration 14400s = the 4h the display name promises (the
#     hand-made policy actually has 21600s and is currently DISABLED);
#   - notifies this module's email channel (the hand-made one uses a
#     Telegram webhook channel that embeds a bot token — not codified).

resource "google_logging_metric" "meetings_saved" {
  project = var.project_id
  name    = "self_healing_meetings_saved"
  filter  = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"joblander-audio-engine\" AND jsonPayload.message.message:\"Meeting log saved\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "no_meetings_saved" {
  project      = var.project_id
  display_name = "P0: No meetings saved for 4h (product-level STT outage) — JOB-651 [terraform]"
  combiner     = "OR"

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Не сохранено НИ ОДНОГО митинга за 4 часа во всех регионах
      joblander-audio-engine. Это продуктовый отказ уровня JOB-651
      (19h silent STT outage): сессии могут идти и выглядеть здоровыми,
      но транскрипций нет.

      Проверить: STT_VAD_GATE env, логи 'Skipping meeting save',
      STT_VAD_GATE_SESSION_SUMMARY (audioSecondsIn vs wall-clock),
      Google STT квоты/ошибки. Быстрый срез: skill `health-output` /
      `/health/output` per region.
    EOT
  }

  conditions {
    display_name = "meetings_saved metric absent 4h"

    condition_absent {
      filter   = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.meetings_saved.name}\""
      duration = "14400s"

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
