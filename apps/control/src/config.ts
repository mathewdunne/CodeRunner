import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLogLevel, type LogLevel, parseLogLevelEnv } from "./logging";

export type PortRange = {
	start: number;
	end: number;
};

export type ControlConfig = {
	logLevel: LogLevel;
	dataDir: string;
	dbPath: string;
	catalogRepo: string | null;
	catalogBranch: string;
	catalogDir: string;
	migrationsDir: string;
	webDistDir: string;
	advantageScopeDistDir: string;
	pathplannerDistDir: string;
	sessionSecret: string;
	baseUrl: string;
	githubClientId: string | null;
	githubClientSecret: string | null;
	googleClientId: string | null;
	googleClientSecret: string | null;
	auth0Domain: string | null;
	auth0ClientId: string | null;
	auth0ClientSecret: string | null;
	/** ID-token claim holding the user's Auth0 role names. */
	auth0RolesClaim: string;
	/** Auth0 role name that maps to CodeRunner `student`. */
	auth0UserRoleName: string;
	/** Auth0 role name that maps to CodeRunner `admin`. */
	auth0AdminRoleName: string;
	dockerPath: string;
	codeImage: string;
	codeMemoryLimit: string;
	/** Per-device `--device-read-bps` rate for workspace containers; null = no limit. */
	codeDiskReadLimit: string | null;
	containerNetwork: string | null;
	composeProject: string | null;
	hostDataDir: string | null;
	simPortRange: PortRange;
	vscodePortRange: PortRange;
	halsimPortRange: PortRange;
	runBuildTimeoutMs: number;
	simStartupTimeoutMs: number;
	containerUser: string | null;
	containerAutoStart: boolean;
	idleStopMinutes: number;
	idleCheckIntervalMs: number;
	adminToken: string | null;
	maxActiveContainers: number;
	demo: boolean;
	adminEmails: string[];
};

export type ControlConfigInput = Partial<
	Omit<
		ControlConfig,
		| "simPortRange"
		| "vscodePortRange"
		| "halsimPortRange"
		| "logLevel"
		| "containerAutoStart"
		| "demo"
		| "adminEmails"
	>
> & {
	simPortRange?: PortRange | string;
	vscodePortRange?: PortRange | string;
	halsimPortRange?: PortRange | string;
	idleStopMinutes?: number | string;
	idleCheckIntervalMs?: number | string;
	maxActiveContainers?: number | string;
	port?: number | string;
	logLevel?: LogLevel | string;
	demo?: boolean | string;
	containerAutoStart?: boolean | string;
	adminEmails?: string[] | string;
};

function parseLogLevelOrThrow(value: string | LogLevel | undefined): LogLevel {
	if (!value) return defaultLogLevel();
	if (typeof value !== "string") return value;
	const parsed = parseLogLevelEnv(value);
	if (!parsed) {
		throw new Error(
			`Invalid LOG_LEVEL "${value}". Expected one of: trace, debug, info, warning, error, fatal.`,
		);
	}
	return parsed;
}

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultDataDir = resolve(repoRoot, "data");
const defaultSimPortRange: PortRange = { start: 25810, end: 25899 };
const defaultVscodePortRange: PortRange = { start: 33000, end: 33099 };
const defaultHalsimPortRange: PortRange = { start: 34000, end: 34099 };

function parsePortRange(
	value: string | PortRange | undefined,
	fallback: PortRange,
): PortRange {
	if (!value) {
		return fallback;
	}

	if (typeof value !== "string") {
		return value;
	}

	const match = /^(\d{1,5})-(\d{1,5})$/u.exec(value.trim());
	if (!match) {
		throw new Error(`Invalid port range "${value}". Expected start-end.`);
	}

	const start = Number(match[1]);
	const end = Number(match[2]);
	if (
		!Number.isInteger(start) ||
		!Number.isInteger(end) ||
		start < 1 ||
		end > 65535 ||
		start > end
	) {
		throw new Error(
			`Invalid port range "${value}". Ports must be 1-65535 and start must be <= end.`,
		);
	}

	return { start, end };
}

function parseBoolean(
	value: string | boolean | undefined,
	fallback: boolean,
): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (value === undefined) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "") {
		return fallback;
	}
	return !["0", "false", "no", "off"].includes(normalized);
}

