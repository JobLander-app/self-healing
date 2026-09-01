output "watchdog_function_uri" {
  value = google_cloudfunctions2_function.watchdog.service_config[0].uri
}

output "telegram_notification_channel_id" {
  description = "Attach this to any alert policy that must actually reach a human."
  value       = google_monitoring_notification_channel.telegram.id
}

output "watchdog_service_account" {
  value = google_service_account.watchdog.email
}

output "state_bucket" {
  value = google_storage_bucket.state.name
}
