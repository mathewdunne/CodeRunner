locals {
  # Derive the GHCR workspace image path from the repo owner — matches how
  # build-image.yml tags the image (ghcr.io/<owner>/coderunner-workspace).
  repo_owner      = split("/", var.github_repo)[0]
  workspace_image = "ghcr.io/${local.repo_owner}/coderunner-workspace:latest"

  # Cloud-init user-data is templated so var.domain, var.github_repo, etc. land
  # in the right places. Keep the substitution surface tiny on purpose; anything
  # secret comes from Secret Manager at boot, not from Terraform.
  user_data = templatefile("${path.module}/../cloud-init/user-data.yaml", {
    domain          = var.domain
    git_ref         = var.git_ref
    github_repo     = var.github_repo
    workspace_image = local.workspace_image
    instance_label  = var.instance_label
  })
}

resource "google_compute_instance" "coderunner" {
  name         = "coderunner"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["coderunner"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.boot_disk_size_gb
      type  = var.boot_disk_type
    }
  }

  attached_disk {
    source      = google_compute_disk.data.self_link
    device_name = "coderunner-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.coderunner.self_link
    access_config {
      nat_ip       = google_compute_address.coderunner.address
      network_tier = var.network_tier
    }
  }

  service_account {
    email = google_service_account.vm.email
    scopes = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]
  }

  metadata = {
    user-data      = local.user_data
    enable-oslogin = "TRUE"
    # Block legacy SSH keys path. OS Login is the only way in.
    block-project-ssh-keys = "TRUE"
  }

  # Allow stopping/starting without recreating the VM. Useful for resizes.
  allow_stopping_for_update = true

  # Re-render .env from Secret Manager on every boot, in case secrets rotated.
  # Only restart services if render-env.sh succeeded — a transient gcloud blip
  # must NOT silently swap in a broken .env.
  metadata_startup_script = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -x /opt/coderunner/render-env.sh ] && /opt/coderunner/render-env.sh; then
      systemctl restart coderunner alloy || true
    fi
  EOT

  depends_on = [
    google_secret_manager_secret_iam_member.vm_accessor,
  ]
}
