# Root for the self-healing loop VM (JOB-731 Phase 2).
# Mirrors the per-root convention of ai-voice-agent-python/infra/terraform:
# shared state bucket, distinct prefix per root.
#
# Provision:   terraform init && terraform apply     (from this directory)
# NEVER import or reference the legacy `joblander-agents` VM here — this
# root owns only the NEW parallel VM. Cutover is Phase 4, owner signal only.

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

# Off-box watchdog + working alert delivery (incident 2026-08-26).
#
# Declared BEFORE the VM module and deliberately depending only on literals:
# the VM module consumes this module's Telegram channel, so any dependency in
# the other direction would be a cycle. Consequence, on a from-scratch
# bootstrap only: google_compute_instance_iam_member here is applied before the
# instance exists and fails once — re-run `terraform apply` and it settles.
# Incremental applies (the normal case) are unaffected.
module "watchdog" {
  source = "../modules/self-healing-watchdog"

  project_id     = local.project_id
  project_number = local.project_number
  region         = local.region
  vm_name        = local.vm_name
  vm_zone        = local.zone
  alert_email    = local.alert_email

  labels = {
    purpose = "self-healing-loop"
    ticket  = "job-731"
  }
}

module "self_healing" {
  source = "../modules/self-healing-vm"

  project_id = "meet-assistant-6d8ad"
  vm_name    = "self-healing-1"
  zone       = "europe-west1-b"
  region     = "europe-west1"

  alert_email = "sorokinvj@gmail.com"

  # Email alone has never delivered an alert in this project; route the loop's
  # dead-man and the product backstop through the relay that does.
  extra_notification_channel_ids = [module.watchdog.telegram_notification_channel_id]

  # Repos init.sh clones onto the VM (as user joblander).
  self_healing_repo_url = "https://github.com/JobLander-app/self-healing"
  workspace_repo_url    = "https://github.com/JobLander-app/workspace"
  repo_branch           = "main"

  # gh-auth token for cloning the private repos above (created 2026-07-16,
  # interim copy of the legacy VM token; replace with a machine identity
  # before cutover — TEST-PLAN stage 0.2).
  extra_secret_ids = ["self-healing-gh-token", "self-healing-workspace-env", "claude-code-oauth-token"]

  # Parallel-run phase: keep the VM cheap to destroy/recreate.
  # Flip to true at cutover (Phase 4).
  deletion_protection = false

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
