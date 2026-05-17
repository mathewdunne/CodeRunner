import type { ContainerState, WorkspaceId } from "@frc-coderunner/contracts";

export type ExecResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type ExecOptions = {
	timeoutMs?: number | undefined;
};

export type WorkspaceRuntimeExit = {
	code: number | null;
	signal: string | null;
};

export type WorkspaceRuntimeCommand = {
	stdout: ReadableStream<Uint8Array> | null;
	stderr: ReadableStream<Uint8Array> | null;
	exited: Promise<WorkspaceRuntimeExit>;
	kill(signal?: string): void;
};

export type WorkspaceRuntime = {
	workspaceId: WorkspaceId;
	state: ContainerState;
	image: string;
	runtimeName: string | null;
	ports: {
		nt4: number | null;
		vscode: number | null;
		halsim: number | null;
	};
	endpoints: {
		vscode: {
			httpBaseUrl: string;
			wsBaseUrl: string;
			basePath: string;
		} | null;
		nt4: {
			httpUrl: string;
			wsUrl: string;
		} | null;
		halsim: {
			wsUrl: string;
		} | null;
	};
	lastUsedAt: string | null;
	error: string | null;
};

export type ManagedWorkspaceRuntime = {
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

export interface WorkspaceRuntimeProvider {
	ensureWorkspaceRunning(workspaceId: WorkspaceId): Promise<WorkspaceRuntime>;
	stopWorkspace(workspaceId: WorkspaceId): Promise<void>;
	restartWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceRuntime>;
	removeWorkspace(workspaceId: WorkspaceId): Promise<void>;
	getWorkspaceStatus(workspaceId: WorkspaceId): Promise<WorkspaceRuntime>;
	exec(
		workspaceId: WorkspaceId,
		command: string[],
		options?: ExecOptions,
	): Promise<ExecResult>;
	execStream(
		workspaceId: WorkspaceId,
		command: string[],
		options?: ExecOptions,
	): WorkspaceRuntimeCommand;
	listRuntimes(): Promise<ManagedWorkspaceRuntime[]>;
	cleanupStoppedRuntimes(): Promise<string[]>;
	countRunningWorkspaces(): Promise<number>;
}
