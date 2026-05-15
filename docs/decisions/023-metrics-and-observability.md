# Decision 023: Metrics and observability via Prometheus + Grafana Cloud

## Status
Accepted

## Context

The control plane is moving to a GCE VM and needs visibility into:

- HTTP request latency / throughput on the Bun control plane.
- Whether the proxy or event loop gets bogged down under multi-student load.
- Per-container Docker stats (CPU, memory).
- Run lifecycle timings: container start, code compile, run duration, terminal status.

Raw signals were already present in structured LogTape logs (`durationMs` per HTTP request and per run; `managedContainerStats()` already shells out to `docker stats`). What was missing: aggregation, time-series storage, dashboards, and alerting.

## Alternatives considered

1. **GCP Cloud Monitoring** — native to the target VM, less code in the app, but it locks instrumentation to the GCP SDK and the dashboards are weaker than Grafana's.
2. **SQLite + custom admin dashboard** — zero new infra, but reinvents histograms, retention, alerting, and chart rendering. The operator wanted a "standard" setup; this isn't it.
3. **OpenTelemetry (OTLP)** — vendor-neutral, supports metrics + traces + logs through one SDK. Rejected for v1 because the JS SDK is heavier and historically rough under Bun. The Prometheus exposition route is forward-compatible: Alloy can convert it to OTLP if we ever want to add traces.
4. **Prometheus exposition + Grafana Cloud (chosen).** Industry-standard pattern; generous free tier (10k active series, 50GB logs, 14-day retention); decoupled from any specific cloud.

## Decision

The control plane exposes Prometheus text format at `GET /metrics`. A separate process (Grafana Alloy on the GCE VM) scrapes that endpoint and remote-writes to Grafana Cloud Prometheus. **No code in `apps/control/` references Grafana Cloud or Alloy** — the integration is configuration on the operator's side.

Instrumentation surface lives in `apps/control/src/metrics.ts`:

- `http_request_duration_seconds` (Histogram, labels: `method`, `route`, `status_class`). Route is templated via `templateRoute()` so slugs and editor sub-paths collapse to known buckets.
- `http_requests_in_flight` (Gauge).
- `proxy_upstream_duration_seconds` (Histogram, labels: `upstream`, `outcome`).
- `run_build_duration_seconds` (Histogram) — queued → first sim-ready signal.
- `run_active_duration_seconds{terminal_status}` (Histogram) — running phase only.
- `runs_total{terminal_status}` (Counter).
- `container_start_duration_seconds` (Histogram) — cold-create only.
- `container_cpu_percent{workspace_id}`, `container_memory_percent{workspace_id}` (Gauge), polled every 15s by `DockerStatsPoller` in `apps/control/src/metrics-collector.ts`.
- `active_workspaces` (Gauge), `idle_sweep_stops_total` (Counter).
- Default Node/process metrics (event-loop lag, heap, GC, fds), enabled from `main.ts` only.

### Auth

`/metrics` is gated by either a bearer token (`METRICS_TOKEN` env var, set in production for Alloy) or, if no token is configured, the admin session check. This keeps local dev convenient and prod tight.

### Cardinality discipline

- Route labels are templated; the regression test `apps/control/src/__tests__/metrics.test.ts` pins the templating rules.
- `workspace_id` is a label on container gauges. At classroom scale that's fine. The gauges are `reset()` on every poll so removed workspaces don't leave stale series.
- `collectDefaultMetrics()` is called only from `main.ts`, not `createApp()`, so test instances don't leak the process-level interval.

## Consequences

- Instrumentation is portable: swap Alloy for vanilla Prometheus, the GCP Ops Agent, or anything else that scrapes Prometheus — no code change.
- Adding a new HTTP route requires either adding it to `KNOWN_WORKSPACE_SUFFIXES` in `metrics.ts` or accepting the fallback `/u/:slug/*` bucket. The cardinality test will flag unexpected high-fidelity values during CI.
- Traces and log shipping are deferred; both are reachable through Alloy with the existing app-side instrumentation untouched.
- One small runtime cost: per-request histogram observation and an in-flight counter. Negligible at the scales involved.

See `docs/runbook.md` § 8 "Monitoring" for the Alloy config, Grafana Cloud setup, and starter dashboards.
