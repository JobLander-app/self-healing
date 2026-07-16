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

module "self_healing" {
  source = "../modules/self-healing-vm"

  project_id = "meet-assistant-6d8ad"
  vm_name    = "self-healing-1"
  zone       = "europe-west1-b"
  region     = "europe-west1"

  alert_email = "sorokinvj@gmail.com"

  # Repos init.sh clones onto the VM (as user joblander).
  self_healing_repo_url = "https://github.com/JobLander-app/self-healing"
  meeting_lab_repo_url  = "https://github.com/JobLander-app/meeting-lab"
  workspace_repo_url    = "https://github.com/JobLander-app/workspace"
  repo_branch           = "main"

  # gh-auth token for cloning the private repos above (created 2026-07-16,
  # interim copy of the legacy VM token; replace with a machine identity
  # before cutover — TEST-PLAN stage 0.2).
  extra_secret_ids = ["self-healing-gh-token"]

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
  description = "Ephemeral NAT IP of self-healing-1."
  value       = module.self_healing.external_ip
}

output "service_account_email" {
  value = module.self_healing.service_account_email
}
