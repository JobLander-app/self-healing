
terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
  backend "gcs" {
    bucket = "meet-assistant-6d8ad-tfstate"
    prefix = "self-healing"
  }
}

provider "google" {
  project = "meet-assistant-6d8ad"
}

locals {
  project_id     = "meet-assistant-6d8ad"
  project_number = "255174193709"
  vm_name        = "self-healing-1"
  zone           = "europe-west1-b"
  region         = "europe-west1"
  alert_email    = "sorokinvj@gmail.com"
}

module "watchdog" {
  source = "../../../infra/terraform/modules/self-healing-watchdog"

  project_id     = local.project_id
  project_number = local.project_number
  region         = local.region
  vm_name        = local.vm_name
  vm_zone        = local.zone
  instance_ready = module.self_healing.instance_name
  alert_email    = local.alert_email

  labels = {
    purpose = "self-healing-loop"
    ticket  = "job-731"
  }
}

module "self_healing" {
  source = "../../../infra/terraform/modules/self-healing-vm"

  project_id = "meet-assistant-6d8ad"
  vm_name    = "self-healing-1"
  zone       = "europe-west1-b"
  region     = "europe-west1"

  alert_email = "sorokinvj@gmail.com"

  # Email alone has never delivered an alert in this project; route the loop's
  # dead-man and the product backstop through the relay that does.
  extra_notification_channel_ids = [module.watchdog.telegram_notification_channel_id]

  self_healing_repo_url      = "https://github.com/JobLander-app/self-healing"
  consumer_profile           = "consumers/joblander/profile.json"
  agent_user                 = "joblander"
  firebase_enabled           = true
  console_domain             = "self-healing.joblander.app"
  logs_bucket                = "joblander-agent-logs"
  secret_ids                 = ["self-healing-dispatcher-env", "self-healing-trigger-token", "HEALTH_OUTPUT_HMAC_KEY", "linear-api-key", "joblander-sentry-monitor-token", "qa-test-user-password"]
  product_output_filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"joblander-audio-engine\" AND jsonPayload.message.message:\"Meeting log saved\""
  product_output_metric_name = "self_healing_meetings_saved"
  repo_branch                = "main"

  extra_secret_ids = ["self-healing-gh-token", "self-healing-workspace-env", "claude-code-oauth-token"]

  # Parallel-run phase: keep the VM cheap to destroy/recreate.
  # Flip to true at cutover (Phase 4).
  deletion_protection = false

  chatwoot_domain = "chat.joblander.app"

  labels = {
    purpose = "self-healing-loop"
    ticket  = "job-731"
  }
}

output "instance_name" {
  value = module.self_healing.instance_name
}

output "external_ip" {
  description = "External NAT IP of self-healing-1 (reserved static console IP)."
  value       = module.self_healing.external_ip
}

output "console_static_ip" {
  description = "Reserved static IP the console_domain A record must point at."
  value       = module.self_healing.console_static_ip
}

output "console_dns_record" {
  description = "DNS record to create (owner, via Namecheap API): self-healing.joblander.app A <ip>."
  value       = module.self_healing.console_dns_record
}

output "service_account_email" {
  value = module.self_healing.service_account_email
}

output "watchdog_function_uri" {
  description = "Cloud Scheduler target. Invoke by hand with: gcloud scheduler jobs run self-healing-watchdog --location=europe-west1"
  value       = module.watchdog.watchdog_function_uri
}

output "telegram_notification_channel_id" {
  description = "Attach to any alert policy that must actually reach a human."
  value       = module.watchdog.telegram_notification_channel_id
}

module "dashboard" {
  source     = "../../../infra/terraform/modules/self-healing-dashboard"
  project_id = local.project_id
}
output "dashboard_url" { value = module.dashboard.url }
