variable "project_id" {
  description = "GCP project that owns the self-healing VM."
  type        = string
}

variable "vm_name" {
  type    = string
  default = "self-healing-1"
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
  description = "Existing secrets this VM may read; values never enter Terraform state."
  type        = list(string)
  default     = ["self-healing-dispatcher-env", "self-healing-trigger-token", "self-healing-output-hmac", "linear-api-key", "self-healing-telegram-env", "self-healing-gh-token", "claude-code-oauth-token"]
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
  description = "Optional existing session-log bucket. Empty grants no bucket access."
  type        = string
  default     = ""
}


variable "alert_email" {
  description = "Email address for the module's monitoring notification channel (dead-man + meetings-saved backstop)."
  type        = string
}

variable "self_healing_repo_url" {
  description = "HTTPS clone URL of your self-healing fork."
  type        = string
}


variable "consumer_profile" {
  description = "Profile path relative to the self-healing checkout."
  type        = string
}

variable "agent_user" {
  type    = string
  default = "selfheal"
  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,30}$", var.agent_user))
    error_message = "agent_user must be a Linux account name."
  }
}

variable "firebase_enabled" {
  description = "Grant read-only Firestore access only when the Firebase integration is selected."
  type        = bool
  default     = false
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


variable "console_domain" {
  description = "FQDN of the Grafana console; its A record must point to console_static_ip."
  type        = string
}


variable "chatwoot_domain" {
  description = <<-EOT
    Optional second FQDN served by the same Caddy: the Chatwoot support app,
    reverse-proxied to `chatwoot_upstream_port` on localhost. Chatwoot was
    consolidated onto this VM on 2026-09-14 (its own e2-small was retired to
    save ~20 EUR/mo), and without this the vhost lives only as a hand-edit in
    /etc/caddy/Caddyfile that the next `terraform apply` would silently wipe,
    taking customer support down.

    Empty (the default) means no Chatwoot vhost is rendered. Keep it empty for
    any VM this module builds other than self-healing-1: Caddy would otherwise
    request a Let's Encrypt cert for a name whose DNS does not point at that
    host, failing the HTTP-01 challenge on a loop and burning LE rate limit.
  EOT
  type        = string
  default     = ""
}

variable "chatwoot_upstream_port" {
  description = <<-EOT
    localhost port the Chatwoot rails container publishes. 3000 is taken by
    Grafana on this VM, so the docker compose stack at /opt/chatwoot publishes
    127.0.0.1:3100. Only read when `chatwoot_domain` is non-empty.
  EOT
  type        = number
  default     = 3100
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

variable "extra_notification_channel_ids" {
  type        = list(string)
  default     = []
  description = <<-EOT
    Additional notification channels for this module's alert policies.

    The module's own channel is email, and in this project email has never
    delivered a Cloud Monitoring alert — the 2026-08-26 dead-man fired into it
    and nothing arrived, which is why a six-day outage went unnoticed. The root
    passes the Pub/Sub->relay->Telegram channel here so these policies reach a
    human on a path that is verified end to end.
  EOT
}

variable "product_output_filter" {
  description = "Optional application output backstop: Cloud Logging filter. Empty disables it."
  type        = string
  default     = ""
}
variable "product_output_metric_name" {
  type    = string
  default = "self_healing_product_output"
}
variable "product_output_absence_seconds" {
  type    = number
  default = 14400
}
