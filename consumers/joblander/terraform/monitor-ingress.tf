module "monitor_ingress" {
  source         = "../../../infra/terraform/modules/self-healing-monitor-ingress"
  project_id     = local.project_id
  project_number = local.project_number
  endpoint       = "https://self-healing.joblander.app/monitor/alerts"
  trigger_config = jsondecode(file("${path.module}/../monitor-trigger.json"))
}

# Two-stage migration: first provision + prove authenticated delivery and a real
# monitor run, then remove the covered services from the old raw paging policy.
# Unmonitored Cloud Run services retain their existing alert coverage.
variable "monitor_ingress_cutover" {
  type    = bool
  default = true
}

locals {
  monitored_services = jsondecode(file("${path.module}/../targets.json")).cloud_run_services
  legacy_filter = var.monitor_ingress_cutover ? join(" && ", concat(
    ["response_code_class == \"5xx\""],
    [for name in local.monitored_services : "resource.service_name != ${jsonencode(name)}"]
  )) : "response_code_class == \"5xx\""
}

import {
  to = google_monitoring_alert_policy.legacy_5xx
  id = "projects/meet-assistant-6d8ad/alertPolicies/2229651012700085609"
}

resource "google_monitoring_alert_policy" "legacy_5xx" {
  project      = local.project_id
  display_name = "🚨 JobLander Cloud Run 5xx Alert"
  enabled      = true
  severity     = "CRITICAL"
  combiner     = "OR"
  user_labels  = { project = "joblander-app" }
  conditions {
    display_name = "New condition"
    condition_monitoring_query_language {
      duration = "0s"
      query    = "fetch cloud_run_revision\n| metric 'run.googleapis.com/request_count'\n| filter (${local.legacy_filter})\n| group_by 1m, [value_request_count_aggregate: aggregate(value.request_count)]\n| condition val() > 5"
      trigger { count = 1 }
    }
  }
  documentation { subject = "🚨 JobLander Cloud Run 5xx Alert" }
  alert_strategy {
    auto_close           = "86400s"
    notification_prompts = ["OPENED"]
  }
  notification_channels = ["projects/meet-assistant-6d8ad/notificationChannels/12522190450093504822"]
  # Preserve the existing subject-only documentation exactly on import; the
  # provider otherwise fills an empty MIME type even before the cutover.
  lifecycle { ignore_changes = [documentation] }
}

output "monitor_topic" { value = module.monitor_ingress.topic }
