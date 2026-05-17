output "static_ip" {
  description = "Public IPv4 to point the A record at."
  value       = google_compute_address.coderunner.address
}

output "vm_name" {
  description = "Compute instance name. Use with `gcloud compute ssh`."
  value       = google_compute_instance.coderunner.name
}

output "vm_zone" {
  description = "Compute instance zone."
  value       = google_compute_instance.coderunner.zone
}

output "region" {
  description = "GCP region. Useful as a quick reference when setting the optional GCP_ZONE/GCP_VM_NAME repo variables."
  value       = var.region
}

output "zone" {
  description = "GCP zone (matches vm_zone). Plug into the GCP_ZONE repo variable for the deploy workflow."
  value       = var.zone
}

output "deployer_service_account" {
  description = "Service account the GitHub Actions deploy workflow impersonates."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Full resource name of the WIF provider, used by google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}
