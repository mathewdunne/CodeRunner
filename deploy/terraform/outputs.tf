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

output "deployer_service_account" {
  description = "Service account the GitHub Actions deploy workflow impersonates."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Full resource name of the WIF provider, used by google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}