function parseAdminEmails(value: string | string[] | undefined): string[] {
	if (value === undefined) {
		return [];
	}
	const entries = Array.isArray(value) ? value : value.split(",");
	return entries
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

function parsePositiveInteger(
	value: string | number | undefined,
	fallback: number,
	name: string,
): number {
	const parsed =
		typeof value === "number"
			? value
			: value === undefined
				? fallback
				: Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

const DISABLED_DISK_LIMIT_VALUES = new Set(["0", "off", "none", "false"]);

/**
 * A Docker byte-rate value ("64mb", "500kb", …) for `--device-read-bps`, or
 * null when disabled. Validated here so a typo fails at boot with a clear
 * message instead of failing every workspace container creation.
 */
function parseDiskReadLimit(
	value: string | null | undefined,
	fallback: string,
): string | null {
	if (value === null) {
		return null;
	}
	// An empty value ("CODE_DISK_READ_LIMIT=" left in .env) means unset, not
	// disabled — disabling this guard requires an explicit "0"/"off".
	const raw = ((value ?? "").trim() || fallback).toLowerCase();
	if (DISABLED_DISK_LIMIT_VALUES.has(raw)) {
		return null;
	}
	if (!/^\d+(b|kb|mb|gb)?$/u.test(raw)) {
		throw new Error(
			`Invalid CODE_DISK_READ_LIMIT "${value}". Expected a Docker byte rate ` +
				`like "64mb" (units: b, kb, mb, gb), or "0" to disable.`,
		);
	}
	return raw;
}

/**
 * Explicit workspace-user override from the environment: FRC_CONTAINER_USER,
 * or FRC_UID:FRC_GID. Null when neither is set.
 */
export function envContainerUser(): string | null {
	if (Bun.env.FRC_CONTAINER_USER) {
		return Bun.env.FRC_CONTAINER_USER;
	}

	if (Bun.env.FRC_UID && Bun.env.FRC_GID) {
		return `${Bun.env.FRC_UID}:${Bun.env.FRC_GID}`;
	}

	return null;
}

function defaultContainerUser(): string | null {
	const fromEnv = envContainerUser();
	if (fromEnv !== null) {
		return fromEnv;
	}

	if (
		process.platform !== "win32" &&
		typeof process.getuid === "function" &&
		typeof process.getgid === "function"
	) {
		return `${process.getuid()}:${process.getgid()}`;
	}

	return null;
}

function parseHostDataDir(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}
	if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(trimmed)) {
		throw new Error(
			`FRC_HOST_DATA_DIR must be an absolute path (got "${value}"). ` +
				"It is the host-side location of the data directory, passed verbatim " +
				"to the Docker daemon for bind mounts.",
		);
	}
	return trimmed;
}

