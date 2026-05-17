# CodeRunner GCE Deployment

One-VM deployment of the CodeRunner control plane to Google Compute Engine. Zero manual SSH after the initial `terraform apply`.

> **Forking this repo to run your own instance?** This deployment is parameterized — there's nothing hardcoded to the upstream maintainer's GCP project, image registry, or GitHub identity. Set `github_repo = "yourname/yourfork"` in your `terraform.tfvars` and the workspace image path, WIF binding, and clone URL all follow from there.

## What this provisions

- One `e2-standard-4` VM (4 vCPU, 16 GB) in `us-central1-a`
- A 50 GB persistent disk mounted at `/var/lib/coderunner/data` for SQLite + student projects (survives VM recreation, daily snapshots, 7-day retention)
- Caddy in front of the control plane terminating TLS via Let's Encrypt
- Grafana Alloy scraping the control plane's `/metrics`, host metrics, and per-container metrics; `remote_write` to Grafana Cloud
- Workload Identity Federation so GitHub Actions can deploy without long-lived keys

## Architecture at runtime

```
  internet ──443──> Caddy (VM) ──:4000──> bun control plane (systemd)
                                            │
                                            └─ docker.sock ──> per-student workspace containers
                                                                (ghcr.io/<owner>/coderunner-workspace)

  bun control plane ──:4000/metrics──> Grafana Alloy (systemd) ──> Grafana Cloud
                       host + cadvisor ─/
```

## One-time bootstrap

You run these once. After this, every release auto-deploys.

### 1. GCP project

Pick a globally-unique project ID (lowercase, hyphens). The examples below use `$PROJECT_ID` — substitute your own.

```bash
export PROJECT_ID=your-coderunner-project   # CHANGE this
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

### 2. Terraform state bucket

```bash
gcloud storage buckets create gs://$PROJECT_ID-tf-state --location=us-central1 --uniform-bucket-level-access
gcloud storage buckets update gs://$PROJECT_ID-tf-state --versioning
```

### 3. Configure Terraform vars

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars: set project_id, domain, ssh_break_glass_cidr (your home IP /32)
```

### 4. Apply

```bash
terraform init -backend-config="bucket=$PROJECT_ID-tf-state"
terraform apply
```

Note the outputs — you'll need `static_ip` and `workload_identity_provider`.

### 5. Populate Secret Manager

```bash
# Generate strong randoms for these two
gcloud secrets versions add coderunner-better-auth-secret --data-file=<(openssl rand -hex 32)
gcloud secrets versions add coderunner-metrics-token --data-file=<(openssl rand -hex 32)
gcloud secrets versions add coderunner-admin-token --data-file=<(openssl rand -hex 32)

# OAuth credentials (register apps at the provider first)
echo -n '<your github client id>'     | gcloud secrets versions add coderunner-github-client-id --data-file=-
echo -n '<your github client secret>' | gcloud secrets versions add coderunner-github-client-secret --data-file=-
echo -n '<your google client id>'     | gcloud secrets versions add coderunner-google-client-id --data-file=-
echo -n '<your google client secret>' | gcloud secrets versions add coderunner-google-client-secret --data-file=-

# Grafana Cloud (create a free stack at grafana.com, then under Connections
# → Access Policies create a token with metrics:write scope)
echo -n 'https://prometheus-prod-XX-prod-us-east-0.grafana.net/api/prom/push' \
  | gcloud secrets versions add coderunner-grafana-cloud-url --data-file=-
echo -n '<numeric instance/user id>' \
  | gcloud secrets versions add coderunner-grafana-cloud-user --data-file=-
echo -n '<glc_eyJ... token>' \
  | gcloud secrets versions add coderunner-grafana-cloud-token --data-file=-
```

OAuth callback URLs to register with each provider:
- GitHub: `https://<your domain>/api/auth/callback/github`
- Google: `https://<your domain>/api/auth/callback/google`

### 6. DNS

At your registrar, create an A record: `<your domain>` → `terraform output -raw static_ip`.

### 7. Re-render config on the VM

The first boot happened *before* secrets existed, so `.env` and Alloy config are blank. Trigger a re-render by restarting the VM (the startup script in `vm.tf` calls `render-env.sh` and restarts services):

```bash
gcloud compute instances reset coderunner --zone=us-central1-a
```

After ~30 s, `curl -I https://<your domain>/healthz` should return 200 with a valid Let's Encrypt cert.

### 8. Configure GitHub repo for the deploy workflow

Under *Settings → Secrets and variables → Actions → Variables*, set:

