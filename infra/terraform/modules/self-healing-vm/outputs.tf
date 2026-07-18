output "instance_name" {
  description = "Instance name (matches input vm_name)."
  value       = google_compute_instance.this.name
}

output "instance_self_link" {
  description = "Self-link of the GCE instance."
  value       = google_compute_instance.this.self_link
}

output "external_ip" {
  description = "External NAT IP of the instance (now the reserved static console IP)."
  value       = google_compute_instance.this.network_interface[0].access_config[0].nat_ip
}

output "console_static_ip" {
  description = "Reserved regional static external IP — the A-record target for console_domain."
  value       = google_compute_address.console.address
}

output "console_dns_record" {
  description = <<-EOT
    DNS record to create out-of-band (owner, via the Namecheap API). Format
    is a ready-to-read `<name> A <ip>` line, e.g. `console.joblander.app A
    34.x.y.z`. Namecheap's setHosts REPLACES all records — GET the full host
    list first, append this A record, then set the complete list.
  EOT
  value       = "${var.console_domain} A ${google_compute_address.console.address}"
}

output "service_account_email" {
  description = "Email of the dedicated self-healing-agent service account."
  value       = google_service_account.agent.email
}

output "zone" {
  description = "Zone the VM lives in."
  value       = google_compute_instance.this.zone
}
