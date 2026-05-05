import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import type { ContainersStatusResponse, SimContainerState, WorkspaceId } from "@frc-sim/contracts";
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

function simContainerName(workspaceId: WorkspaceId): string {
  return `frc-v1-sim-${workspaceId}`;
}

function workspaceHomePath(workspace: WorkspaceRow): string {
  return resolve(dirname(workspace.project_path), "home");
}

function isLoopbackHost(hostIp: string): boolean {
  return hostIp === "127.0.0.1" || hostIp === "::1" || hostIp.toLowerCase() === "localhost";
}

function publishedSimPort(container: DockerInspectContainer): PublishedPort | null {
  const bindings = container.NetworkSettings?.Ports?.[`${simContainerPort}/tcp`];
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

function containerRuntimeState(container: DockerInspectContainer): SimContainerState {
  if (container.State?.Running) {
    return "running";
  }
  return "stopped";
}

function labelsMatch(container: DockerInspectContainer, workspaceId: WorkspaceId): boolean {
  const labels = container.Config?.Labels ?? {};
  return (
    labels["frc-sim.managed"] === "true" &&
    labels["frc-sim.version"] === "v1" &&
    labels["frc-sim.role"] === "sim" &&
    labels["frc-sim.workspace"] === workspaceId
  );
}

function statusFromLease(
  configImage: string,
  lease: ContainerLeaseRow | null,
  state: SimContainerState,
  error: string | null = null,
): SimStatus {
  return {
    role: "sim",
    state,
    image: configImage,
    containerName: lease?.sim_container ?? null,
    portAllocated: lease?.sim_port !== null && lease?.sim_port !== undefined,
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
  private readonly activeEnsures = new Map<WorkspaceId, Promise<SimStatus>>();

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

  async containersStatus(workspace: WorkspaceRow): Promise<ContainersStatusResponse> {
    return {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
      },
      sim: await this.ensureSimContainer(workspace),
    };
  }

  async ensureSimContainer(workspace: WorkspaceRow): Promise<SimStatus> {
    const existing = this.activeEnsures.get(workspace.id);
    if (existing) {
      return existing;
    }

    const pending = this.ensureSimContainerInner(workspace).catch((error) => this.recordSimError(workspace, error));
    this.activeEnsures.set(workspace.id, pending);
    try {
      return await pending;
    } finally {
      this.activeEnsures.delete(workspace.id);
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

  private async listManagedSimContainerNames(workspaceId: WorkspaceId): Promise<string[]> {
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
        "label=frc-sim.role=sim",
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

  private async findManagedSimContainer(workspaceId: WorkspaceId): Promise<{
    name: string;
    container: DockerInspectContainer;
  } | null> {
    const expectedName = simContainerName(workspaceId);
    const expected = await this.inspectContainer(expectedName);
    if (expected) {
      return { name: expectedName, container: expected };
    }

    for (const name of await this.listManagedSimContainerNames(workspaceId)) {
      const container = await this.inspectContainer(name);
      if (container) {
        return { name, container };
      }
    }

    return null;
  }

  private async ensureSimImage(): Promise<void> {
    const result = await this.runDocker(["image", "inspect", this.storage.config.simImage], true);
    if (result.exitCode !== 0) {
      throw new Error(`Sim image ${this.storage.config.simImage} is not available. Build it with bun run docker:build:sim.`);
    }
  }

  private async allocateSimPort(workspaceId: WorkspaceId, preferredPort: number | null): Promise<number> {
    const leasedPorts = new Set(this.storage.listLeasedSimPorts(workspaceId));
    const candidates: number[] = [];
    if (preferredPort !== null) {
      candidates.push(preferredPort);
    }
    for (let port = this.storage.config.simPortRange.start; port <= this.storage.config.simPortRange.end; port += 1) {
      candidates.push(port);
    }

    for (const port of candidates) {
      if (port < this.storage.config.simPortRange.start || port > this.storage.config.simPortRange.end) {
        continue;
      }
      if (leasedPorts.has(port)) {
        continue;
      }
      if (await portIsFree(port)) {
        return port;
      }
    }

    throw new Error(
      `No free sim ports are available in ${this.storage.config.simPortRange.start}-${this.storage.config.simPortRange.end}.`,
    );
  }

  private async adoptContainer(
    workspace: WorkspaceRow,
    name: string,
    container: DockerInspectContainer,
  ): Promise<SimStatus | null> {
    if (!labelsMatch(container, workspace.id)) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const published = publishedSimPort(container);
    if (!published || !published.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    if (container.State?.Running) {
      const lease = this.storage.upsertSimLease({
        workspaceId: workspace.id,
        containerName: name,
        port: published?.port ?? null,
        state: "running",
      });
      return statusFromLease(this.storage.config.simImage, lease, "running");
    }

    const start = await this.runDocker(["start", name], true);
    if (start.exitCode !== 0) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const restarted = await this.inspectContainer(name);
    const restartedPort = restarted ? publishedSimPort(restarted) : null;
    if (!restarted || !labelsMatch(restarted, workspace.id) || !restartedPort || !restartedPort.loopback) {
      await this.runDocker(["rm", "-f", name], true);
      return null;
    }

    const lease = this.storage.upsertSimLease({
      workspaceId: workspace.id,
      containerName: name,
      port: restartedPort?.port ?? published?.port ?? null,
      state: containerRuntimeState(restarted),
    });
    return statusFromLease(this.storage.config.simImage, lease, lease.state);
  }

  private async createSimContainer(workspace: WorkspaceRow, port: number): Promise<SimStatus> {
    await this.ensureSimImage();
    await mkdir(workspaceHomePath(workspace), { recursive: true, mode: 0o700 });

    const name = simContainerName(workspace.id);
    let lease = this.storage.upsertSimLease({
      workspaceId: workspace.id,
      containerName: name,
      port,
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
      "frc-sim.version=v1",
      "--label",
      "frc-sim.role=sim",
      "--label",
      `frc-sim.workspace=${workspace.id}`,
      "--mount",
      `type=bind,src=${workspace.project_path},dst=/workspace/project`,
      "--mount",
      `type=bind,src=${workspaceHomePath(workspace)},dst=/home/frc`,
      "-p",
      `127.0.0.1:${port}:${simContainerPort}`,
      "--memory",
      this.storage.config.simMemoryLimit,
      "-e",
      "HOME=/home/frc",
      "-e",
      "GRADLE_USER_HOME=/home/frc/.gradle",
    ];

    if (this.storage.config.containerUser) {
      args.push("--user", this.storage.config.containerUser);
    }

    args.push(this.storage.config.simImage);
    await this.runDocker(args);

    const created = await this.inspectContainer(name);
    const published = created ? publishedSimPort(created) : null;
    lease = this.storage.upsertSimLease({
      workspaceId: workspace.id,
      containerName: name,
      port: published?.port ?? port,
      state: created ? containerRuntimeState(created) : "starting",
    });

    return statusFromLease(this.storage.config.simImage, lease, lease.state);
  }

  private async ensureSimContainerInner(workspace: WorkspaceRow): Promise<SimStatus> {
    const existing = await this.findManagedSimContainer(workspace.id);
    if (existing) {
      const adopted = await this.adoptContainer(workspace, existing.name, existing.container);
      if (adopted) {
        return adopted;
      }
    }

    const lease = this.storage.getContainerLease(workspace.id);
    const port = await this.allocateSimPort(workspace.id, lease?.sim_port ?? null);
    return await this.createSimContainer(workspace, port);
  }

  private recordSimError(workspace: WorkspaceRow, error: unknown): SimStatus {
    const message = error instanceof Error ? error.message : "Unable to start sim container.";
    const previous = this.storage.getContainerLease(workspace.id);
    const lease = this.storage.upsertSimLease({
      workspaceId: workspace.id,
      containerName: previous?.sim_container ?? simContainerName(workspace.id),
      port: previous?.sim_port ?? null,
      state: "error",
    });
    return statusFromLease(this.storage.config.simImage, lease, "error", message);
  }
}
