terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0, < 7.0"
    }
  }
  # Separate bootstrap state: this root cannot update the VM or its disk.
  backend "gcs" {
    bucket = "meet-assistant-6d8ad-tfstate"
    prefix = "self-healing-deploy-access"
  }
}

provider "google" {
  project = "meet-assistant-6d8ad"
}

locals {
  project = "meet-assistant-6d8ad"
  zone    = "europe-west1-b"
  vm      = "self-healing-1"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account" "deploy" {
  project      = local.project
  account_id   = "self-healing-deploy"
  display_name = "Self-healing reviewed GitHub deployment"
  depends_on   = [google_project_service.required]
}

# The existing pool only accepts the JobLander-app organization. This binding
# narrows it to this repository's main branch, excluding PR and fork tokens.
# Match the repository's OIDC sub_claim_prefix, including immutable owner/repo IDs.
resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/projects/255174193709/locations/global/workloadIdentityPools/github-actions/subject/repo:JobLander-app@181870937/self-healing@1301755140:ref:refs/heads/main"
}

# This host uses metadata SSH keys, not OS Login. gcloud installs an expiring
# public key on this one instance; it cannot change project-wide SSH metadata.
resource "google_project_iam_custom_role" "ssh" {
  project     = local.project
  role_id     = "selfHealingDeploySsh"
  title       = "Self-healing deployment SSH metadata"
  permissions = ["compute.instances.get", "compute.instances.setMetadata"]
}

resource "google_compute_instance_iam_member" "ssh" {
  project       = local.project
  zone          = local.zone
  instance_name = local.vm
  role          = google_project_iam_custom_role.ssh.name
  member        = local.member
}

resource "google_project_iam_member" "discover" {
  project = local.project
  role    = "roles/compute.viewer"
  member  = local.member
}

resource "google_project_service" "required" {
  for_each           = toset(["iap.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com"])
  project            = local.project
  service            = each.value
  disable_on_destroy = false
}

resource "google_iap_tunnel_instance_iam_member" "ssh" {
  project    = local.project
  zone       = local.zone
  instance   = local.vm
  role       = "roles/iap.tunnelResourceAccessor"
  member     = local.member
  depends_on = [google_project_service.required]
}

resource "google_service_account_iam_member" "runtime_identity" {
  service_account_id = "projects/${local.project}/serviceAccounts/self-healing-agent@${local.project}.iam.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = local.member
}
