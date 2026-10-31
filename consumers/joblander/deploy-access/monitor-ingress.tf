# Owner bootstrap after the ingress build creates its topic and push identity.
# The build can manage IAM only on these two resources; no project-wide IAM
# administrator, token creator or runtime permissions are granted to the build.
resource "google_project_iam_custom_role" "monitor_push_policy" {
  project     = local.project
  role_id     = "selfHealingMonitorPushPolicy"
  title       = "Manage monitor push identity policy"
  permissions = ["iam.serviceAccounts.getIamPolicy", "iam.serviceAccounts.setIamPolicy"]
}

resource "google_service_account_iam_member" "monitor_push_policy" {
  service_account_id = "projects/${local.project}/serviceAccounts/self-healing-monitor-push@${local.project}.iam.gserviceaccount.com"
  role               = google_project_iam_custom_role.monitor_push_policy.name
  member             = "serviceAccount:255174193709-compute@developer.gserviceaccount.com"
}

resource "google_project_iam_custom_role" "monitor_topic_policy" {
  project     = local.project
  role_id     = "selfHealingMonitorTopicPolicy"
  title       = "Manage monitor topic policy"
  permissions = ["pubsub.topics.getIamPolicy", "pubsub.topics.setIamPolicy"]
}

resource "google_pubsub_topic_iam_member" "monitor_topic_policy" {
  project = local.project
  topic   = "self-healing-monitor-errors"
  role    = google_project_iam_custom_role.monitor_topic_policy.name
  member  = "serviceAccount:255174193709-compute@developer.gserviceaccount.com"
}
