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

const port = Number(Bun.env.PORT ?? 4000);
const app = await createApp();
const c = app.storage.config;

const simRange = `${c.simPortRange.start}-${c.simPortRange.end}`;
const vscodeRange = `${c.vscodePortRange.start}-${c.vscodePortRange.end}`;
const maxStudents = Math.min(
	c.simPortRange.end - c.simPortRange.start + 1,
	c.vscodePortRange.end - c.vscodePortRange.start + 1,
);

log.info("control plane configuration", {
	logLevel: c.logLevel,
	dataDir: c.dataDir,
	codeImage: c.codeImage,
	codeMemoryLimit: c.codeMemoryLimit,
	simPorts: simRange,
	vscodePorts: vscodeRange,
	buildTimeoutSec: c.runBuildTimeoutMs / 1000,
	simStartupSec: c.simStartupTimeoutMs / 1000,
	idleStopMinutes: c.idleStopMinutes,
	idleCheckSec: c.idleCheckIntervalMs / 1000,
	containerUser: c.containerUser ?? "(auto)",
	containerAutoStart: c.containerAutoStart,
	adminAuth: c.adminToken
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
