import {
	Counter,
	collectDefaultMetrics,
	Gauge,
	Histogram,
	Registry,
} from "prom-client";

export const metricsRegistry = new Registry();

const httpBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const runBuckets = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
const containerStartBuckets = [0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80];

export const httpRequestDuration = new Histogram({
	name: "http_request_duration_seconds",
	help: "Control-plane HTTP request latency in seconds.",
	labelNames: ["method", "route", "status_class"] as const,
	buckets: httpBuckets,
	registers: [metricsRegistry],
});

export const httpRequestsInFlight = new Gauge({
	name: "http_requests_in_flight",
	help: "Number of HTTP requests currently being dispatched.",
	registers: [metricsRegistry],
});

export const proxyUpstreamDuration = new Histogram({
	name: "proxy_upstream_duration_seconds",
	help: "Latency of upstream proxy fetches (vscode editor, NT4, HALSim, AS Lite asset).",
	labelNames: ["upstream", "outcome"] as const,
	buckets: httpBuckets,
	registers: [metricsRegistry],
});

export const runBuildDuration = new Histogram({
	name: "run_build_duration_seconds",
	help: "Time from run queue to first sim-ready signal (compile + boot).",
	buckets: runBuckets,
	registers: [metricsRegistry],
});

export const runActiveDuration = new Histogram({
	name: "run_active_duration_seconds",
	help: "Time the run spent in the running state before terminating.",
	labelNames: ["terminal_status"] as const,
	buckets: runBuckets,
	registers: [metricsRegistry],
});

export const runsTotal = new Counter({
	name: "runs_total",
	help: "Completed run jobs by terminal status (stopped/failed/canceled).",
	labelNames: ["terminal_status"] as const,
	registers: [metricsRegistry],
});

export const containerStartDuration = new Histogram({
	name: "container_start_duration_seconds",
	help: "Time to create + start a workspace code container from cold.",
	buckets: containerStartBuckets,
	registers: [metricsRegistry],
});

export const containerCpuPercent = new Gauge({
	name: "container_cpu_percent",
	help: "Per-container CPU utilization sampled from docker stats.",
	labelNames: ["workspace_id"] as const,
	registers: [metricsRegistry],
});

export const containerMemoryPercent = new Gauge({
	name: "container_memory_percent",
	help: "Per-container memory usage as percent of the container limit.",
	labelNames: ["workspace_id"] as const,
	registers: [metricsRegistry],
});

export const activeWorkspaces = new Gauge({
	name: "active_workspaces",
	help: "Number of workspaces with a running container at the last poll.",
	registers: [metricsRegistry],
});

export const idleSweepStopsTotal = new Counter({
	name: "idle_sweep_stops_total",
	help: "Workspaces stopped by the idle sweep.",
	registers: [metricsRegistry],
});

let defaultsEnabled = false;

export function enableDefaultMetrics(): void {
	if (defaultsEnabled) return;
	defaultsEnabled = true;
	collectDefaultMetrics({ register: metricsRegistry });
}

export async function renderMetrics(): Promise<{
	body: string;
	contentType: string;
}> {
	return {
		body: await metricsRegistry.metrics(),
		contentType: metricsRegistry.contentType,
	};
}

const WORKSPACE_PATH = /^\/u\/[^/]+(\/.*)?$/u;

const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
	"/",
	"/login",
	"/healthz",
	"/admin",
	"/admin/",
	"/favicon.ico",
	"/coderunner-icon.png",
	"/api/openapi.json",
	"/api/auth/providers",
	"/scope",
	"/metrics",
]);

const KNOWN_WORKSPACE_SUFFIXES: ReadonlySet<string> = new Set([
	"/sim/alive",
	"/sim/nt4",
	"/sim/halsim",
	"/ws/run",
	"/ws/gamepad",
	"/ws/import",
	"/api/session",
	"/api/containers/status",
	"/api/sim/status",
	"/api/sim/auto-choosers",
	"/api/sim/run",
	"/api/sim/driver-station",
	"/api/sim/auto-chooser",
	"/api/run",
	"/api/run/stop",
	"/api/project/import",
	"/api/project/recent-imports",
	"/api/project/restore",
	"/api/heartbeat",
	"/coderunner-icon.png",
	"/favicon.ico",
]);

export function templateRoute(path: string): string {
	if (KNOWN_TOP_LEVEL.has(path)) return path;
	if (path.startsWith("/api/auth/")) return "/api/auth/*";
	if (path.startsWith("/scope/")) return "/scope/*";
	if (path.startsWith("/assets/")) return "/assets/*";
	if (path.startsWith("/admin/")) return "/admin/*";

	const workspace = WORKSPACE_PATH.exec(path);
	if (workspace) {
		const suffix = workspace[1] ?? "";
		if (suffix === "" || suffix === "/") return "/u/:slug/";
		if (suffix === "/vscode" || suffix.startsWith("/vscode/"))
			return "/u/:slug/vscode/*";
		if (suffix.startsWith("/assets/")) return "/u/:slug/assets/*";
		if (KNOWN_WORKSPACE_SUFFIXES.has(suffix)) return `/u/:slug${suffix}`;
		return "/u/:slug/*";
	}

	return "other";
}

export function statusClass(status: number): string {
	if (status < 100 || status > 599) return "other";
	return `${Math.floor(status / 100)}xx`;
}