export function loadControlConfig(
	input: ControlConfigInput = {},
): ControlConfig {
	const dataDir = resolve(
		input.dataDir ?? Bun.env.FRC_DATA_DIR ?? defaultDataDir,
	);

	// An empty/whitespace value ("FRC_CONTAINER_NETWORK=" left in .env) must
	// mean unset, not network mode with `docker run --network ""`.
	const containerNetwork =
		(input.containerNetwork ?? Bun.env.FRC_CONTAINER_NETWORK)?.trim() || null;
	const containerUser =
		input.containerUser === undefined
			? defaultContainerUser()
			: input.containerUser;

	// Inside a container the process usually runs as root, so the "mirror my
	// own uid:gid" fallback would silently run workspace containers as root and
	// root-own student files on the host data disk. Network mode is the marker
	// for a containerized deployment, so demand an explicit user there.
	const explicitContainerUser =
		input.containerUser !== undefined || envContainerUser() !== null;
	if (
		containerNetwork &&
		containerUser?.split(":")[0] === "0" &&
		!explicitContainerUser
	) {
		throw new Error(
			"Workspace containers use network mode (containerized control plane) " +
				"and the control plane is running as root, " +
				"but no workspace container user is configured. Either chown the data " +
				"directory to the intended non-root owner (the control plane derives the " +
				"workspace user from the data dir's uid:gid) or set FRC_CONTAINER_USER " +
				"(uid:gid of the host owner of the data directory) so student files are " +
				"not created as root.",
		);
	}

	return {
		logLevel: parseLogLevelOrThrow(input.logLevel ?? Bun.env.LOG_LEVEL),
		dataDir,
		dbPath: resolve(
			input.dbPath ?? Bun.env.FRC_DB_PATH ?? resolve(dataDir, "app.db"),
		),
		catalogRepo: input.catalogRepo ?? Bun.env.LESSONS_CATALOG_REPO ?? null,
		catalogBranch:
			input.catalogBranch ?? Bun.env.LESSONS_CATALOG_BRANCH ?? "main",
		catalogDir: resolve(
			input.catalogDir ??
				Bun.env.LESSONS_CATALOG_DIR ??
				resolve(repoRoot, "catalog"),
		),
		migrationsDir: resolve(
			input.migrationsDir ??
				Bun.env.FRC_MIGRATIONS_DIR ??
				fileURLToPath(new URL("../migrations", import.meta.url)),
		),
		webDistDir: resolve(
			input.webDistDir ??
				Bun.env.FRC_WEB_DIST_DIR ??
				resolve(repoRoot, "apps", "web", "dist"),
		),
		advantageScopeDistDir: resolve(
			input.advantageScopeDistDir ??
				Bun.env.FRC_ASCOPE_DIST_DIR ??
				resolve(repoRoot, "dist", "advantagescope"),
		),
		pathplannerDistDir: resolve(
			input.pathplannerDistDir ??
				Bun.env.FRC_PATHPLANNER_DIST_DIR ??
				resolve(repoRoot, "dist", "pathplanner"),
		),
		sessionSecret:
			input.sessionSecret ??
			Bun.env.BETTER_AUTH_SECRET ??
			"frc-local-dev-session-secret-change-me",
		baseUrl:
			input.baseUrl ??
			Bun.env.BETTER_AUTH_URL ??
			`http://localhost:${input.port ?? Bun.env.PORT ?? 4000}`,
		githubClientId: input.githubClientId ?? Bun.env.GITHUB_CLIENT_ID ?? null,
		githubClientSecret:
			input.githubClientSecret ?? Bun.env.GITHUB_CLIENT_SECRET ?? null,
		googleClientId: input.googleClientId ?? Bun.env.GOOGLE_CLIENT_ID ?? null,
		googleClientSecret:
			input.googleClientSecret ?? Bun.env.GOOGLE_CLIENT_SECRET ?? null,
		auth0Domain: input.auth0Domain ?? Bun.env.AUTH0_DOMAIN ?? null,
		auth0ClientId: input.auth0ClientId ?? Bun.env.AUTH0_CLIENT_ID ?? null,
		auth0ClientSecret:
			input.auth0ClientSecret ?? Bun.env.AUTH0_CLIENT_SECRET ?? null,
		auth0RolesClaim:
			input.auth0RolesClaim ??
			Bun.env.AUTH0_ROLES_CLAIM ??
			"https://coderunner/roles",
		auth0UserRoleName:
			input.auth0UserRoleName ?? Bun.env.AUTH0_USER_ROLE_NAME ?? "user",
		auth0AdminRoleName:
			input.auth0AdminRoleName ?? Bun.env.AUTH0_ADMIN_ROLE_NAME ?? "admin",
		dockerPath: input.dockerPath ?? Bun.env.FRC_DOCKER_PATH ?? "docker",
		codeImage:
			input.codeImage ??
			Bun.env.CODE_IMAGE ??
			`${Bun.env.CODERUNNER_IMAGE_NS ?? "ghcr.io/mathewdunne"}/coderunner-workspace:${Bun.env.CODERUNNER_TAG ?? "latest"}`,
		codeMemoryLimit:
			input.codeMemoryLimit ?? Bun.env.CODE_MEMORY_LIMIT ?? "4096m",
		// `??` would turn an explicit null (disable) into the env/default value.
		codeDiskReadLimit: parseDiskReadLimit(
			input.codeDiskReadLimit === undefined
				? Bun.env.CODE_DISK_READ_LIMIT
				: input.codeDiskReadLimit,
			"64mb",
		),
		containerNetwork,
		composeProject: input.composeProject ?? null,
		hostDataDir: parseHostDataDir(
			input.hostDataDir ?? Bun.env.FRC_HOST_DATA_DIR ?? null,
		),
		simPortRange: parsePortRange(
			input.simPortRange ?? Bun.env.SIM_PORT_RANGE,
			defaultSimPortRange,
		),
		vscodePortRange: parsePortRange(
			input.vscodePortRange ?? Bun.env.VSCODE_PORT_RANGE,
			defaultVscodePortRange,
		),
		halsimPortRange: parsePortRange(
			input.halsimPortRange ?? Bun.env.HALSIM_PORT_RANGE,
			defaultHalsimPortRange,
		),
		runBuildTimeoutMs: parsePositiveInteger(
			input.runBuildTimeoutMs ?? Bun.env.RUN_BUILD_TIMEOUT_MS,
			90_000,
			"RUN_BUILD_TIMEOUT_MS",
		),
		simStartupTimeoutMs: parsePositiveInteger(
			input.simStartupTimeoutMs ?? Bun.env.SIM_STARTUP_TIMEOUT_MS,
			30_000,
			"SIM_STARTUP_TIMEOUT_MS",
		),
		containerUser,
		containerAutoStart: parseBoolean(
			input.containerAutoStart ??
				Bun.env.FRC_CONTAINER_AUTO_START ??
				Bun.env.CONTAINER_AUTO_START,
			true,
		),
		idleStopMinutes: parsePositiveInteger(
			input.idleStopMinutes ?? Bun.env.IDLE_STOP_MINUTES,
			30,
			"IDLE_STOP_MINUTES",
		),
		idleCheckIntervalMs: parsePositiveInteger(
			input.idleCheckIntervalMs ?? Bun.env.IDLE_CHECK_INTERVAL_MS,
			60_000,
			"IDLE_CHECK_INTERVAL_MS",
		),
		adminToken: input.adminToken ?? Bun.env.ADMIN_TOKEN ?? null,
		maxActiveContainers: parsePositiveInteger(
			input.maxActiveContainers ?? Bun.env.MAX_ACTIVE_CONTAINERS,
			10,
			"MAX_ACTIVE_CONTAINERS",
		),
		demo: parseBoolean(input.demo ?? Bun.env.CODERUNNER_DEMO_MODE, false),
		adminEmails: parseAdminEmails(
			input.adminEmails ?? Bun.env.CODERUNNER_ADMIN_EMAIL,
		),
	};
}
