# SSH via IAP only (35.235.240.0/20 is Google's IAP forwarding range).
# Nothing else is opened: the dispatcher's :4100 trigger endpoint stays
# localhost-only (watcher and dispatcher are co-located on this VM), so
# there is deliberately NO public :4100 rule — GCP's implied ingress deny
# covers it.
resource "google_compute_firewall" "iap_ssh" {
  project = var.project_id
  name    = "${var.vm_name}-allow-iap-ssh"
  network = var.network

  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["self-healing"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