| Variable | Source | Required |
|---|---|---|
| `GCP_PROJECT` | your `var.project_id` | yes |
| `GCP_DEPLOY_SA` | `terraform output -raw deployer_service_account` | yes |
| `GCP_WIF_PROVIDER` | `terraform output -raw workload_identity_provider` | yes |
| `GCP_ZONE` | your `var.zone` | optional (defaults to `us-central1-a`) |
| `GCP_VM_NAME` | your `terraform output -raw vm_name` | optional (defaults to `coderunner`) |

No GitHub *secrets* to set — Workload Identity Federation replaces them.

### 9. Promote yourself to admin

The first user to sign in is just a regular user. Promote them (one-time SSH via IAP):

```bash
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap \
  --command='cd /opt/coderunner/app && sudo -u coderunner bun run users:promote <your-email>'
```

## How releases deploy

1. Push a `vX.Y.Z` tag.
2. [`Build workspace image`](../.github/workflows/build-image.yml) runs two parallel jobs:
   - `build` publishes the workspace image to `ghcr.io/<owner>/coderunner-workspace:<tag>`.
   - `release-artifacts` builds `apps/web/dist` and `dist/advantagescope`, tars them, and attaches `web-dist.tar.gz` + `ascope-dist.tar.gz` to the GitHub Release for that tag.
3. [`Deploy to GCE`](../.github/workflows/deploy.yml) fires once the upstream workflow's `conclusion == 'success'`, authenticates via WIF, SSHes into the VM through IAP, and runs: `git checkout <tag> && bun install && curl tarballs && tar -xz && docker pull && systemctl restart coderunner`, then polls `/healthz`. **Nothing is built on the VM** — emsdk and Node aren't installed there.

Migrations apply automatically — `bun run start` runs `bun run migrate` first ([package.json:13](../package.json)).

### First-deploy gotcha

After `terraform apply` + populating secrets + VM reset (steps 4–7), the control plane runs but `apps/web/dist` is empty — `/` will 404 until the **first** tag-driven deploy lands the prebuilt web bundle. `/healthz` works regardless, so use that to verify the VM came up. Push a `vX.Y.Z` tag (or run *Deploy to GCE* manually against an existing release tag) to populate the dist.

## Rollback

```bash
gh workflow run "Deploy to GCE" -f tag=v2.3.0
```

Or via the GitHub Actions UI: *Deploy to GCE* → *Run workflow* → enter the previous tag.

## Verification

| Check | How |
|---|---|
| Cloud-init finished cleanly | `gcloud compute instances get-serial-port-output coderunner \| grep "bootstrap complete"` |
| TLS works | `curl -I https://<domain>/healthz` returns 200 |
| Control plane healthy | `journalctl -u coderunner -n 50` via IAP SSH |
| Workspace image present | `docker images \| grep coderunner-workspace` |
| Metrics flowing to Grafana | In Grafana Cloud Explore: `up{instance="<var.instance_label>"}` (defaults to `"coderunner"`) — expect three series (`coderunner`, `node`, `cadvisor`), all `1` |
| Disaster recovery | `terraform destroy -target=google_compute_instance.coderunner` then `terraform apply` — site comes back up; data disk is `prevent_destroy=true` |

> **Teardown note:** `prevent_destroy = true` on `google_compute_disk.data` means a plain `terraform destroy` will error. To fully tear down (e.g. a throwaway test project): temporarily set `prevent_destroy = false` in `deploy/terraform/disk.tf`, `terraform apply` (no-op other than the lifecycle change), then `terraform destroy`. Production should leave the guard on.

## Sizing reference

From [.env.example](../.env.example): each active student uses ~2.5 GB. The default `e2-standard-4` (16 GB) fits the ~10-student target. To bump, set `machine_type = "e2-standard-8"` in `terraform.tfvars` and `terraform apply` (the VM will stop, resize, and restart — no data loss because the data disk is separate).

## Files

```
deploy/
├── README.md                    # This file
├── terraform/                   # Infrastructure as code
│   ├── main.tf
│   ├── variables.tf
│   ├── network.tf
│   ├── disk.tf
│   ├── iam.tf
│   ├── secrets.tf
│   ├── vm.tf
│   ├── outputs.tf
│   └── terraform.tfvars.example
└── cloud-init/
    └── user-data.yaml           # First-boot provisioning (installs Bun, Docker,
                                 # Caddy, Alloy; clones repo; writes systemd units).
                                 # Does NOT build web/ascope — those arrive as
                                 # prebuilt tarballs on each deploy.
.github/workflows/
├── build-image.yml              # On v* tag: builds workspace image to GHCR
                                 # AND prebuilds web + ascope tarballs and
                                 # attaches them to the GitHub Release.
└── deploy.yml                   # Chains off build-image. Fetches the release
                                 # tarballs and rolls the VM service.
```
