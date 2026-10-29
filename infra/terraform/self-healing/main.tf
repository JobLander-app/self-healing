terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
  backend "gcs" {}
}

provider "google" { project = var.project_id }
data "google_project" "selected" { project_id = var.project_id }

resource "google_project_service" "required" {
  for_each           = toset(["compute.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com", "secretmanager.googleapis.com", "cloudfunctions.googleapis.com", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "cloudscheduler.googleapis.com", "eventarc.googleapis.com", "pubsub.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

module "watchdog" {
  source         = "../modules/self-healing-watchdog"
  project_id     = var.project_id
  project_number = data.google_project.selected.number
  region         = var.region
  vm_name        = var.vm_name
  vm_zone        = var.zone
  instance_ready = module.self_healing.instance_name
  alert_email    = var.alert_email
  depends_on     = [google_project_service.required]
}

module "self_healing" {
  source                         = "../modules/self-healing-vm"
  project_id                     = var.project_id
  vm_name                        = var.vm_name
  region                         = var.region
  zone                           = var.zone
  alert_email                    = var.alert_email
  console_domain                 = var.console_domain
  self_healing_repo_url          = var.repo_url
  repo_branch                    = "main"
  consumer_profile               = var.consumer_profile
  agent_user                     = var.agent_user
  secret_ids                     = var.secret_ids
  firebase_enabled               = var.firebase_enabled
  deletion_protection            = true
  extra_notification_channel_ids = [module.watchdog.telegram_notification_channel_id]
  depends_on                     = [google_project_service.required]
}

module "dashboard" {
  source     = "../modules/self-healing-dashboard"
  project_id = var.project_id
  depends_on = [google_project_service.required]
}

output "instance_name" { value = module.self_healing.instance_name }
output "console_dns_record" { value = module.self_healing.console_dns_record }
output "external_ip" { value = module.self_healing.external_ip }
output "service_account_email" { value = module.self_healing.service_account_email }
output "dashboard_url" { value = module.dashboard.url }
