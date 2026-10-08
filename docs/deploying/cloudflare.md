---
sidebar_position: 5
title: Cloudflare Offline Page
sidebar_label: Cloudflare Offline Page (Advanced)
---

# Cloudflare Offline Page

Optional add-on for the [Google Cloud deployment](./gcloud.md) only.

By default the GCE VM serves everything. When you enable this, a Cloudflare
Pages project sits in front of the VM. Students see a styled "CodeRunner is
Offline" screen when the VM is powered down, instead of a browser
connection-refused error. When the VM is running, requests pass through
transparently.

The VM and all its Terraform-provisioned infrastructure are **unchanged**; you
are only adding a Cloudflare layer in front.

## How it works

```
  student browser ──443──> Cloudflare Pages (coderunner)
                                │
                         ┌──────┴────────────────────────────────┐
                         │ backend path?                         │
                         │ /api/* /admin/*                       │
                         │ /u/<slug>/{api,ws,vscode,sim,assets}  │
                         │ /healthz /metrics /scope/*            │
                         └──────┬────────────────────────────────┘
                                │ yes                 no (shell / static)
                                ▼                          ▼
                  origin.YOUR_DOMAIN (Caddy on VM)   ASSETS binding
                         │                          (CF CDN edge)
                  localhost:4000 (bun)
```

A Pages Function catch-all (`deploy/cloudflare/functions/[[path]].ts`) handles
every request. Backend paths are proxied to `origin.YOUR_DOMAIN`; the React
shell and static assets are served from Cloudflare's CDN via the `ASSETS`
binding. The workspace SPA shell (`/u/<slug>` and `/u/<slug>/`) is
intentionally served from ASSETS so the offline screen loads even when the VM
is down.

When the VM is off, the function returns `503 {"error":"service_unavailable"}`
and the React app renders the offline screen. Students never see a raw browser
error.

Your domain does **not** need to be on Cloudflare nameservers; a CNAME at your
existing registrar is enough.

## One-time setup

### 1. Add the origin A record

At your existing DNS provider, add a second A record for the backend subdomain:

| Name | Type | Value |
| --- | --- | --- |
| `origin.YOUR_DOMAIN` | A | VM static IP (`terraform output -raw static_ip`) |

### 2. Verify the Caddyfile has the origin vhost

Cloud-init writes a Caddyfile with both `YOUR_DOMAIN` and `origin.YOUR_DOMAIN`
on first boot. If your VM already existed before you enabled Cloudflare mode,
add the origin vhost manually via IAP SSH:

```bash
gcloud compute ssh coderunner --zone=us-central1-a --tunnel-through-iap --command='
sudo tee -a /opt/coderunner/caddy/Caddyfile <<EOF

origin.YOUR_DOMAIN {
  reverse_proxy control:4000 {
    header_up X-Forwarded-Host YOUR_DOMAIN
  }
  encode gzip
}
EOF
cd /opt/coderunner && sudo docker compose restart caddy'
```

New VMs get both vhosts automatically from cloud-init.

The `header_up X-Forwarded-Host` line is required. Without it Caddy forwards
`origin.YOUR_DOMAIN` as the host, the editor builds its WebSocket URL for that
hostname, the browser sends no session cookie to it, and VS Code fails with
"WebSocket close with status code 1006". VMs provisioned before this line was
added need it patched into `/opt/coderunner/caddy/Caddyfile` by hand.

### 3. Bootstrap the Cloudflare Pages project

From your local machine (requires [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) and a built web dist):

```bash
bun run build:web
cd deploy/cloudflare
wrangler pages deploy --commit-dirty=true --branch main --project-name=coderunner
```

This creates the `coderunner` Pages project in your Cloudflare account if it
does not exist yet. Do not attach the custom domain at this step; the backend
proxy will not work until the secret in step 4 is set and a second deployment
is created.

The Pages project configuration lives in
[`deploy/cloudflare/wrangler.toml`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/cloudflare/wrangler.toml).
The catch-all function is
[`deploy/cloudflare/functions/[[path]].ts`](https://github.com/mathewdunne/CodeRunner/blob/main/deploy/cloudflare/functions/%5B%5Bpath%5D%5D.ts).

### 4. Set `BACKEND_ORIGIN` as a Pages secret

`BACKEND_ORIGIN` tells the function where to proxy backend requests. It must be
set as a **secret** (not a `[vars]` entry in `wrangler.toml`; Cloudflare
rejects deployments when a var and a secret share the same binding name):

```bash
cd deploy/cloudflare
wrangler pages secret put BACKEND_ORIGIN --project-name=coderunner
# Enter: https://origin.YOUR_DOMAIN
```

Redeploy so the production deployment picks up the new secret:

```bash
wrangler pages deploy --commit-dirty=true --branch main --project-name=coderunner
```

### 5. Add the custom domain in Cloudflare

In the Cloudflare dashboard: **Workers & Pages → coderunner → Custom Domains →
Set up a custom domain** → enter `YOUR_DOMAIN`. Cloudflare will show you a
Pages CNAME target (something like `coderunner.pages.dev`). Add that at your
registrar:

| Name | Type | Value |
| --- | --- | --- |
| `YOUR_DOMAIN` | CNAME | `coderunner.pages.dev` (use the value CF shows) |

Cloudflare validates the CNAME and issues a TLS cert automatically. No
nameserver migration required.

### 6. Add GitHub Actions variables

Under **Settings → Secrets and variables → Actions** in your GitHub repo:

| Name | Kind | Value |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | **Variable** | Your Cloudflare account ID (shown in the CF dashboard sidebar) |
| `CF_API_TOKEN` | **Secret** | CF API token with *Edit Cloudflare Workers* + *Cloudflare Pages: Edit* permissions |

Leave both unset to skip the Cloudflare deploy step and stay in single-machine
mode.

## Ongoing releases

No change to the deploy command (the tag must already be published by the
Release workflow, same as the GCE deploy). The `deploy-cloudflare` job in
`.github/workflows/deploy.yml` runs automatically after the GCE deploy job
whenever `CF_ACCOUNT_ID` is set as a repo variable:

```bash
gh workflow run "Deploy" --ref main -f tag=v2.5.0
```

Both the GCE VM and the Cloudflare Pages project are updated in the same
workflow run. The Cloudflare job depends on the GCE deploy completing first, so
the backend is always ahead of the frontend during a rollout.

## Rollback

Same as the GCE rollback: redeploy an older tag. Both jobs run from the same
tag:

```bash
gh workflow run "Deploy" --ref main -f tag=v2.4.0
```

## Disabling Cloudflare mode

Remove `CF_ACCOUNT_ID` from the repo's GitHub Actions variables. The
`deploy-cloudflare` job is skipped on the next deploy and the VM serves
everything directly again. The CF Pages project remains in your Cloudflare
account but stops receiving updates.
