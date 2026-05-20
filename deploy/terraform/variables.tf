variable "project_id" {
  description = "GCP project ID hosting the deployment."
  type        = string
}

variable "region" {
  description = "GCP region for regional resources."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for the VM and persistent disk."
  type        = string
  default     = "us-central1-a"
}

variable "domain" {
  description = "Public hostname users will visit (A record points here). Used by Caddy for TLS and by Better Auth for OAuth callbacks."
  type        = string
}

variable "github_repo" {
  description = "owner/repo of the GitHub repository allowed to deploy via Workload Identity Federation. Required — must match the repo you're deploying from. The owner half is also used to derive the GHCR workspace image path."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repo))
    error_message = "github_repo must be in owner/repo format (e.g. yourname/CodeRunner)."
  }
}

variable "git_ref" {
  description = "Initial git ref the cloud-init bootstrap should check out. Subsequent releases are deployed via the GitHub Actions workflow."
  type        = string
  default     = "main"
}

variable "ssh_break_glass_cidr" {
  description = "CIDR allowed to SSH on port 22 for emergencies. Set to your home IP /32. Routine deploys use IAP, not this rule."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.ssh_break_glass_cidr))
    error_message = "ssh_break_glass_cidr must be a valid CIDR (e.g. 203.0.113.42/32)."
  }
}

variable "machine_type" {
  description = "GCE machine type. c4-standard-4 is the 4 vCPU / 15 GiB profile. C4 requires Hyperdisk volumes."
  type        = string
  default     = "c4-standard-4"
}

variable "network_tier" {
  description = "Network Service Tier for the VM's external IPv4. STANDARD lowers egress costs for a single-region classroom deployment; use PREMIUM for Google's default global backbone routing."
  type        = string
  default     = "STANDARD"

  validation {
    condition     = contains(["PREMIUM", "STANDARD"], var.network_tier)
    error_message = "network_tier must be either PREMIUM or STANDARD."
  }
}

variable "boot_disk_type" {
  description = "Boot disk class. C4 machines require Hyperdisk; hyperdisk-balanced is the general-purpose default for Docker image/layer IO."
  type        = string
  default     = "hyperdisk-balanced"

  validation {
    condition     = contains(["hyperdisk-balanced", "hyperdisk-extreme", "hyperdisk-throughput"], var.boot_disk_type)
    error_message = "boot_disk_type must be one of: hyperdisk-balanced, hyperdisk-extreme, hyperdisk-throughput."
  }
}

variable "data_disk_type" {
  description = "Persistent data disk class for SQLite, student projects, and editor homes. hyperdisk-balanced preserves IDE responsiveness on C4 hosts."
  type        = string
  default     = "hyperdisk-balanced"

  validation {
    condition     = contains(["hyperdisk-balanced", "hyperdisk-extreme", "hyperdisk-throughput"], var.data_disk_type)
    error_message = "data_disk_type must be one of: hyperdisk-balanced, hyperdisk-extreme, hyperdisk-throughput."
  }
}

variable "data_disk_size_gb" {
  description = "Size of the persistent data disk (SQLite + per-student projects)."
  type        = number
  default     = 50
}

variable "boot_disk_size_gb" {
  description = "Size of the OS boot disk."
  type        = number
  default     = 50
}

variable "instance_label" {
  description = "Value emitted as the Prometheus `instance` label on all metrics scraped from this VM. Useful to distinguish prod vs staging in Grafana once you have multiple deployments."
  type        = string
  default     = "coderunner"
}
