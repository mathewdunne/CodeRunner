import { getLogger } from "./logging";
import type { WorkspaceRuntimeProvider } from "./runtime";
import type { AppStorage } from "./storage";

const log = getLogger("idle");

export type IdleManagerOptions = {
	storage: AppStorage;
	runtimeProvider: WorkspaceRuntimeProvider;
	onStop?: (workspaceId: string) => void;
};

export class IdleManager {
	private timer: ReturnType<typeof setInterval> | null = null;
	private initialTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly storage: AppStorage;
	private readonly runtimeProvider: WorkspaceRuntimeProvider;
	private readonly onStop: (workspaceId: string) => void;

	constructor(options: IdleManagerOptions) {
		this.storage = options.storage;
		this.runtimeProvider = options.runtimeProvider;
		this.onStop = options.onStop ?? (() => {});
	}

	start(): void {
		if (this.timer) {
			return;
		}
		const intervalMs = this.storage.config.idleCheckIntervalMs;
		this.timer = setInterval(() => void this.sweep(), intervalMs);
		// Run an initial sweep shortly after startup so containers orphaned by a
		// restart are caught quickly rather than waiting a full interval.
		this.initialTimer = setTimeout(() => void this.sweep(), 5_000);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.initialTimer) {
			clearTimeout(this.initialTimer);
			this.initialTimer = null;
		}
	}

	async sweep(): Promise<string[]> {
		const idleMinutes = this.storage.config.idleStopMinutes;
		const idleIds = this.storage.listIdleWorkspaceIds(idleMinutes);
		const stopped: string[] = [];

		if (idleIds.length === 0) {
			log.trace("idle sweep: no candidates", { idleMinutes });
		} else {
			log.debug("idle sweep tick", { candidates: idleIds.length, idleMinutes });
		}

		for (const workspaceId of idleIds) {
			try {
				await this.runtimeProvider.stopWorkspace(workspaceId);
				stopped.push(workspaceId);
				this.onStop(workspaceId);
			} catch (error) {
				log.error("failed to stop idle containers", {
					workspaceId,
					err: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}

		return stopped;
	}
}
