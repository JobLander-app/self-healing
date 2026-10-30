variable "project_id" { type = string }

resource "google_logging_metric" "runs" {
  project = var.project_id
  name    = "self_healing_runs"
  filter  = "logName=\"projects/${var.project_id}/logs/self-healing-events\" AND jsonPayload.event=\"run.finished\" AND jsonPayload.dryRun=false"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "outcome"
      value_type  = "STRING"
      description = "Dispatcher outcome; fixed means merged, not verified production recovery."
    }
  }
  label_extractors = { outcome = "EXTRACT(jsonPayload.outcome)" }
}

resource "google_logging_metric" "duration" {
  project         = var.project_id
  name            = "self_healing_run_duration_seconds"
  filter          = "logName=\"projects/${var.project_id}/logs/self-healing-events\" AND jsonPayload.event=\"run.finished\" AND jsonPayload.dryRun=false"
  value_extractor = "EXTRACT(jsonPayload.durationSec)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 18
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_logging_metric" "dispatcher_heartbeat" {
  project = var.project_id
  name    = "self_healing_dispatcher_heartbeat"
  filter  = "logName=\"projects/${var.project_id}/logs/self-healing-dispatcher\" AND textPayload:\"DISPATCHER_HEARTBEAT\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

locals {
  counters = [
    { title = "Completed investigations by outcome (fixed = merged)", metric = google_logging_metric.runs.name, group = ["metric.label.outcome"] },
    { title = "Watcher heartbeats", metric = "self_healing_watcher_heartbeat", group = [] },
    { title = "Monitor successful cycles", metric = "self_healing_monitor_heartbeat", group = [] },
    { title = "Dispatcher liveness (not provider readiness)", metric = google_logging_metric.dispatcher_heartbeat.name, group = [] },
  ]
}

resource "google_monitoring_dashboard" "loop" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "Self-healing loop"
    gridLayout = { columns = 2, widgets = concat([
      { title = "Reading this dashboard", text = { format = "MARKDOWN", content = "Operational telemetry, not billing or proof of production recovery. Run duration measures investigation time. A fixed result means a merged change; monitor/reclaim verification follows deployment. Dry-run investigations are excluded. Metrics populate after installation and activity. Delivery is at least once; a lost acknowledgment can overcount. The local usage ledger remains the accounting source." } }
      ], [for item in local.counters : {
        title = item.title
        xyChart = {
          dataSets = [{ plotType = "STACKED_BAR", timeSeriesQuery = { timeSeriesFilter = {
            filter      = "resource.type=\"global\" AND metric.type=\"logging.googleapis.com/user/${item.metric}\""
            aggregation = { alignmentPeriod = "300s", perSeriesAligner = "ALIGN_SUM", crossSeriesReducer = "REDUCE_SUM", groupByFields = item.group }
          } } }]
          yAxis = { label = "Events / 5 min", scale = "LINEAR" }
        }
        }], [{ title = "Investigation duration p95 (not time to recovery)", xyChart = {
          dataSets = [{ plotType = "LINE", timeSeriesQuery = { timeSeriesFilter = {
            filter      = "resource.type=\"global\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.duration.name}\""
            aggregation = { alignmentPeriod = "3600s", perSeriesAligner = "ALIGN_PERCENTILE_95" }
          } } }]
          yAxis = { label = "Seconds", scale = "LINEAR" }
    } }]) }
  })
}

output "url" {
  value = "https://console.cloud.google.com/monitoring/dashboards/builder/${basename(google_monitoring_dashboard.loop.id)}?project=${var.project_id}"
}
