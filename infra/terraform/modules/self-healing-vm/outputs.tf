output "instance_name" {
  description = "Instance name (matches input vm_name)."
  value       = google_compute_instance.this.name
}

output "instance_self_link" {
  description = "Self-link of the GCE instance."
  value       = google_compute_instance.this.self_link
}

output "external_ip" {
  description = "Ephemeral external NAT IP (outbound-only; changes across stop/start)."
  value       = google_compute_instance.this.network_interface[0].access_config[0].nat_ip
}

output "service_account_email" {
  description = "Email of the dedicated self-healing-agent service account."
  value       = google_service_account.agent.email
}

output "zone" {
  description = "Zone the VM lives in."
  value       = google_compute_instance.this.zone
}
