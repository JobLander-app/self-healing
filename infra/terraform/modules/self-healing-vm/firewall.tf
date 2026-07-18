# SSH via IAP only (35.235.240.0/20 is Google's IAP forwarding range).
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

# Public HTTP/HTTPS for the observability console.
#
# WHY 80 AND 443 ONLY, PUBLIC:
#   Caddy terminates TLS on :443 and reverse-proxies to Grafana on
#   localhost:3000. The console is protected by GRAFANA'S OWN AUTH (admin
#   login; Google OAuth is a v2 follow-up) — that is the security boundary,
#   NOT the firewall. Port 80 is required for Caddy's ACME HTTP-01
#   challenge (Let's Encrypt cert issuance/renewal) and the http->https
#   redirect.
#
# WHY NOTHING ELSE IS OPENED:
#   Caddy is the ONLY public listener. Every other service binds to
#   127.0.0.1 and is deliberately absent from any firewall rule —
#     dispatcher trigger :4100, Prometheus :9090, Grafana :3000,
#     node_exporter :9100
#   GCP's implied ingress-deny keeps them unreachable from the internet.
#   Do NOT add rules for those ports.
resource "google_compute_firewall" "console_https" {
  project = var.project_id
  name    = "${var.vm_name}-allow-console-https"
  network = var.network

  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["self-healing"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}
