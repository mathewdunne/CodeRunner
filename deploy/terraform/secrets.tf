# Secret Manager containers. Values are populated manually after `terraform apply`
# via `gcloud secrets versions add`. The VM's render-env.sh reads them at boot
# (and on every restart) to materialize /opt/coderunner/.env.

locals {
  secrets = [
    "coderunner-better-auth-secret",
    "coderunner-github-client-id",
    "coderunner-github-client-secret",
    "coderunner-google-client-id",
    "coderunner-google-client-secret",
    "coderunner-admin-token",
    "coderunner-metrics-token",
    "coderunner-grafana-cloud-url",
    "coderunner-grafana-cloud-user",
    "coderunner-grafana-cloud-token",
  ]
}

resource "google_secret_manager_secret" "all" {
  for_each  = toset(local.secrets)
  secret_id = each.key

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "vm_accessor" {
  for_each  = google_secret_manager_secret.all
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}
