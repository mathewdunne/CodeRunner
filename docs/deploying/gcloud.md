---
sidebar_position: 4
title: Google Cloud Deployment
sidebar_label: Google Cloud Deployment (Advanced)
---

# Google Cloud Deployment

A single Google Compute Engine VM, provisioned by Terraform, fronted by Caddy
for automatic HTTPS on your own domain. Releases ship through a GitHub Actions
workflow, with no manual SSH after the one-time bootstrap.

Everything in this guide is driven by the Terraform config and workflow in this
repo. The primary source of truth is
[`deploy/README.md`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/README.md).
The Terraform files are in
[`deploy/terraform/`](https://github.com/mathewdunne/CodeRunner/tree/main/deploy/terraform).

## What gets provisioned

- One `c4-standard-4` VM (4 vCPU / 15 GiB) in `us-central1-a` by default
- A 50 GB `hyperdisk-balanced` boot disk and a 50 GB `hyperdisk-balanced` data
  disk mounted at `/var/lib/coderunner/data` (SQLite + student project files)
- The data disk is `prevent_destroy = true`, so it survives VM recreation
- Daily snapshots of the data disk with 7-day retention
- A reserved static IPv4 address
- Caddy (auto-TLS via Let's Encrypt) in front of the control plane on port 4000
- Grafana Alloy scraping `/metrics` and shipping to Grafana Cloud
- Workload Identity Federation so GitHub Actions deploys without long-lived keys

C4 machines require Hyperdisk volumes; `pd-*` disk types are not compatible.

## Prerequisites

- A GCP project with billing enabled and the `gcloud` CLI authenticated
- Terraform 1.6+
- A domain name where you can add DNS records
- OAuth credentials for at least one provider. Register them first and note the
  client ID and secret; see [OAuth Credentials](./oauth-credentials.md)

## One-time bootstrap

Run these steps once. After the bootstrap, releases ship via GitHub Actions.

### 1. Create and configure the GCP project

```bash
export PROJECT_ID=your-coderunner-project   # pick a unique ID
gcloud projects create $PROJECT_ID --name="CodeRunner"
gcloud billing projects link $PROJECT_ID --billing-account=<YOUR_BILLING_ID>
gcloud config set project $PROJECT_ID

gcloud services enable \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  iap.googleapis.com
```

### 2. Create the Terraform state bucket

```bash
gcloud storage buckets create gs://$PROJECT_ID-tf-state \
  --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update gs://$PROJECT_ID-tf-state --versioning
```

### 3. Configure Terraform variables

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`. The variables you must set are:

| Variable | Description |
| --- | --- |
| `project_id` | Your GCP project ID |
| `domain` | The public hostname students visit (e.g. `coderunner.example.com`) |
| `github_repo` | `owner/repo` of your fork, which must match the repo you push tags from |
| `ssh_break_glass_cidr` | Your home IP in CIDR notation (e.g. `203.0.113.42/32`) for emergency SSH |

Optional variables with sensible defaults:

| Variable | Default | Notes |
| --- | --- | --- |
| `region` | `us-central1` | GCP region |
| `zone` | `us-central1-a` | GCP zone |
| `machine_type` | `c4-standard-4` | 4 vCPU / 15 GiB |
| `network_tier` | `STANDARD` | Lower egress cost for a single-region classroom app |
| `boot_disk_size_gb` | `50` | OS boot disk size |
| `data_disk_size_gb` | `50` | Data disk for SQLite + student projects |
| `instance_label` | `coderunner` | Prometheus `instance` label in Grafana |

See [`deploy/terraform/variables.tf`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/terraform/variables.tf)
for the full list.

### 4. Apply Terraform

```bash
terraform init -backend-config="bucket=$PROJECT_ID-tf-state"
terraform apply
```

Note the outputs: you will need `static_ip`, `workload_identity_provider`, and
`deployer_service_account` in later steps.

### 5. Populate Secret Manager

Terraform creates the Secret Manager containers but leaves them empty. Populate
them now. Generate strong random values for the first three:

```bash
# Generated secrets
gcloud secrets versions add coderunner-better-auth-secret \
  --data-file=<(openssl rand -hex 32)
gcloud secrets versions add coderunner-metrics-token \
  --data-file=<(openssl rand -hex 32)
gcloud secrets versions add coderunner-admin-token \
  --data-file=<(openssl rand -hex 32)

# OAuth credentials (register apps at the provider first; see ./oauth-credentials.md)
# Use the real domain in the callback URLs: https://<your-domain>/api/auth/callback/github
echo -n '<your-github-client-id>'     | gcloud secrets versions add coderunner-github-client-id --data-file=-
echo -n '<your-github-client-secret>' | gcloud secrets versions add coderunner-github-client-secret --data-file=-
echo -n '<your-google-client-id>'     | gcloud secrets versions add coderunner-google-client-id --data-file=-
echo -n '<your-google-client-secret>' | gcloud secrets versions add coderunner-google-client-secret --data-file=-

# Optional: Auth0 SSO. Skip these three to keep Auth0 off.
# Callback URL: https://<your-domain>/api/auth/oauth2/callback/auth0
echo -n '<your-tenant>.us.auth0.com'  | gcloud secrets versions add coderunner-auth0-domain --data-file=-
echo -n '<your-auth0-client-id>'      | gcloud secrets versions add coderunner-auth0-client-id --data-file=-
echo -n '<your-auth0-client-secret>'  | gcloud secrets versions add coderunner-auth0-client-secret --data-file=-

# Grafana Cloud (create a free stack at grafana.com)
echo -n 'https://prometheus-prod-XX-prod-us-central-0.grafana.net/api/prom/push' \
  | gcloud secrets versions add coderunner-grafana-cloud-url --data-file=-
echo -n '<numeric-prometheus-instance-id>' \
  | gcloud secrets versions add coderunner-grafana-cloud-user --data-file=-
echo -n '<glc_eyJ...-access-policy-token>' \
  | gcloud secrets versions add coderunner-grafana-cloud-token --data-file=-
echo -n 'https://logs-prod-XXX.grafana.net/loki/api/v1/push' \
  | gcloud secrets versions add coderunner-grafana-cloud-loki-url --data-file=-
echo -n '<numeric-loki-instance-id>' \
  | gcloud secrets versions add coderunner-grafana-cloud-loki-user --data-file=-
```

The exact secret names (all prefixed `coderunner-`) are defined in
[`deploy/terraform/secrets.tf`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/terraform/secrets.tf).
The `render-env.sh` script on the VM reads every one of them at boot; if any
are missing the service will not start. The `coderunner-auth0-*` secrets are the
exception: they are optional, and Auth0 is enabled only when all three are set.

See [Grafana Cloud](../operating/grafana.md) for where to find each value in the Grafana Cloud portal.

### 6. Add a DNS A record

At your registrar, create an A record pointing your domain at the static IP:

```
<your-domain>  A  <terraform output -raw static_ip>
```

### 7. Reset the VM to render config

The VM booted before secrets existed, so `.env` is empty. A VM reset triggers
the startup script, which calls `render-env.sh` and restarts services:

```bash
gcloud compute instances reset coderunner --zone=us-central1-a
```

After about 30 seconds, verify TLS is working:

```bash
curl -I https://<your-domain>/healthz
```

You should get an HTTP 200 with a valid Let's Encrypt certificate.

### 8. Configure GitHub Actions

Under **Settings → Secrets and variables → Actions → Variables** in your GitHub
repo, set:

| Variable | Value | Required |
| --- | --- | --- |
| `GCP_PROJECT` | Your `project_id` from `terraform.tfvars` | Yes |
| `GCP_DEPLOY_SA` | `terraform output -raw deployer_service_account` | Yes |
| `GCP_WIF_PROVIDER` | `terraform output -raw workload_identity_provider` | Yes |
| `GCP_ZONE` | Your `zone` from `terraform.tfvars` | No (defaults to `us-central1-a`) |
| `GCP_VM_NAME` | `terraform output -raw vm_name` | No (defaults to `coderunner`) |

No GitHub *secrets* are needed; Workload Identity Federation replaces
long-lived service account keys.

### 9. Deploy for the first time

On first boot the VM fetches the compose files and pulls the `:latest` images,
so it can come up before any deploy. Run the workflow against a published
release tag (see [Releasing](#releasing)) to pin a specific version:

```bash
gh workflow run "Deploy" --ref main -f tag=v2.0.0
```

### 10. Become the first admin

The easiest path is to set `CODERUNNER_ADMIN_EMAIL` in `/opt/coderunner/.env`
(comma-separated for multiple coaches) before you first sign in. On startup the
control plane allowlists each listed email and grants it the admin role at first
OAuth sign-in — no exec steps. Add the line and restart the stack:

```bash
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap \
  --command='cd /opt/coderunner && echo "CODERUNNER_ADMIN_EMAIL=<your-email>" | sudo tee -a .env && sudo docker compose up -d'
```

Otherwise, promote yourself by hand after signing in once, via IAP SSH:

```bash
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap \
  --command='cd /opt/coderunner && sudo docker compose exec -T control coderunner users promote <your-email>'
```

Either way you also need to allowlist your students' emails before they can sign
in. From an IAP SSH session:

```bash
sudo docker compose exec -T control coderunner allowlist add coach@frcteam.org
```

See [OAuth Credentials](./oauth-credentials.md) for the full allowlist and admin
bootstrap flow.

## Runtime shape on the VM

The host installs only Docker + the Compose plugin. Once bootstrapped, the VM
runs a docker compose stack (`/opt/coderunner`, with
`COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` set in `.env`):

- **`control`**: the control plane container, reading `/opt/coderunner/.env`
  for configuration, with the host Docker socket and `/var/lib/coderunner/data`
  bind-mounted. Per-student workspace containers are started by it as siblings
  on the `coderunner` network.
- **`caddy`**: terminates TLS for `<your-domain>` and `origin.<your-domain>`,
  reverse-proxies to `control:4000` over the compose network.
- **`alloy`**: scrapes `control:4000/metrics`, collects host metrics, and ships
  the control container's logs (via the Docker API) to Grafana Cloud.

`render-env.sh` runs on every boot (via `metadata_startup_script`) to
re-materialize `/opt/coderunner/.env` from Secret Manager (preserving the
deployed `CODERUNNER_TAG`) and then `docker compose up -d`. Hand-edits to `.env`
on the VM do not survive a reboot.

It also derives `CODERUNNER_IMAGE_NS` from the Terraform `github_repo`
variable, so a fork's VM automatically pulls the fork's own GHCR images — no
extra configuration step.

For monitoring details (Prometheus metrics, Loki log shipping, and Grafana
dashboards), see [Monitoring](../operating/monitoring.md).

## Releasing

Releasing is two steps: publish a tag, then deploy it.

**1. Publish** — push a semver tag on a commit reachable from `main`:

```bash
git tag v2.4.0 && git push origin v2.4.0
```

The **Release** workflow (`.github/workflows/release.yml`) runs automatically:

1. Validates the tag format and that it is reachable from `main`
2. Runs `bun run verify` (Biome, typecheck, unit tests, E2E)
3. Builds and pushes `ghcr.io/<owner>/coderunner-workspace:<tag>` and
   `ghcr.io/<owner>/coderunner-control:<tag>` (both `:latest` too) to GHCR as
   **multi-arch images** (`linux/amd64` + `linux/arm64`), built on native
   runners per architecture and merged into one manifest per tag. The control
   image builds the web shell and AdvantageScope Lite (emsdk runs inside a
   build stage), then downloads the prebuilt PathPlanner web artifact at the
   release tag pinned in `PATHPLANNER_DIST_TAG`. That download is required:
   if it fails the release fails, rather than publishing a control image whose
   `/pathplanner/` serves a 503. Nothing is compiled on a plain runner, and
   nothing is built on the VM.
4. Extracts `web-dist.tar.gz` + `ascope-dist.tar.gz` from the built control
   image and uploads them to the CodeRunner GitHub Release. PathPlanner remains
   an external artifact from the `pathplanner-web` release.

**2. Deploy** — dispatch the deploy workflow against the published tag:

```bash
gh workflow run "Deploy" --ref main -f tag=v2.4.0
```

The **Deploy** workflow (`.github/workflows/deploy.yml`):

1. Checks the GitHub release exists and both images are published for the tag
2. `scp`s the compose files to the VM, pins `CODERUNNER_TAG=<tag>` in
   `/opt/coderunner/.env`, runs `docker compose pull` + `up -d`, then recycles
   managed workspace containers (student data is preserved; only containers are
   removed) via `docker compose exec control coderunner rebuild-workspaces`
3. Polls `/healthz` until the service is healthy

Nothing is built on the VM; emsdk, Node, and Bun are not installed there.

Migrations apply automatically — the control image's entrypoint runs them before
serving.

## Changing env vars

The VM's `.env` is regenerated on every boot from `render-env.sh`. Changes fall
into three buckets:

**A. Secrets already wired to Secret Manager** (`BETTER_AUTH_SECRET`,
`GITHUB_CLIENT_*`, `GOOGLE_CLIENT_*`, `AUTH0_DOMAIN`, `AUTH0_CLIENT_*`,
`ADMIN_TOKEN`, `METRICS_TOKEN`, Grafana Cloud values): update the secret version, then re-render:

```bash
printf '<new-value>' | gcloud secrets versions add coderunner-<name> --data-file=-
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap \
  --command="sudo /opt/coderunner/render-env.sh && cd /opt/coderunner && sudo docker compose up -d"
```

**B. Non-secret defaults in the template** (`LOG_LEVEL`, `CODE_MEMORY_LIMIT`,
`IDLE_STOP_MINUTES`, etc.): edit the relevant `echo` line in the `render-env.sh`
block inside
[`deploy/cloud-init/user-data.yaml`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/cloud-init/user-data.yaml),
commit, then on the VM:

```bash
sudo /opt/coderunner/render-env.sh && cd /opt/coderunner && sudo docker compose up -d
```

Note that `render-env.sh` on the VM is a frozen copy from first boot. The
template in `user-data.yaml` is the canonical source; edits there only reach
the live VM after you copy the updated script to the VM manually, or after the
VM is recreated by Terraform.

**C. New variables not yet in the template**: add a new `echo "VAR=value"` line
in the same block in `user-data.yaml`. If the value is a secret, also add a
`fetch` call near the top of `render-env.sh` and reference the shell variable.
Follow the existing pattern for `BETTER_AUTH_SECRET`.

## Rollback

Redeploy an earlier tag:

```bash
gh workflow run "Deploy" --ref main -f tag=v2.3.0
```

Or use the GitHub Actions UI: **Deploy → Run workflow → enter the
previous tag**.

## Verification checklist

| Check | How |
| --- | --- |
| Cloud-init finished | `gcloud compute instances get-serial-port-output coderunner \| grep "bootstrap complete"` |
| TLS and healthz | `curl -I https://<your-domain>/healthz` returns 200 |
| Stack running | `cd /opt/coderunner && sudo docker compose ps` (control "healthy") via IAP SSH |
| Control plane logs | `cd /opt/coderunner && sudo docker compose logs --tail 50 control` via IAP SSH |
| Images present | `docker images \| grep coderunner` via IAP SSH |
| Metrics in Grafana | If Grafana Cloud is configured, see [Grafana Cloud](../operating/grafana.md) for the verification query |

## Cost and sizing

The default `c4-standard-4` with two 50 GB `hyperdisk-balanced` disks runs to a
modest always-on cost (low tens of US dollars per month). Each active student
can use up to 4 GB RAM at the default `CODE_MEMORY_LIMIT=4096m` set by
`render-env.sh` in production. To scale up, set
`machine_type = "c4-standard-8"` or larger in `terraform.tfvars` and run
`terraform apply`.

To take the deployment to near-zero cost between seasons (snapshot the data
disk, stop the VM), follow the
[Seasonal Teardown](../operating/seasonal-teardown.md) runbook.
