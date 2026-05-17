resource "google_compute_disk" "data" {
  name = "coderunner-data"
  type = "pd-balanced"
  zone = var.zone
  size = var.data_disk_size_gb

  # Survives VM recreation. cloud-init detects existing ext4 and skips mkfs.
  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_resource_policy" "daily_snapshot" {
  name   = "coderunner-data-daily"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "08:00" # UTC; ~03:00 Eastern / 02:00 Central, well outside classroom hours
      }
    }

    retention_policy {
      max_retention_days    = 7
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }

    snapshot_properties {
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "data_daily" {
  name = google_compute_resource_policy.daily_snapshot.name
  disk = google_compute_disk.data.name
  zone = var.zone
}
