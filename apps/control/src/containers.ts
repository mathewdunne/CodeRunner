import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import type {
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

export type CodeContainerStatus = ContainersStatusResponse["code"];

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

const SIM_CONTAINER_PORT = 5810;
const VSCODE_CONTAINER_PORT = 3000;
const CODE_NAME_PREFIX = "frc-v2-code-";

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

function codeContainerName(workspaceId: WorkspaceId): string {
  return `${CODE_NAME_PREFIX}${workspaceId}`;
}

function workspaceHomePath(workspace: WorkspaceRow): string {
  return resolve(dirname(workspace.project_path), "home");
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

function v2LabelsMatch(container: DockerInspectContainer, workspaceId: WorkspaceId): boolean {
  const labels = container.Config?.Labels ?? {};
  return (
    labels["frc-sim.managed"] === "true" &&
    labels["frc-sim.version"] === "v2" &&
    labels["frc-sim.role"] === "code" &&
    labels["frc-sim.workspace"] === workspaceId
  );
}

function statusFromLease(
  image: string,
  lease: ContainerLeaseRow | null,
  state: ContainerState,
  error: string | null = null,
): CodeContainerStatus {
  return {
    role: "code",
    state,
    image,
    containerName: lease?.vscode_container ?? null,
    simPortAllocated: (lease?.sim_port ?? null) !== null,
    vscodePortAllocated: (lease?.vscode_port ?? null) !== null,
    lastUsedAt: lease?.last_used_at ?? null,
    error,
  };
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
  private readonly activeEnsures = new Map<string, Promise<CodeContainerStatus>>();
  private portReservationLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: AppStorage,
    options: ContainerOrchestratorOptions = {},
  ) {
    this.dockerRunner = options.dockerRunner ?? ((args) => runDockerCli(this.storage.config.dockerPath, args));
  }

  startWorkspaceContainers(workspace: WorkspaceRow): void {
    if (!this.storage.config.containerAutoStart) {
      return;
    }

    void this.ensureCodeContainer(workspace).catch(() => {
      // The status endpoint exposes startup failures; opening the IDE should not be blocked by Docker.
    });
  }

  async containersStatus(workspace: WorkspaceRow): Promise<ContainersStatusResponse> {
    const code = await this.ensureCodeContainer(workspace);
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
      },
      code,
    };
  }

  async stopCodeContainer(workspaceId: WorkspaceId): Promise<void> {
    const name = codeContainerName(workspaceId);
    const existing = await this.inspectContainer(name);
    if (existing?.State?.Running) {
      await this.runDocker(["stop", name], true);
    }
    const lease = this.storage.getContainerLease(workspaceId);
    if (lease) {
      this.storage.upsertCodeContainerLease({
        workspaceId,
        containerName: name,
        simPort: lease.sim_port,
        vscodePort: lease.vscode_port,
        state: "stopped",
      });
    }
  }

  async removeCodeContainer(workspaceId: WorkspaceId): Promise<void> {
    const name = codeContainerName(workspaceId);
    await this.runDocker(["rm", "-f", name], true);
    const lease = this.storage.getContainerLease(workspaceId);
    if (lease) {
      this.storage.upsertCodeContainerLease({
        workspaceId,
        containerName: name,
        simPort: null,
        vscodePort: null,
        state: "missing",
      });
    }
  }

  async stopWorkspaceContainers(workspaceId: WorkspaceId): Promise<void> {
    await this.stopCodeContainer(workspaceId);
  }

  async restartCodeContainer(workspace: WorkspaceRow): Promise<CodeContainerStatus> {
    await this.stopCodeContainer(workspace.id);
    await this.removeCodeContainer(workspace.id);
    this.activeEnsures.delete(`code:${workspace.id}`);
    return this.ensureCodeContainer(workspace);
  }

  async cleanupStoppedContainers(): Promise<string[]> {
    const result = await this.runDocker(
      [
        "container",
        "ls",
        "-a",
        "--filter",
        "label=frc-sim.managed=true",
        "--filter",
        "status=exited",
        "--format",
        "{{.Names}}",
      ],
      true,
    );
    if (result.exitCode !== 0) {
      return [];
    }

    const names = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    const removed: string[] = [];
    for (const name of names) {
      const removeResult = await this.runDocker(["rm", name], true);
      if (removeResult.exitCode === 0) {
        removed.push(name);
      }
    }
    return removed;
  }

  /** Remove any V1 sim or LSP containers found on the Docker daemon. */
  async cleanupV1Containers(): Promise<string[]> {
    const result = await this.runDocker(
      [
        "container",
        "ls",
        "-a",
        "--filter",
        "label=frc-sim.managed=true",
        "--filter",
        "label=frc-sim.version=v1",
        "--format",
        "{{.Names}}",
      ],
      true,
    );
    if (result.exitCode !== 0) {
      return [];
    }

    const names = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    const removed: string[] = [];
    for (const name of names) {
      await this.runDocker(["stop", name], true);
      const removeResult = await this.runDocker(["rm", "-f", name], true);
      if (removeResult.exitCode === 0) {
        removed.push(name);
      }
    }
    return removed;
  }

  async ensureCodeContainer(workspace: WorkspaceRow): Promise<CodeContainerStatus> {
    const key = `code:${workspace.id}`;
    const existing = this.activeEnsures.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.ensureCodeContainerInner(workspace).catch((error) =>
      this.recordError(workspace, error),
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

  private async ensureImage(): Promise<void> {
    const image = this.storage.config.codeImage;
    const result = await this.runDocker(["image", "inspect", image], true);
    if (result.exitCode !== 0) {
      throw new Error(`CODE image ${image} is not available. Build it with bun run docker:build:code.`);
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

  private async allocatePortFromRange(
    role: "sim" | "code",
    workspaceId: WorkspaceId,
    preferredPort: number | null,
    rejectedPorts: Set<number>,
  ): Promise<number> {
    const range = role === "sim" ? this.storage.config.simPortRange : this.storage.config.vscodePortRange;
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

  private async reserveCodePorts(
    workspace: WorkspaceRow,
    rejectedSimPorts: Set<number>,
    rejectedVscodePorts: Set<number>,
  ): Promise<{ simPort: number; vscodePort: number }> {
    return await this.withPortReservationLock(async () => {
      const lease = this.storage.getContainerLease(workspace.id);
      const simPort = await this.allocatePortFromRange(
        "sim",
        workspace.id,
        lease?.sim_port ?? null,
        rejectedSimPorts,
      );
      const vscodePort = await this.allocatePortFromRange(
        "code",
        workspace.id,
        lease?.vscode_port ?? null,
        rejectedVscodePorts,
      );
      const name = codeContainerName(workspace.id);
      this.storage.upsertCodeContainerLease({
        workspaceId: workspace.id,
        containerName: name,
        simPort,
        vscodePort,
        state: "starting",
      });
      return { simPort, vscodePort };
    });
  }

  private async adoptCodeContainer(
    workspace: WorkspaceRow,
    name: string,
    container: DockerInspectContainer,
  ): Promise<CodeContainerStatus | null> {
    if (!v2LabelsMatch(container, workspace.id)) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const simPublished = publishedPortFor(container, SIM_CONTAINER_PORT);
    const vscodePublished = publishedPortFor(container, VSCODE_CONTAINER_PORT);
    if (!simPublished?.loopback || !vscodePublished?.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    if (container.State?.Running) {
      const lease = this.storage.upsertCodeContainerLease({
        workspaceId: workspace.id,
        containerName: name,
        simPort: simPublished.port,
        vscodePort: vscodePublished.port,
        state: "running",
      });
      return statusFromLease(this.storage.config.codeImage, lease, "running");
    }

    const start = await this.runDocker(["start", name], true);
    if (start.exitCode !== 0) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const restarted = await this.inspectContainer(name);
    if (!restarted || !v2LabelsMatch(restarted, workspace.id)) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const rSim = publishedPortFor(restarted, SIM_CONTAINER_PORT);
    const rVscode = publishedPortFor(restarted, VSCODE_CONTAINER_PORT);
    if (!rSim?.loopback || !rVscode?.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const lease = this.storage.upsertCodeContainerLease({
      workspaceId: workspace.id,
      containerName: name,
      simPort: rSim.port,
      vscodePort: rVscode.port,
      state: containerRuntimeState(restarted),
    });
    return statusFromLease(this.storage.config.codeImage, lease, lease.code_state);
  }

  private async createCodeContainer(
    workspace: WorkspaceRow,
    simPort: number,
    vscodePort: number,
  ): Promise<CodeContainerStatus> {
    await this.ensureImage();
    const homePath = workspaceHomePath(workspace);
    await mkdir(homePath, { recursive: true, mode: 0o700 });

    const name = codeContainerName(workspace.id);
    this.storage.upsertCodeContainerLease({
      workspaceId: workspace.id,
      containerName: name,
      simPort,
      vscodePort,
      state: "starting",
    });

    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "frc-sim.managed=true",
      "--label",
      "frc-sim.version=v2",
      "--label",
      "frc-sim.role=code",
      "--label",
      `frc-sim.workspace=${workspace.id}`,
      "--mount",
      `type=bind,src=${workspace.project_path},dst=/workspace/project`,
      "--mount",
      `type=bind,src=${homePath},dst=/home/frc`,
      "-p",
      `127.0.0.1:${vscodePort}:${VSCODE_CONTAINER_PORT}`,
      "-p",
      `127.0.0.1:${simPort}:${SIM_CONTAINER_PORT}`,
      "--memory",
      this.storage.config.codeMemoryLimit,
      "-e",
      `VSCODE_BASE_PATH=/u/${workspace.slug}/vscode/`,
    ];

    if (this.storage.config.containerUser) {
      args.push("--user", this.storage.config.containerUser);
    }

    args.push(this.storage.config.codeImage);
    await this.runDocker(args);

    const created = await this.inspectContainer(name);
    const createdSim = created ? publishedPortFor(created, SIM_CONTAINER_PORT) : null;
    const createdVscode = created ? publishedPortFor(created, VSCODE_CONTAINER_PORT) : null;
    const lease = this.storage.upsertCodeContainerLease({
      workspaceId: workspace.id,
      containerName: name,
      simPort: createdSim?.port ?? simPort,
      vscodePort: createdVscode?.port ?? vscodePort,
      state: created ? containerRuntimeState(created) : "starting",
    });

    return statusFromLease(this.storage.config.codeImage, lease, lease.code_state);
  }

  private async ensureCodeContainerInner(workspace: WorkspaceRow): Promise<CodeContainerStatus> {
    const expectedName = codeContainerName(workspace.id);
    const existing = await this.inspectContainer(expectedName);
    if (existing) {
      const adopted = await this.adoptCodeContainer(workspace, expectedName, existing);
      if (adopted) {
        return adopted;
      }
    }

    const simRange = this.storage.config.simPortRange;
    const vscodeRange = this.storage.config.vscodePortRange;
    const maxAttempts = Math.max(
      simRange.end - simRange.start + 1,
      vscodeRange.end - vscodeRange.start + 1,
    );
    const rejectedSimPorts = new Set<number>();
    const rejectedVscodePorts = new Set<number>();

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { simPort, vscodePort } = await this.reserveCodePorts(
        workspace,
        rejectedSimPorts,
        rejectedVscodePorts,
      );
      try {
        return await this.createCodeContainer(workspace, simPort, vscodePort);
      } catch (error) {
        if (!dockerPortBindError(error)) {
          throw error;
        }
        rejectedSimPorts.add(simPort);
        rejectedVscodePorts.add(vscodePort);
        this.storage.clearReservedPort("sim", workspace.id, simPort);
        this.storage.clearReservedPort("code", workspace.id, vscodePort);
      }
    }

    throw new Error("No free ports are available for the code container.");
  }

  private recordError(workspace: WorkspaceRow, error: unknown): CodeContainerStatus {
    const message = error instanceof Error ? error.message : "Unable to start code container.";
    const previous = this.storage.getContainerLease(workspace.id);
    const name = codeContainerName(workspace.id);
    const lease = this.storage.upsertCodeContainerLease({
      workspaceId: workspace.id,
      containerName: name,
      simPort: previous?.sim_port ?? null,
      vscodePort: previous?.vscode_port ?? null,
      state: "error",
    });
    return statusFromLease(this.storage.config.codeImage, lease, "error", message);
  }
}
