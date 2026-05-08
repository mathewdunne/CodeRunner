import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type PortRange = {
  start: number;
  end: number;
};

export type ControlConfig = {
  dataDir: string;
  dbPath: string;
  templateDir: string;
  migrationsDir: string;
  webDistDir: string;
  advantageScopeDistDir: string;
  sessionSecret: string;
  dockerPath: string;
  simImage: string;
  simMemoryLimit: string;
  simPortRange: PortRange;
  lspImage: string;
  lspMemoryLimit: string;
  lspPortRange: PortRange;
  lspStartupConcurrency: number;
  runConcurrency: number;
  runBuildTimeoutMs: number;
  simStartupTimeoutMs: number;
  containerUser: string | null;
  containerAutoStart: boolean;
  idleStopMinutes: number;
  idleCheckIntervalMs: number;
  adminToken: string | null;
};

export type ControlConfigInput = Partial<Omit<ControlConfig, "simPortRange" | "lspPortRange">> & {
  simPortRange?: PortRange | string;
  lspPortRange?: PortRange | string;
  idleStopMinutes?: number | string;
  idleCheckIntervalMs?: number | string;
};

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultDataDir = resolve(repoRoot, "data");
const defaultSimPortRange: PortRange = { start: 25810, end: 25899 };
const defaultLspPortRange: PortRange = { start: 30003, end: 30102 };

function parsePortRange(value: string | PortRange | undefined, fallback: PortRange): PortRange {
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
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    throw new Error(`Invalid port range "${value}". Ports must be 1-65535 and start must be <= end.`);
  }

  return { start, end };
}

function parseBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | number | undefined, fallback: number, name: string): number {
  const parsed = typeof value === "number" ? value : value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function defaultContainerUser(): string | null {
  if (Bun.env.FRC_CONTAINER_USER) {
    return Bun.env.FRC_CONTAINER_USER;
  }

  if (Bun.env.FRC_UID && Bun.env.FRC_GID) {
    return `${Bun.env.FRC_UID}:${Bun.env.FRC_GID}`;
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && typeof process.getgid === "function") {
    return `${process.getuid()}:${process.getgid()}`;
  }

  return null;
}

export function loadControlConfig(input: ControlConfigInput = {}): ControlConfig {
  const dataDir = resolve(input.dataDir ?? Bun.env.FRC_DATA_DIR ?? defaultDataDir);

  return {
    dataDir,
    dbPath: resolve(input.dbPath ?? Bun.env.FRC_DB_PATH ?? resolve(dataDir, "app.db")),
    templateDir: resolve(
      input.templateDir ?? Bun.env.FRC_TEMPLATE_DIR ?? resolve(repoRoot, "templates", "wpilib-java-command"),
    ),
    migrationsDir: resolve(
      input.migrationsDir ??
        Bun.env.FRC_MIGRATIONS_DIR ??
        fileURLToPath(new URL("../migrations", import.meta.url)),
    ),
    webDistDir: resolve(input.webDistDir ?? Bun.env.FRC_WEB_DIST_DIR ?? resolve(repoRoot, "apps", "web", "dist")),
    advantageScopeDistDir: resolve(
      input.advantageScopeDistDir ?? Bun.env.FRC_ASCOPE_DIST_DIR ?? resolve(repoRoot, "dist", "advantagescope"),
    ),
    sessionSecret:
      input.sessionSecret ??
      Bun.env.FRC_SESSION_SECRET ??
      "frc-v1-local-dev-session-secret-change-me",
    dockerPath: input.dockerPath ?? Bun.env.FRC_DOCKER_PATH ?? "docker",
    simImage: input.simImage ?? Bun.env.SIM_IMAGE ?? "frc-sim:v1",
    simMemoryLimit: input.simMemoryLimit ?? Bun.env.SIM_MEMORY_LIMIT ?? "1536m",
    simPortRange: parsePortRange(input.simPortRange ?? Bun.env.SIM_PORT_RANGE, defaultSimPortRange),
    lspImage: input.lspImage ?? Bun.env.LSP_IMAGE ?? "frc-lsp:v1",
    lspMemoryLimit: input.lspMemoryLimit ?? Bun.env.LSP_MEMORY_LIMIT ?? "1536m",
    lspPortRange: parsePortRange(input.lspPortRange ?? Bun.env.LSP_PORT_RANGE, defaultLspPortRange),
    lspStartupConcurrency: parsePositiveInteger(
      input.lspStartupConcurrency ?? Bun.env.LSP_STARTUP_CONCURRENCY,
      2,
      "LSP_STARTUP_CONCURRENCY",
    ),
    runConcurrency: parsePositiveInteger(input.runConcurrency ?? Bun.env.RUN_CONCURRENCY, 2, "RUN_CONCURRENCY"),
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
    containerUser: input.containerUser === undefined ? defaultContainerUser() : input.containerUser,
    containerAutoStart: parseBoolean(input.containerAutoStart ?? Bun.env.FRC_CONTAINER_AUTO_START ?? Bun.env.CONTAINER_AUTO_START, true),
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
  };
}
