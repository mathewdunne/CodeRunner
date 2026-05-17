terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # State bucket name is passed at init time so this file stays fork-friendly:
  #   terraform init -backend-config="bucket=$PROJECT_ID-tf-state"
  backend "gcs" {
    prefix = "prod"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

data "google_project" "current" {}
