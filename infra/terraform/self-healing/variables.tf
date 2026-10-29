variable "project_id" { type = string }
variable "alert_email" { type = string }
variable "console_domain" { type = string }
variable "repo_url" { type = string }
variable "consumer_profile" { type = string }
variable "secret_ids" { type = list(string) }
variable "firebase_enabled" {
  type    = bool
  default = false
}
variable "agent_user" {
  type    = string
  default = "selfheal"
}
variable "vm_name" {
  type    = string
  default = "self-healing-1"
}
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "zone" {
  type    = string
  default = "europe-west1-b"
}
