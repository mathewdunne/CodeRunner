import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import type {
  ContainerRole,
  ContainerState,
  ContainersStatusResponse,
  WorkspaceId,
} from "@frc-sim/contracts";
import type { AppStorage, ContainerLeaseRow, WorkspaceRow } from "./storage";

export type DockerCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DockerRunner = (args: string[]) => Promise<DockerCommandResult>;

type ContainerOrchestratorOptions = {
  dockerRunner?: DockerRunner | undefined;
};

type SimStatus = ContainersStatusResponse["sim"];
type LspStatus = ContainersStatusResponse["lsp"];

type DockerInspectContainer = {
  Name?: string;
  State?: {
    Running?: boolean;
    Status?: string;
  };
  Config?: {
    Labels?: Record<string, string>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
};

type PublishedPort = {
  port: number;
  hostIp: string;
  loopback: boolean;
};

const simContainerPort = 5810;
const lspContainerPort = 30003;

type RoleConfig = {
  role: ContainerRole;
  containerPort: number;
  namePrefix: string;
};

const simRoleConfig: RoleConfig = {
  role: "sim",
  containerPort: simContainerPort,
  namePrefix: "frc-v1-sim-",
};

const lspRoleConfig: RoleConfig = {
  role: "lsp",
  containerPort: lspContainerPort,
  namePrefix: "frc-v1-lsp-",
};

function roleConfig(role: ContainerRole): RoleConfig {
  return role === "sim" ? simRoleConfig : lspRoleConfig;
}

async function runDockerCli(dockerPath: string, args: string[]): Promise<DockerCommandResult> {
  const subprocess = Bun.spawn([dockerPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export async function defaultDockerRunner(args: string[]): Promise<DockerCommandResult> {
  return runDockerCli("docker", args);
}

function dockerError(args: string[], result: DockerCommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new Error(`docker ${args.join(" ")} failed: ${detail}`);
}

function dockerPortBindError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /port is already allocated|bind for .* failed|address already in use/i.test(message);
}

function containerName(role: ContainerRole, workspaceId: WorkspaceId): string {
  return `${roleConfig(role).namePrefix}${workspaceId}`;
}

function workspaceHomePath(workspace: WorkspaceRow): string {
  return resolve(dirname(workspace.project_path), "home");
}

function workspaceJdtLsDataPath(workspace: WorkspaceRow): string {
  return resolve(dirname(workspace.project_path), "jdtls-data");
}

function isLoopbackHost(hostIp: string): boolean {
  return hostIp === "127.0.0.1" || hostIp === "::1" || hostIp.toLowerCase() === "localhost";
}

function publishedPortFor(container: DockerInspectContainer, port: number): PublishedPort | null {
  const bindings = container.NetworkSettings?.Ports?.[`${port}/tcp`];
  const binding = Array.isArray(bindings) ? bindings[0] : null;
  const hostPort = Number(binding?.HostPort);
  if (!binding || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
    return null;
  }

  const hostIp = binding.HostIp ?? "";
  return {
    port: hostPort,
    hostIp,
    loopback: isLoopbackHost(hostIp),
  };
}

function containerRuntimeState(container: DockerInspectContainer): ContainerState {
  if (container.State?.Running) {
    return "running";
  }
  return "stopped";
}

function labelsMatch(container: DockerInspectContainer, role: ContainerRole, workspaceId: WorkspaceId): boolean {
  const labels = container.Config?.Labels ?? {};
  return (
    labels["frc-sim.managed"] === "true" &&
    labels["frc-sim.version"] === "v1" &&
    labels["frc-sim.role"] === role &&
    labels["frc-sim.workspace"] === workspaceId
  );
}

function leasePortFor(role: ContainerRole, lease: ContainerLeaseRow | null): number | null {
  if (!lease) {
    return null;
  }
  return role === "sim" ? lease.sim_port : lease.lsp_port;
}

function leaseContainerNameFor(role: ContainerRole, lease: ContainerLeaseRow | null): string | null {
  if (!lease) {
    return null;
  }
  return role === "sim" ? lease.sim_container : lease.lsp_container;
}

function leaseStateFor(role: ContainerRole, lease: ContainerLeaseRow | null): ContainerState {
  if (!lease) {
    return "missing";
  }
  return role === "sim" ? lease.state : lease.lsp_state;
}

function statusFromLease(
  role: ContainerRole,
  configImage: string,
  lease: ContainerLeaseRow | null,
  state: ContainerState,
  error: string | null = null,
): SimStatus | LspStatus {
  return {
    role,
    state,
    image: configImage,
    containerName: leaseContainerNameFor(role, lease),
    portAllocated: leasePortFor(role, lease) !== null,
    lastUsedAt: lease?.last_used_at ?? null,
    error,
  } as SimStatus | LspStatus;
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePort) => {
    const server = createServer();
    let settled = false;

    const settle = (free: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (free) {
        server.close(() => resolvePort(true));
      } else {
        resolvePort(false);
      }
    };

    server.once("error", () => settle(false));
    server.listen({ host: "127.0.0.1", port }, () => settle(true));
  });
}

export class ContainerOrchestrator {
  private readonly dockerRunner: DockerRunner;
  private readonly activeEnsures = new Map<string, Promise<SimStatus | LspStatus>>();
  private portReservationLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: AppStorage,
    options: ContainerOrchestratorOptions = {},
  ) {
    this.dockerRunner = options.dockerRunner ?? ((args) => runDockerCli(this.storage.config.dockerPath, args));
  }

  startSimContainer(workspace: WorkspaceRow): void {
    if (!this.storage.config.containerAutoStart) {
      return;
    }

    void this.ensureSimContainer(workspace).catch(() => {
      // The status endpoint exposes startup failures; opening the IDE should not be blocked by Docker.
    });
  }

  startLspContainer(workspace: WorkspaceRow): void {
    if (!this.storage.config.containerAutoStart) {
      return;
    }

    void this.ensureLspContainer(workspace).catch(() => {
      // Opening the IDE never blocks on LSP container startup.
    });
  }

  startWorkspaceContainers(workspace: WorkspaceRow): void {
    this.startSimContainer(workspace);
    this.startLspContainer(workspace);
  }

  async containersStatus(workspace: WorkspaceRow): Promise<ContainersStatusResponse> {
    const [sim, lsp] = await Promise.all([
      this.ensureSimContainer(workspace),
      this.ensureLspContainer(workspace),
    ]);
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
      },
      sim,
      lsp,
    };
  }

  async ensureSimContainer(workspace: WorkspaceRow): Promise<SimStatus> {
    return (await this.ensureContainer("sim", workspace)) as SimStatus;
  }

  async ensureLspContainer(workspace: WorkspaceRow): Promise<LspStatus> {
    return (await this.ensureContainer("lsp", workspace)) as LspStatus;
  }

  private async ensureContainer(role: ContainerRole, workspace: WorkspaceRow): Promise<SimStatus | LspStatus> {
    const key = `${role}:${workspace.id}`;
    const existing = this.activeEnsures.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.ensureContainerInner(role, workspace).catch((error) =>
      this.recordError(role, workspace, error),
    );
    this.activeEnsures.set(key, pending);
    try {
      return await pending;
    } finally {
      this.activeEnsures.delete(key);
    }
  }

  private async runDocker(args: string[], allowFailure = false): Promise<DockerCommandResult> {
    const result = await this.dockerRunner(args);
    if (!allowFailure && result.exitCode !== 0) {
      throw dockerError(args, result);
    }
    return result;
  }

  private async inspectContainer(name: string): Promise<DockerInspectContainer | null> {
    const result = await this.runDocker(["container", "inspect", name], true);
    if (result.exitCode !== 0) {
      return null;
    }

    const parsed = JSON.parse(result.stdout) as DockerInspectContainer[];
    return parsed[0] ?? null;
  }

  private async listManagedContainerNames(role: ContainerRole, workspaceId: WorkspaceId): Promise<string[]> {
    const result = await this.runDocker(
      [
        "container",
        "ls",
        "-a",
        "--filter",
        "label=frc-sim.managed=true",
        "--filter",
        "label=frc-sim.version=v1",
        "--filter",
        `label=frc-sim.role=${role}`,
        "--filter",
        `label=frc-sim.workspace=${workspaceId}`,
        "--format",
        "{{.Names}}",
      ],
      true,
    );
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async findManagedContainer(
    role: ContainerRole,
    workspaceId: WorkspaceId,
  ): Promise<{ name: string; container: DockerInspectContainer } | null> {
    const expectedName = containerName(role, workspaceId);
    const expected = await this.inspectContainer(expectedName);
    if (expected) {
      return { name: expectedName, container: expected };
    }

    for (const name of await this.listManagedContainerNames(role, workspaceId)) {
      const container = await this.inspectContainer(name);
      if (container) {
        return { name, container };
      }
    }

    return null;
  }

  private imageFor(role: ContainerRole): string {
    return role === "sim" ? this.storage.config.simImage : this.storage.config.lspImage;
  }

  private memoryLimitFor(role: ContainerRole): string {
    return role === "sim" ? this.storage.config.simMemoryLimit : this.storage.config.lspMemoryLimit;
  }

  private portRangeFor(role: ContainerRole): { start: number; end: number } {
    return role === "sim" ? this.storage.config.simPortRange : this.storage.config.lspPortRange;
  }

  private async ensureImage(role: ContainerRole): Promise<void> {
    const image = this.imageFor(role);
    const result = await this.runDocker(["image", "inspect", image], true);
    if (result.exitCode !== 0) {
      const buildHint =
        role === "sim" ? "bun run docker:build:sim" : "bun run docker:build:lsp";
      throw new Error(`${role.toUpperCase()} image ${image} is not available. Build it with ${buildHint}.`);
    }
  }

  private async withPortReservationLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.portReservationLock;
    let release!: () => void;
    this.portReservationLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });

    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async allocatePort(
    role: ContainerRole,
    workspaceId: WorkspaceId,
    preferredPort: number | null,
    rejectedPorts: Set<number>,
  ): Promise<number> {
    const range = this.portRangeFor(role);
    const leasedPorts = new Set(this.storage.listLeasedPorts(role, workspaceId));
    const candidates: number[] = [];
    if (preferredPort !== null) {
      candidates.push(preferredPort);
    }
    for (let port = range.start; port <= range.end; port += 1) {
      candidates.push(port);
    }

    for (const port of candidates) {
      if (port < range.start || port > range.end) {
        continue;
      }
      if (rejectedPorts.has(port)) {
        continue;
      }
      if (leasedPorts.has(port)) {
        continue;
      }
      if (await portIsFree(port)) {
        return port;
      }
    }

    throw new Error(`No free ${role} ports are available in ${range.start}-${range.end}.`);
  }

  private async reservePort(
    role: ContainerRole,
    workspace: WorkspaceRow,
    rejectedPorts: Set<number>,
  ): Promise<number> {
    return await this.withPortReservationLock(async () => {
      const lease = this.storage.getContainerLease(workspace.id);
      const port = await this.allocatePort(role, workspace.id, leasePortFor(role, lease), rejectedPorts);
      this.storage.upsertContainerLease({
        workspaceId: workspace.id,
        role,
        containerName: leaseContainerNameFor(role, lease) ?? containerName(role, workspace.id),
        port,
        state: "starting",
      });
      return port;
    });
  }

  private async adoptContainer(
    role: ContainerRole,
    workspace: WorkspaceRow,
    name: string,
    container: DockerInspectContainer,
  ): Promise<SimStatus | LspStatus | null> {
    if (!labelsMatch(container, role, workspace.id)) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const cfg = roleConfig(role);
    const published = publishedPortFor(container, cfg.containerPort);
    if (!published || !published.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    if (container.State?.Running) {
      const lease = this.storage.upsertContainerLease({
        workspaceId: workspace.id,
        role,
        containerName: name,
        port: published?.port ?? null,
        state: "running",
      });
      return statusFromLease(role, this.imageFor(role), lease, "running");
    }

    const start = await this.runDocker(["start", name], true);
    if (start.exitCode !== 0) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const restarted = await this.inspectContainer(name);
    const restartedPort = restarted ? publishedPortFor(restarted, cfg.containerPort) : null;
    if (!restarted || !labelsMatch(restarted, role, workspace.id) || !restartedPort || !restartedPort.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const lease = this.storage.upsertContainerLease({
      workspaceId: workspace.id,
      role,
      containerName: name,
      port: restartedPort?.port ?? published?.port ?? null,
      state: containerRuntimeState(restarted),
    });
    return statusFromLease(role, this.imageFor(role), lease, leaseStateFor(role, lease));
  }

  private async createContainer(
    role: ContainerRole,
    workspace: WorkspaceRow,
    port: number,
  ): Promise<SimStatus | LspStatus> {
    await this.ensureImage(role);
    const homePath = workspaceHomePath(workspace);
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    const jdtLsDataPath = workspaceJdtLsDataPath(workspace);
    if (role === "lsp") {
      await mkdir(jdtLsDataPath, { recursive: true });
    }

    const name = containerName(role, workspace.id);
    let lease = this.storage.upsertContainerLease({
      workspaceId: workspace.id,
      role,
      containerName: name,
      port,
      state: "starting",
    });

    const cfg = roleConfig(role);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "frc-sim.managed=true",
      "--label",
      "frc-sim.version=v1",
      "--label",
      `frc-sim.role=${role}`,
      "--label",
      `frc-sim.workspace=${workspace.id}`,
      "--mount",
      `type=bind,src=${workspace.project_path},dst=/workspace/project`,
      "--mount",
      `type=bind,src=${homePath},dst=/home/frc`,
      "-p",
      `127.0.0.1:${port}:${cfg.containerPort}`,
      "--memory",
      this.memoryLimitFor(role),
      "-e",
      "HOME=/home/frc",
      "-e",
      "GRADLE_USER_HOME=/home/frc/.gradle",
    ];

    if (role === "lsp") {
      args.push("--mount", `type=bind,src=${jdtLsDataPath},dst=/workspace/jdtls-data`);
    }

    if (this.storage.config.containerUser) {
      args.push("--user", this.storage.config.containerUser);
    }

    args.push(this.imageFor(role));
    await this.runDocker(args);

    const created = await this.inspectContainer(name);
    const published = created ? publishedPortFor(created, cfg.containerPort) : null;
    lease = this.storage.upsertContainerLease({
      workspaceId: workspace.id,
      role,
      containerName: name,
      port: published?.port ?? port,
      state: created ? containerRuntimeState(created) : "starting",
    });

    return statusFromLease(role, this.imageFor(role), lease, leaseStateFor(role, lease));
  }

  private async ensureContainerInner(role: ContainerRole, workspace: WorkspaceRow): Promise<SimStatus | LspStatus> {
    const existing = await this.findManagedContainer(role, workspace.id);
    if (existing) {
      const adopted = await this.adoptContainer(role, workspace, existing.name, existing.container);
      if (adopted) {
        return adopted;
      }
    }

    const range = this.portRangeFor(role);
    const rejectedPorts = new Set<number>();
    const maxAttempts = range.end - range.start + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const port = await this.reservePort(role, workspace, rejectedPorts);
      try {
        return await this.createContainer(role, workspace, port);
      } catch (error) {
        if (!dockerPortBindError(error)) {
          throw error;
        }
        rejectedPorts.add(port);
        this.storage.clearReservedPort(role, workspace.id, port);
      }
    }

    throw new Error(`No free ${role} ports are available in ${range.start}-${range.end}.`);
  }

  private recordError(role: ContainerRole, workspace: WorkspaceRow, error: unknown): SimStatus | LspStatus {
    const message = error instanceof Error ? error.message : `Unable to start ${role} container.`;
    const previous = this.storage.getContainerLease(workspace.id);
    const lease = this.storage.upsertContainerLease({
      workspaceId: workspace.id,
      role,
      containerName: leaseContainerNameFor(role, previous) ?? containerName(role, workspace.id),
      port: leasePortFor(role, previous),
      state: "error",
    });
    return statusFromLease(role, this.imageFor(role), lease, "error", message);
  }
}
