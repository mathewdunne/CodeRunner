# Decision 027: Ship control-plane logs to Grafana Cloud Loki

## Status

Accepted.

## Context

[Decision 023](./023-metrics-and-observability.md) wired Prometheus metrics to Grafana Cloud via Alloy and explicitly deferred log shipping: "both reachable through Alloy with the existing app-side instrumentation untouched." The metrics surface is enough for *what* is slow but not enough for *why* — every run failure, container OOM, idle sweep, and proxy hiccup is in journald on the GCE VM, but only reachable via SSH + `journalctl`. Classroom incident response needs Grafana Cloud parity.

Loki is Grafana's log store; the same free Cloud tier already in use for metrics includes 50 GB/14-day logs at no extra cost.

## Alternatives considered

1. **OpenTelemetry log SDK in-process.** Symmetric with the deferred OTLP path from 023. Rejected for the same reason: heavier, less Bun-tested, and we'd need to manage a second egress path from the app process.
2. **Vector instead of Alloy.** Comparable feature set. Rejected because Alloy is already the running shipper and adding a second daemon costs more than it buys.
3. **Plain text logs with regex parsing in LogQL.** Works but every dashboard becomes a regex puzzle, and `workspaceId`/`runId` filtering is order-of-magnitude slower than JSON field extraction at query time.

## Decision

Two surfaces:

1. **App.** `apps/control/src/logging.ts` gains a JSON sink alongside the existing colored text sink, gated by `LOG_FORMAT=json`. Default stays text/colored for local dev. The sink emits one NDJSON object per record:

   ```json
   {"timestamp":"2026-05-21T14:23:01.482Z","level":"info","category":"control.runs","message":"run started","workspaceId":"alice-1","runId":"run_abc"}
   ```

   Reserved fields (`timestamp`, `level`, `category`, `message`) always win against colliding property keys so the LogQL surface stays predictable. Error properties render as `{message, stack?}` objects.

2. **Deploy.** Production `.env` (rendered by `deploy/cloud-init/user-data.yaml`'s `render-env.sh`) sets `LOG_FORMAT=json`. Alloy gains a `loki.source.journal` → `loki.process` → `loki.write` pipeline filtering on `_SYSTEMD_UNIT=coderunner.service`. Two new Secret Manager entries: `coderunner-grafana-cloud-loki-url` and `coderunner-grafana-cloud-loki-user`. The existing `coderunner-grafana-cloud-token` is reused as the basic-auth password — one access policy token can carry both `metrics:write` and `logs:write` scopes, but the *user IDs* are per-datasource in Grafana Cloud and must come from separate secrets.

### Label cardinality

Same discipline as decision 023. Loki labels stay bounded:

- `job=coderunner`, `unit=coderunner.service`, `host`, `level` (6 values), `category` (~15 values), `instance`, `deployment`.

Everything else (`workspaceId`, `runId`, `durationMs`, `importId`, `url`) is in the JSON body and accessed via `| json` in LogQL. This keeps active streams in the low hundreds even at full classroom load.

### App-side stays vendor-neutral

No reference to Grafana Cloud, Loki, or Alloy in `apps/control/`. The JSON sink is a generic structured-log output that any shipper can consume — same principle 023 applied to metrics.

## Consequences

- Cost stays $0 at classroom scale (50 GB/month free tier, ~10 MB/day projected at `LOG_LEVEL=info`).
- Per-line cost: one `JSON.stringify` per log call. Negligible.
- Adding a new logger property is automatically queryable in Loki — no manifest, no schema update.
- Two more Secret Manager entries to populate on first deploy (documented in `deploy/README.md` step 5).
- Alloy needs `systemd-journal` group membership to read journald; `bootstrap.sh` adds it.
- Trace shipping (the other deferred item from 023) is still deferred; nothing here forecloses it.

See `docs/runbook.md` § 8 "Shipping logs to Grafana Cloud Loki" for the Alloy snippet and starter LogQL queries.
