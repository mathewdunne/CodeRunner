# CodeRunner GCE Deployment

One-VM deployment of the CodeRunner control plane to Google Compute Engine. Zero manual SSH after the initial `terraform apply`.

> **Forking this repo to run your own instance?** This deployment is parameterized — there's nothing hardcoded to the upstream maintainer's GCP project, image registry, or GitHub identity. Set `github_repo = "yourname/yourfork"` in your `terraform.tfvars` and the workspace image path, WIF binding, and clone URL all follow from there.

## What this provisions

- One `c4-standard-4` VM (4 vCPU, 15 GB) in `us-central1-a`
- A 50 GB persistent disk mounted at `/var/lib/coderunner/data` for SQLite + student projects (survives VM recreation, daily snapshots, 7-day retention)
- Standard Network Tier for the VM's public IPv4 by default, which is cheaper for this single-region classroom deployment than Premium Tier
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

You run these once. After this, releases are deployed manually from `main`.

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

Find the Grafana values in the Grafana Cloud portal, not inside the dashboard-only view. Open your stack, then open the Prometheus/Metrics card's **Details** page. Use the **Remote Write Endpoint** ending in `/api/prom/push` for `coderunner-grafana-cloud-url`, and the **Username / Instance ID** from that same page for `coderunner-grafana-cloud-user`. For `coderunner-grafana-cloud-token`, create a Cloud **Access Policy Token** with the `metrics:write` scope and use the token value as the password.

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

Here `var.*` means the Terraform variable value from `deploy/terraform/terraform.tfvars`. For example, `var.project_id` is your Google Cloud project ID, and `var.zone` is the VM zone you chose.

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

## Changing control-plane env vars

The control plane reads `/opt/coderunner/.env`, but that file is regenerated on every boot by `render-env.sh` (defined inline in [`cloud-init/user-data.yaml`](./cloud-init/user-data.yaml)). Hand-edits to `.env` on the VM survive until the next reboot, then vanish — so make the change in the cloud-init template, not on the VM.

Three buckets, depending on what you're changing:

**A. Secrets (already wired to Secret Manager).** `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_*`, `GOOGLE_CLIENT_*`, `ADMIN_TOKEN`, `METRICS_TOKEN`, and the three `coderunner-grafana-cloud-*`. Update the secret and re-render:

```bash
printf '<new value>' | gcloud secrets versions add coderunner-<name> --data-file=-
gcloud compute ssh coderunner --zone=<zone> --tunnel-through-iap \
  --command="sudo /opt/coderunner/render-env.sh && sudo systemctl restart coderunner"
```

**B. Non-secret defaults already in the template.** `PORT`, `LOG_LEVEL`, `CODE_IMAGE`, `FRC_DATA_DIR`, `FRC_DB_PATH`, `CODE_MEMORY_LIMIT`, `IDLE_STOP_MINUTES` — edit the literal in the `echo` block inside `cloud-init/user-data.yaml` (look for the "Control plane env vars" comment), commit, then on the VM:

```bash
sudo /opt/coderunner/render-env.sh && sudo systemctl restart coderunner
```

The cloud-init template lives in the repo, not on the VM — `render-env.sh` on the VM is a frozen copy from first boot. So edits to the template only take effect on the live VM after one of: (a) `terraform apply` recreating the VM, (b) you hand-copy the updated `render-env.sh` onto the VM, or (c) for the urgent path, edit `/opt/coderunner/.env` directly + restart (just remember the same edit must land in the template too, or the next VM rebuild loses it).

**C. New vars not in the template yet** (e.g. anything from [`.env.example`](../../.env.example) like `SIM_PORT_RANGE`, `RUN_BUILD_TIMEOUT_MS`, `FRC_CONTAINER_AUTO_START`). Add a new `echo "VAR=value"` line in that same block in `user-data.yaml`. If the value is a secret, also `fetch` it from Secret Manager near the top of `render-env.sh` and reference the shell variable — follow the pattern of `BETTER_AUTH_SECRET`. Same rollout as bucket B.

> Per-workspace container env (what `docker run -e ...` passes into student containers) is **not** controlled from `.env` — see [`apps/control/src/containers/local-docker-runtime-provider.ts`](../apps/control/src/containers/local-docker-runtime-provider.ts) around the `docker run` argv. The control plane intentionally does not propagate its own secrets into student containers.

