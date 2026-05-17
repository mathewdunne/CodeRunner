import type { ContainersStatusResponse } from "@frc-coderunner/contracts";
import type { ExecResult } from "../runtime";

export type DockerCommandResult = ExecResult;

export type DockerRunner = (args: string[]) => Promise<DockerCommandResult>;

export type ContainerOrchestratorOptions = {
	dockerRunner?: DockerRunner | undefined;
	portAvailable?: ((port: number) => Promise<boolean>) | undefined;
};

export type CodeContainerStatus = ContainersStatusResponse["code"];

export type ManagedContainerStats = {
	name: string;
	id: string | null;
	workspaceId: string | null;
	role: string | null;
	state: string | null;
	cpuPercent: number | null;
	memoryUsage: string | null;
	memoryLimit: string | null;
	memoryPercent: number | null;
};

export type LocalDockerRuntimeProviderOptions = ContainerOrchestratorOptions;

export type DockerInspectContainer = {
	Name?: string;
	State?: {
		Running?: boolean;
		Status?: string;
	};
	Config?: {
		Labels?: Record<string, string>;
	};
	NetworkSettings?: {
		Ports?: Record<
			string,
			Array<{ HostIp?: string; HostPort?: string }> | null
		>;
	};
};

export type PublishedPort = {
	port: number;
	hostIp: string;
	loopback: boolean;
};

export const SIM_CONTAINER_PORT = 5810;
export const HALSIM_CONTAINER_PORT = 3300;
export const VSCODE_CONTAINER_PORT = 3000;
export const CODE_NAME_PREFIX = "coderunner-workspace-";
