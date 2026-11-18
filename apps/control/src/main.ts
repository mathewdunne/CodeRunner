import { resolve } from "node:path";
import type { ControlAppOptions } from "./app";
import { envContainerUser } from "./config";
import { selfInspect } from "./containers/self-inspect";
import {
	configureLogging,
	defaultLogFormat,
	defaultLogLevel,
	getLogger,
} from "./logging";
import { enableDefaultMetrics } from "./metrics";

await configureLogging(defaultLogLevel(), defaultLogFormat());
enableDefaultMetrics();

const log = getLogger("boot");

const { createApp } = await import("./app");

const demoFlag = Bun.argv.includes("--demo");

const port = Number(Bun.env.PORT ?? 4000);

// Zero-config containerized mode: inside a container we inspect ourselves to
// derive the host data path, workspace network, and data-dir owner. On the host
// this is a no-op (no /.dockerenv → no Docker calls, nothing derived).
//
// Precedence: loadControlConfig resolves each field as `input.X ?? Bun.env.X`,
// so passing a derived value as input would beat an explicit env override —
// wrong direction. selfInspect takes the explicit env values and returns the
// finals (env wins, inspection fills the gaps); we pass those finals as input.
// Empty/whitespace values count as unset — a bare "FRC_CONTAINER_NETWORK="
// line in .env must not read as an explicit override that skips detection.
const inspection = await selfInspect({
	dataDir: resolve(Bun.env.FRC_DATA_DIR ?? "data"),
	envHostDataDir: Bun.env.FRC_HOST_DATA_DIR?.trim() || null,
	envContainerNetwork: Bun.env.FRC_CONTAINER_NETWORK?.trim() || null,
	envContainerUser: envContainerUser(),
});

const configInput: ControlAppOptions = {};
if (demoFlag) {
	configInput.demo = true;
}
if (inspection.containerized) {
	configInput.hostDataDir = inspection.hostDataDir;
	configInput.containerNetwork = inspection.containerNetwork;
	// Stamp workspace containers with the control plane's compose project so they
	// group under it in Portainer / `docker compose ls`. Null when unread.
	configInput.composeProject = inspection.composeProject;
	// Leave containerUser absent when the data dir is root-owned (undefined) so
	// loadControlConfig's root-guard fires instead of silently running
	// workspaces as root.
	if (inspection.containerUser !== undefined) {
		configInput.containerUser = inspection.containerUser;
	}
}

const app = await createApp(configInput);
const c = app.storage.config;

if (c.demo) {
	const banner = [
		"================================================================",
		"  DEMO MODE ENABLED — authentication is bypassed.",
		"  Every visitor logs in as the same admin user and shares one",
		"  workspace. DO NOT deploy this instance publicly.",
		"================================================================",
	];
	for (const line of banner) log.warn(line);
}

// In network mode workspace containers publish no host ports, so the port
// ranges do not bound concurrency — MAX_ACTIVE_CONTAINERS does.
const maxStudents = c.containerNetwork
	? c.maxActiveContainers
	: Math.min(
			c.simPortRange.end - c.simPortRange.start + 1,
			c.vscodePortRange.end - c.vscodePortRange.start + 1,
		);

const detected = inspection.autoDetected;
log.info("control plane configuration", {
	logLevel: c.logLevel,
	dataDir: c.dataDir,
	hostDataDir: c.hostDataDir
		? detected.hostDataDir
			? `${c.hostDataDir} (auto-detected)`
			: c.hostDataDir
		: "(same as dataDir)",
	codeImage: c.codeImage,
	codeMemoryLimit: c.codeMemoryLimit,
	codeDiskReadLimit: c.codeDiskReadLimit ?? "(disabled)",
	containerNetwork: c.containerNetwork
		? detected.containerNetwork
			? `${c.containerNetwork} (auto-detected)`
			: c.containerNetwork
		: "(none — loopback published ports)",
	composeProject: c.composeProject ?? "(none; workspaces ungrouped)",
	simPorts: c.containerNetwork
		? "(unused in network mode)"
		: `${c.simPortRange.start}-${c.simPortRange.end}`,
	vscodePorts: c.containerNetwork
		? "(unused in network mode)"
		: `${c.vscodePortRange.start}-${c.vscodePortRange.end}`,
	buildTimeoutSec: c.runBuildTimeoutMs / 1000,
	simStartupSec: c.simStartupTimeoutMs / 1000,
	idleStopMinutes: c.idleStopMinutes,
	idleCheckSec: c.idleCheckIntervalMs / 1000,
	gradleCachePruneDays: c.demo
		? "(disabled in demo)"
		: c.gradleCachePruneDays || "(disabled)",
	containerUser: c.containerUser
		? detected.containerUser
			? `${c.containerUser} (auto-detected)`
			: c.containerUser
		: "(auto)",
	containerAutoStart: c.containerAutoStart,
	adminAuth: c.demo
		? "demo mode (auth bypassed)"
		: c.adminToken
			? "better-auth + bearer break-glass"
			: "better-auth admin role",
	maxStudents,
});

const server = Bun.serve({
	port,
	fetch: (request, server) => app.fetch(request, server),
	websocket: app.websocket,
	idleTimeout: 30,
});

log.info("listening", {
	url: `http://localhost:${server.port}`,
	port: server.port,
});