## How releases deploy

1. Create or update a `vX.Y.Z` or `vX.Y.Z-prerelease` tag on a commit reachable from `main`.
2. Dispatch the manual deploy workflow from `main`:

   ```bash
   gh workflow run "Deploy to GCE" --ref main -f tag=v2.4.0
   ```

3. [`Deploy to GCE`](../.github/workflows/deploy.yml) validates the tag format and ancestry, runs `bun run verify`, publishes `ghcr.io/<owner>/coderunner-workspace:<tag>` and `:latest`, builds the web and AdvantageScope Lite tarballs, and uploads `web-dist.tar.gz` + `ascope-dist.tar.gz` to the GitHub Release for that tag.
4. The deploy job authenticates via WIF, SSHes into the VM through IAP, stops `coderunner`, checks out the tag, installs dependencies, fetches the prebuilt tarballs, pulls the matching workspace image, removes all managed V2 workspace containers, clears their leases, starts `coderunner`, then polls `/healthz`. **Nothing is built on the VM** — emsdk and Node aren't installed there.

Migrations apply automatically — `bun run start` runs `bun run migrate` first ([package.json:13](../package.json)).

Workspace rebuilds intentionally disrupt active sessions during deploy. Student data is preserved because projects and editor homes are bind-mounted under `data/users/<workspaceId>/`; only disposable Docker containers labeled `frc-sim.managed=true` and `frc-sim.version=v2` are removed.

### First-deploy gotcha

After `terraform apply` + populating secrets + VM reset (steps 4–7), the control plane runs but `apps/web/dist` is empty — `/` will 404 until the **first** manual deploy lands the prebuilt web bundle. `/healthz` works regardless, so use that to verify the VM came up. Run *Deploy to GCE* from `main` against a valid release tag to populate the dist.

## Rollback

