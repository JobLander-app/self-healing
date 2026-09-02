variable "project_id" { type = string }
variable "project_number" {
  type        = string
  description = "Needed to name the Google-managed service agents (monitoring notification, pubsub) that must be granted on the alert topic."
}
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "vm_name" {
  type        = string
  description = "The instance this watchdog may reset. Reset permission is granted on THIS instance only."
}
variable "vm_zone" { type = string }

variable "alert_email" {
  type        = string
  description = "Secondary channel. Telegram (via the relay) is the primary — email has never delivered an alert in this project."
}

variable "telegram_token_secret" {
  type    = string
  default = "telegram-alert-bot-token"
}
variable "telegram_chat_id_secret" {
  type    = string
  default = "telegram-default-chat-id"
}

variable "watcher_log_id" {
  type    = string
  default = "self-healing-watcher"
}
variable "dispatcher_log_id" {
  type    = string
  default = "self-healing-dispatcher"
}
variable "watchdog_log_id" {
  type    = string
  default = "self-healing-watchdog"
}

variable "schedule" {
  type        = string
  default     = "*/5 * * * *"
  description = "How often the watchdog checks. Five minutes bounds the worst-case detection delay; the 2026-08-26 outage ran for six days."
}

# Thresholds. Defaults are the values the function itself defaults to; they are
# surfaced here so a change is a reviewed diff and not an ssh edit.
variable "watcher_page_seconds" {
  type    = number
  default = 600
  validation {
    condition     = var.watcher_page_seconds >= 120
    error_message = "watcher_page_seconds must be >= 120 (the watcher ticks once a minute; anything tighter pages on noise)."
  }
}
variable "watcher_reset_seconds" {
  type    = number
  default = 900
}
variable "dispatcher_page_seconds" {
  type    = number
  default = 1800
}
variable "dispatcher_reset_seconds" {
  type    = number
  default = 3600
}
variable "reset_cooldown_seconds" {
  type    = number
  default = 1800
}
variable "reset_max_per_window" {
  type    = number
  default = 3
}
variable "reset_window_seconds" {
  type    = number
  default = 21600
}

variable "labels" {
  type    = map(string)
  default = {}
}
