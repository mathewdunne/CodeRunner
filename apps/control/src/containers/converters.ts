import type { ContainerState } from "@frc-sim/contracts";
import type { WorkspaceRuntime } from "../runtime";
import type { ContainerLeaseRow, WorkspaceRow } from "../storage";
import type { CodeContainerStatus, ManagedContainerStats } from "./types";

export function statusFromLease(
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
    simPortAllocated: (lease?.nt4_port ?? null) !== null,
    vscodePortAllocated: (lease?.vscode_port ?? null) !== null,
    halsimPortAllocated: (lease?.halsim_port ?? null) !== null,
    lastUsedAt: lease?.last_used_at ?? null,
    error,
  };
}

export function runtimeFromLease(
  image: string,
  workspace: WorkspaceRow,
  lease: ContainerLeaseRow | null,
  state: ContainerState,
  error: string | null = null,
): WorkspaceRuntime {
  const vscodePort = lease?.vscode_port ?? null;
  const nt4Port = lease?.nt4_port ?? null;
  const halsimPort = lease?.halsim_port ?? null;
  const basePath = `/u/${workspace.slug}/vscode/`;
  return {
    workspaceId: workspace.id,
    state,
    image,
    runtimeName: lease?.vscode_container ?? null,
    ports: {
      nt4: nt4Port,
      vscode: vscodePort,
      halsim: halsimPort,
    },
    endpoints: {
      vscode:
        vscodePort === null
          ? null
          : {
              httpBaseUrl: `http://127.0.0.1:${vscodePort}`,
              wsBaseUrl: `ws://127.0.0.1:${vscodePort}`,
              basePath,
            },
      nt4:
        nt4Port === null
          ? null
          : {
              httpUrl: `http://127.0.0.1:${nt4Port}/`,
              wsUrl: `ws://127.0.0.1:${nt4Port}/nt/AdvantageScopeLite`,
            },
      halsim:
        halsimPort === null
          ? null
          : {
              wsUrl: `ws://127.0.0.1:${halsimPort}/wpilibws`,
            },
    },
    lastUsedAt: lease?.last_used_at ?? null,
    error,
  };
}

export function parsePercent(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDockerStatsLine(line: string): Partial<ManagedContainerStats> | null {
  try {
    const parsed = JSON.parse(line) as {
      Container?: string;
      ID?: string;
      Name?: string;
      CPUPerc?: string;
      MemUsage?: string;
      MemPerc?: string;
    };
    const [memoryUsage = null, memoryLimit = null] = (parsed.MemUsage ?? "")
      .split("/")
      .map((part) => part.trim());
    return {
      id: parsed.Container ?? parsed.ID ?? null,
      name: parsed.Name ?? "",
      cpuPercent: parsePercent(parsed.CPUPerc),
      memoryUsage,
      memoryLimit,
      memoryPercent: parsePercent(parsed.MemPerc),
    };
  } catch {
    return null;
  }
}