```bash
gh workflow run "Deploy to GCE" --ref main -f tag=v2.3.0
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

From [.env.example](../.env.example): each active student uses ~2.5 GB at the normal memory cap. The default is now `c4-standard-4` (4 vCPU, 15 GB), with production bootstrap setting `CODE_MEMORY_LIMIT=2048m` to reduce per-container memory pressure. To scale up, set `machine_type = "c4-standard-8"` or larger in `terraform.tfvars`, then verify real capacity with Grafana or `docker stats`. C4 hosts require Hyperdisk volumes — `pd-*` disk types are not compatible.

## Cost notes

- `network_tier = "STANDARD"` is the default because this app serves one regional classroom-style audience. It reduces outbound bandwidth cost compared with Premium Tier. Switching an existing reserved static IPv4 between tiers can allocate a new IP, so plan for a DNS update if Terraform shows the address being replaced.
- Boot and data disks stay on `hyperdisk-balanced` by default — required by C4 machines, which do not support `pd-*` volumes. `hyperdisk-throughput` is cheaper for sustained sequential IO but worse for the small-block latency profile of Docker layers, openvscode-server homes, Java language-server caches, SQLite, and Gradle project IO; `hyperdisk-extreme` is faster but materially more expensive.
- Existing persistent disks cannot be shrunk in place. Reducing `boot_disk_size_gb` or `data_disk_size_gb` is not a safe cost cleanup for a live deployment; create a smaller replacement disk from backup/snapshot if you later decide the current 50 GB sizes are too large.
- Daily snapshots are incremental and stored regionally. Keeping 7-day retention is a good value tradeoff for student data; lower it only if billing reports show snapshot storage becoming meaningful.

## Cloudflare Pages mode

Optional. When configured, Cloudflare serves the React frontend from the CDN so students see a styled "CodeRunner is Offline" screen if the VM is powered down, instead of Chrome's connection-refused error. The VM and all its existing infrastructure remain unchanged.

### How it works

```
  student browser ──443──> Cloudflare Pages (Advanced Mode)
                                │
                         ┌──────┴──────────────────────────────────┐
                         │ backend path?                           │
                         │ /api/* /u/* /admin/*                    │
                         │ /healthz /metrics /scope/*              │
                         └──────┬──────────────────────────────────┘
                                │ yes                    no (static asset)
                                ▼                              ▼
                  origin.YOUR_DOMAIN (Caddy)          ASSETS binding
                         │                          (served from CF CDN)
                  localhost:4000 (bun)
```

CF Pages runs in **Advanced Mode** — a single Worker entry point (`deploy/cloudflare/worker/index.ts`) handles all requests. Backend paths are proxied to `origin.YOUR_DOMAIN`; everything else is served from CF's static asset store via the `ASSETS` binding. Your domain does **not** need to be on Cloudflare nameservers — you add it as a CF Pages custom domain and point a CNAME at your registrar.

When the VM is off, the Worker returns `503 {"error":"service_unavailable"}` and the React app shows the offline screen. Students never see a raw browser error.

### One-time setup

#### 1. Add A record and CNAME at your registrar

No Cloudflare nameservers required. At your existing DNS provider add:

| Name | Type | Value |
|------|------|-------|
| `origin.YOUR_DOMAIN` | **A** | VM static IP (`terraform output -raw static_ip`) |

You'll add the CNAME for `YOUR_DOMAIN` itself in step 4, once CF gives you the target.

#### 2. Update Caddyfile on the existing VM

The Caddyfile is written once on first boot. If your VM already exists, add the origin vhost manually:

```bash
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap --command='
sudo tee -a /etc/caddy/Caddyfile <<EOF

origin.YOUR_DOMAIN {
  reverse_proxy localhost:4000
  encode gzip
}
EOF
sudo systemctl reload caddy'
```

New VMs provisioned from `cloud-init/user-data.yaml` get both vhosts automatically.

#### 3. Create the CF Pages project

Cloudflare dashboard → *Workers & Pages → Create → Pages → Direct Upload*. Name the project **`coderunner`** (must match `name` in `wrangler.toml`). You can upload a placeholder file — the workflow will overwrite it on first deploy.

#### 4. Add the custom domain to CF Pages

In the CF Pages project → *Custom Domains → Add custom domain* → enter `YOUR_DOMAIN`. Cloudflare will give you a CNAME target (something like `coderunner.pages.dev`). Add that CNAME at your registrar:

| Name | Type | Value |
|------|------|-------|
| `YOUR_DOMAIN` | **CNAME** | `coderunner.pages.dev` (or whatever CF shows) |

CF validates the domain and issues a TLS cert automatically.

#### 5. Set BACKEND_ORIGIN as a Pages secret

```bash
cd deploy/cloudflare
wrangler pages secret put BACKEND_ORIGIN --project-name=coderunner
# Enter: https://origin.YOUR_DOMAIN
```

#### 6. Update wrangler.toml

Replace the `YOUR_DOMAIN` placeholder in `BACKEND_ORIGIN` in [`deploy/cloudflare/wrangler.toml`](./cloudflare/wrangler.toml) with your actual origin subdomain, then commit.

#### 7. Configure GitHub Actions

Under *Settings → Secrets and variables → Actions*:

| Name | Kind | Value |
|------|------|-------|
| `CF_ACCOUNT_ID` | **Variable** | Your Cloudflare account ID (shown in the CF dashboard sidebar) |
| `CF_API_TOKEN` | **Secret** | CF API token — use the *Edit Cloudflare Workers* template and add *Cloudflare Pages: Edit* permission |

Leave both unset to skip the CF deploy step entirely (single-machine mode continues to work).

### Ongoing releases

No change to the deploy command. The `deploy-cloudflare` job in `deploy.yml` runs automatically after `publish` whenever `CF_ACCOUNT_ID` is set:

```bash
gh workflow run "Deploy to GCE" --ref main -f tag=v2.5.0
```

Both the GCE VM and CF Pages/Worker are updated in the same workflow run.

### Rollback

Same as GCE — redeploy an older tag. Both jobs run from the same tag.

---

## Files

```
deploy/
├── README.md                    # This file
├── cloudflare/
│   ├── wrangler.toml            # CF Pages Advanced Mode config (set BACKEND_ORIGIN)
│   └── worker/
│       └── index.ts             # Pages Function: proxies backend paths, serves static via ASSETS
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
└── deploy.yml                   # Manual main-branch release path: validates,
                                 # verifies, publishes image/artifacts, rebuilds
                                 # managed workspace containers, and rolls the VM.
                                 # Also deploys to CF Pages/Worker when CF_ACCOUNT_ID
                                 # is set as a repo variable.
```
