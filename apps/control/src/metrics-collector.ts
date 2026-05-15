import type { LocalDockerRuntimeProvider } from "./containers";
import { getLogger } from "./logging";
import {
  activeWorkspaces,
  containerCpuPercent,
  containerMemoryPercent,
} from "./metrics";

const log = getLogger("metrics");

export type DockerStatsPollerOptions = {
  containers: LocalDockerRuntimeProvider;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 15_000;

export class DockerStatsPoller {
  private readonly containers: LocalDockerRuntimeProvider;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DockerStatsPollerOptions) {
    this.containers = options.containers;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    try {
      const stats = await this.containers.managedContainerStats();
      containerCpuPercent.reset();
      containerMemoryPercent.reset();
      let running = 0;
      for (const stat of stats) {
        const workspaceId = stat.workspaceId ?? stat.name;
        if (stat.state === "running") {
          running += 1;
        }
        if (typeof stat.cpuPercent === "number") {
          containerCpuPercent.set({ workspace_id: workspaceId }, stat.cpuPercent);
        }
        if (typeof stat.memoryPercent === "number") {
          containerMemoryPercent.set({ workspace_id: workspaceId }, stat.memoryPercent);
        }
      }
      activeWorkspaces.set(running);
    } catch (err) {
      log.warn("docker stats poll failed", {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
