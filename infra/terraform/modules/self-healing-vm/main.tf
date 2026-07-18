# Self-healing loop VM (JOB-731 Phase 2 + observability v1).
#
# Creates a NEW parallel VM — the legacy `joblander-agents` VM is
# deliberately NOT managed, imported or referenced here. Cutover from the
# legacy VM is Phase 4 and happens only on explicit owner signal.
#
# Static external IP: the VM now also hosts the public observability
# console (Grafana behind Caddy on `console_domain`), so the external IP
# must be STABLE — it is the A-record target for `console_domain`. The
# regional `google_compute_address` below is reserved and pinned with
# prevent_destroy so a DNS'd IP cannot silently vanish. The console is the
# ONLY public surface: 80/443 (Caddy) are the only firewall openings; the
# dispatcher :4100, Prometheus :9090, Grafana :3000 and node_exporter :9100
# all stay localhost-only. Everything else stays outbound-only (the loop
# polls /health/output, calls Linear/Telegram/GitHub APIs) and SSH is IAP.

# Boot disk declared as a separate resource (not inline) — same convention
# as modules/livekit-vm in ai-voice-agent-python: disk identity survives
# instance rebuilds and operational tooling can manipulate it without
# Terraform wanting to recreate the instance.
resource "google_compute_disk" "boot" {
  project = var.project_id
  name    = var.vm_name
  zone    = var.zone
  size    = var.boot_disk_size_gb
  type    = var.boot_disk_type
  image   = var.boot_disk_image
  labels  = var.labels

  lifecycle {
    # `image` is a family pointer; the resolved image SHA on the disk will
    # drift from the family as new LTS point releases ship. Without this,
    # Terraform would call for destroy+recreate on every apply.
    ignore_changes = [image]
  }
}

# Reserved regional static external IP — the A-record target for
# `console_domain`. prevent_destroy: a public, DNS'd IP must not vanish on
# a `terraform destroy` / instance rebuild (recreating it hands out a NEW
# address and breaks TLS + the console until DNS is re-pointed).
resource "google_compute_address" "console" {
  project      = var.project_id
  name         = "${var.vm_name}-console"
  region       = var.region
  address_type = "EXTERNAL"
  labels       = var.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "this" {
  project      = var.project_id
  name         = var.vm_name
  zone         = var.zone
  machine_type = var.machine_type
  # Network tag drives the IAP-SSH firewall rule in firewall.tf —
  # do not rename one without the other.
  tags   = ["self-healing"]
  labels = var.labels

  boot_disk {
    # auto_delete=false so a gcloud-side instance delete does not cascade
    # to the boot disk (same rationale as livekit-vm, Codex P1 on PR #62).
    auto_delete = false
    source      = google_compute_disk.boot.self_link
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    # Pin the reserved static IP (was ephemeral) — it is the console DNS
    # target, so it must survive stop/start and instance rebuilds.
    access_config {
      nat_ip = google_compute_address.console.address
    }
  }

  service_account {
    email = google_service_account.agent.email
    # Broad scope, capabilities governed by the SA's minimal IAM (iam.tf).
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  metadata = {
    # Idempotent provisioning — the whole loop stands up from this script.
    # Re-runs are safe: `sudo google_metadata_script_runner startup`.
    startup-script = templatefile("${path.module}/../../../../init/init.sh", {
      project_id            = var.project_id
      self_healing_repo_url = var.self_healing_repo_url
      workspace_repo_url    = var.workspace_repo_url
      repo_branch           = var.repo_branch
      dispatcher_env_secret = var.dispatcher_env_secret
      gh_token_secret       = var.gh_token_secret
      console_domain        = var.console_domain
      grafana_admin_secret  = var.grafana_admin_secret
    })
  }

  # Allow machine-type bumps etc. without manual stop/start choreography.
  allow_stopping_for_update = true

  deletion_protection = var.deletion_protection

  # SA needs its secret/bucket/logging grants before first boot runs init.
  depends_on = [
    google_secret_manager_secret_iam_member.secrets,
    google_storage_bucket_iam_member.logs_bucket,
    google_project_iam_member.roles,
  ]
}
