variable "project_id" {
  description = "GCP project that owns the self-healing VM."
  type        = string
}

variable "vm_name" {
  description = <<-EOT
    Instance name. Also used for the boot disk (`<vm_name>`) and as a
    prefix for the service-account display name. Phase 2/3 convention:
    `self-healing-1`. The legacy `joblander-agents` VM is NOT managed
    here and must never be imported into this module (cutover = Phase 4,
    owner signal only).
  EOT
  type        = string
  default     = "self-healing-1"
}

variable "zone" {
  description = "Zone the VM lives in (e.g. `europe-west1-b`)."
  type        = string
}

variable "region" {
  description = "Region the zone lives in (e.g. `europe-west1`)."
  type        = string
}

variable "machine_type" {
  description = "GCE machine type. Same class as the legacy agents VM."
  type        = string
  default     = "e2-standard-2"
}

variable "boot_disk_size_gb" {
  description = "Boot disk size in GB."
  type        = number
  default     = 50
}

variable "boot_disk_type" {
  description = "Persistent-disk type for the boot disk."
  type        = string
  default     = "pd-balanced"
  validation {
    condition     = contains(["pd-standard", "pd-balanced", "pd-ssd"], var.boot_disk_type)
    error_message = "boot_disk_type must be one of: pd-standard, pd-balanced, pd-ssd."
  }
}

variable "boot_disk_image" {
  description = <<-EOT
    Image family for the boot disk. Ubuntu 22.04 LTS family pointer —
    same convention as the livekit-vm module (family tracks LTS security
    updates; the disk resource ignores image drift after creation).
  EOT
  type        = string
  default     = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts"
}

variable "network" {
  description = "VPC network self-link or short name."
  type        = string
  default     = "default"
}

variable "subnetwork" {
  description = "Subnetwork self-link or short name."
  type        = string
  default     = "default"
}

variable "labels" {
  description = "Resource labels applied to VM and boot disk."
  type        = map(string)
  default     = {}
}

variable "service_account_id" {
  description = "account_id of the dedicated service account created for the VM."
  type        = string
  default     = "self-healing-agent"
}

variable "secret_ids" {
  description = <<-EOT
    Secret Manager secret_ids the VM's SA gets `secretAccessor` on —
    per-secret IAM instead of a project-wide secretmanager.secretAccessor
    role (least privilege). All six existed in the project as of
    2026-07-15 (verified via `gcloud secrets list`); granting IAM on a
    nonexistent secret fails the apply, so anything not-yet-created goes
    in `extra_secret_ids` instead.
  EOT
  type        = list(string)
  default = [
    "self-healing-dispatcher-env",
    "self-healing-trigger-token",
    "HEALTH_OUTPUT_HMAC_KEY",
    "linear-api-key",
    "joblander-sentry-monitor-token",
    "qa-test-user-password",
  ]
}

variable "extra_secret_ids" {
  description = <<-EOT
    Additional secret_ids to grant `secretAccessor` on. Add the gh-auth
    token secret (see `gh_token_secret`) here once the owner creates it —
    it did not exist as of 2026-07-15, and init.sh fails soft without it.
  EOT
  type        = list(string)
  default     = []
}

variable "logs_bucket" {
  description = "GCS bucket the agents write session logs / reports to. SA gets objectAdmin on this bucket ONLY."
  type        = string
  default     = "joblander-agent-logs"
}

variable "alert_email" {
  description = "Email address for the module's monitoring notification channel (dead-man + meetings-saved backstop)."
  type        = string
}

variable "self_healing_repo_url" {
  description = "HTTPS clone URL of this repo (cloned to /home/joblander/self-healing)."
  type        = string
  default     = "https://github.com/JobLander-app/self-healing"
}

variable "workspace_repo_url" {
  description = "HTTPS clone URL of the workspace repo (cloned to /home/joblander/workspace — dispatcher agents need its task-file dirs, notify.sh and the monitor launcher)."
  type        = string
  default     = "https://github.com/JobLander-app/workspace"
}

variable "repo_branch" {
  description = "Branch init.sh checks out in all three repos."
  type        = string
  default     = "main"
}

variable "dispatcher_env_secret" {
  description = "Secret Manager secret_id holding the full dispatcher .env (rendered to dispatcher/.env by init.sh, chmod 600)."
  type        = string
  default     = "self-healing-dispatcher-env"
}

variable "gh_token_secret" {
  description = <<-EOT
    Secret Manager secret_id holding a GitHub token for `gh auth login
    --with-token` on the VM. May not exist yet — init.sh fails soft and
    writes a TODO. When created, also append it to `extra_secret_ids`.
  EOT
  type        = string
  default     = "self-healing-gh-token"
}

variable "heartbeat_log_id" {
  description = <<-EOT
    Cloud Logging log id the watcher cron writes its heartbeat to
    (`gcloud logging write <log_id> "WATCHER_HEARTBEAT ..."` after every
    successful tick — see deploy/cron/self-healing.crontab). The dead-man
    alert fires when this metric is absent for
    `heartbeat_absence_seconds`.
  EOT
  type        = string
  default     = "self-healing-watcher"
}

variable "heartbeat_absence_seconds" {
  description = "Dead-man alert: seconds of WATCHER_HEARTBEAT absence before the policy fires."
  type        = number
  default     = 300
}

# ---- observability console (JOB-731 observability v1) -----------------------

variable "console_domain" {
  description = <<-EOT
    Public FQDN the observability console is served on. Caddy issues a
    Let's Encrypt cert for it and reverse-proxies to Grafana; Grafana's
    root_url is set to https://<console_domain>. An A record pointing this
    name at the reserved static IP must be created out-of-band (surfaced as
    the `console_dns_record` output + a POST-INIT-TODO line — the owner adds
    it via the Namecheap API, same precedent as *.mcp.joblander.app).
  EOT
  type        = string
  default     = "console.joblander.app"
}

variable "grafana_admin_secret" {
  description = <<-EOT
    Secret Manager secret_id holding the seeded Grafana admin password.
    init.sh reads it and renders GF_SECURITY_ADMIN_PASSWORD into a
    root-only systemd EnvironmentFile (never committed, never in grafana.ini
    on disk). The VM's SA is granted secretAccessor on it (iam.tf). The
    secret must exist before `terraform apply` (granting IAM on a
    nonexistent secret fails the apply); init.sh fails soft with a TODO if
    the value is unreadable at boot.
  EOT
  type        = string
  default     = "self-healing-grafana-admin"
}

variable "grafana_google_oauth_client_id_secret" {
  description = <<-EOT
    OPTIONAL (v2). Secret Manager secret_id holding the Google OAuth client
    id for Grafana SSO. Empty for v1 (admin-login only). When set, the SA is
    granted secretAccessor on it; wiring OAuth into grafana.ini is a
    follow-up (owner supplies the OAuth client).
  EOT
  type        = string
  default     = ""
}

variable "grafana_google_oauth_client_secret_secret" {
  description = <<-EOT
    OPTIONAL (v2). Secret Manager secret_id holding the Google OAuth client
    secret for Grafana SSO. Empty for v1. Granted secretAccessor when set.
  EOT
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = <<-EOT
    GCE deletion-protection. Defaults to FALSE while this is the
    parallel-run VM (Phase 3): destroy/recreate must stay cheap.
    Flip to true at cutover (Phase 4).
  EOT
  type        = bool
  default     = false
}
