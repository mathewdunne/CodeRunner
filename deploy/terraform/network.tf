resource "google_compute_network" "coderunner" {
  name                    = "coderunner"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "coderunner" {
  name          = "coderunner-subnet"
  network       = google_compute_network.coderunner.id
  ip_cidr_range = "10.0.0.0/24"
  region        = var.region
}

resource "google_compute_address" "coderunner" {
  name         = "coderunner-ip"
  address_type = "EXTERNAL"
  region       = var.region
  network_tier = var.network_tier
}

resource "google_compute_firewall" "http" {
  name    = "coderunner-allow-http"
  network = google_compute_network.coderunner.id

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  target_tags   = ["coderunner"]
  source_ranges = ["0.0.0.0/0"]
}

# Break-glass SSH from a single home IP. Routine deploys use IAP (35.235.240.0/20)
# via the deploy.yml workflow and do not require this rule.
resource "google_compute_firewall" "ssh_break_glass" {
  name    = "coderunner-allow-ssh-break-glass"
  network = google_compute_network.coderunner.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  target_tags   = ["coderunner"]
  source_ranges = [var.ssh_break_glass_cidr]
}

# IAP source range for tunnel-through-iap SSH used by the deploy workflow.
resource "google_compute_firewall" "ssh_iap" {
  name    = "coderunner-allow-ssh-iap"
  network = google_compute_network.coderunner.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  target_tags   = ["coderunner"]
  source_ranges = ["35.235.240.0/20"]
}
