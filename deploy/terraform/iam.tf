resource "google_service_account" "vm" {
  account_id   = "coderunner-vm"
  display_name = "CodeRunner VM runtime service account"
}

# VM can read its own logs and write to Cloud Logging (handy for journald shipping
# if you ever want it). Not strictly required — Alloy is the metrics path.
resource "google_project_iam_member" "vm_logwriter" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# ─── Workload Identity Federation for GitHub Actions ─────────────────────
# Allows the deploy.yml workflow in var.github_repo to impersonate the deploy SA
# without any long-lived service account key.

resource "google_service_account" "deployer" {
  account_id   = "coderunner-deployer"
  display_name = "GitHub Actions deploy SA"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github-pool"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.workflow_ref" = "assertion.workflow_ref"
  }

  # Only allow tokens from the deploy workflow in our specific repo on a
  # version tag. This prevents other workflows or unprotected branches from
  # minting credentials for the deployer SA.
  attribute_condition = <<-EOT
    assertion.repository == "${var.github_repo}" &&
    assertion.workflow_ref.startsWith("${var.github_repo}/.github/workflows/deploy.yml@refs/tags/v")
  EOT
}

resource "google_service_account_iam_member" "github_can_impersonate_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# Deployer SA needs to SSH via IAP and use OS Login to land on the VM.
resource "google_project_iam_member" "deployer_iap" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_oslogin" {
  project = var.project_id
  # Admin variant grants sudo on the VM — required because the deploy script
  # runs `sudo systemctl restart coderunner` and `sudo -u coderunner ...`.
  role   = "roles/compute.osAdminLogin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# OS Login on the VM only honors the deployer SA if it can act as the VM's SA.
resource "google_service_account_iam_member" "deployer_acts_as_vm_sa" {
  service_account_id = google_service_account.vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# Deployer needs to look up the instance by name to construct the SSH target.
resource "google_project_iam_member" "deployer_compute_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}
