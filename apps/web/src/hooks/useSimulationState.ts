import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type DriverStationPatch,
	type SimRunMode,
	type SimRunStatus,
	type SimStatusResponse,
	simStatusResponseSchema,
} from "@/lib/contracts";

type SimRunAction = "start" | "stop" | "restart";

interface UseSimulationStateReturn {
	status: SimStatusResponse | null;
	runStatus: SimRunStatus;
	refresh: () => Promise<void>;
	startRun: (mode?: SimRunMode) => Promise<void>;
	stopRun: () => Promise<void>;
	restartRun: () => Promise<void>;
	setDriverStation: (patch: DriverStationPatch) => Promise<void>;
}

async function readError(
	response: Response,
	fallback: string,
): Promise<string> {
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	return body.error ?? fallback;
}

/**
 * `pushedStatus` comes from the run socket (useRunChannel), which the server
 * updates on change. Commands still refresh over HTTP so their result shows
 * without waiting for the next push.
 */
export function useSimulationState(
	workspaceSlug: string | null,
	pushedStatus: SimStatusResponse | null,
): UseSimulationStateReturn {
	const [status, setStatus] = useState<SimStatusResponse | null>(null);

	const refresh = useCallback(async () => {
		if (!workspaceSlug) {
			setStatus(null);
			return;
		}
		try {
			const response = await fetch(`/u/${workspaceSlug}/api/sim/status`, {
				credentials: "same-origin",
			});
			if (!response.ok) {
				throw new Error(
					await readError(response, "Unable to read simulation status."),
				);
			}
			setStatus(simStatusResponseSchema.parse(await response.json()));
		} catch {
			setStatus(null);
		}
	}, [workspaceSlug]);

	useEffect(() => {
		setStatus(workspaceSlug ? pushedStatus : null);
	}, [pushedStatus, workspaceSlug]);

	const runCommand = useCallback(
		async (action: SimRunAction, mode?: SimRunMode) => {
			if (!workspaceSlug) return;
			const response = await fetch(`/u/${workspaceSlug}/api/sim/run`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(mode ? { action, mode } : { action }),
			});
			if (!response.ok) {
				toast.error(await readError(response, "Unable to update robot code."));
				return;
			}
			await refresh();
		},
		[refresh, workspaceSlug],
	);

	const setDriverStation = useCallback(
		async (patch: DriverStationPatch) => {
			if (!workspaceSlug) return;
			const response = await fetch(
				`/u/${workspaceSlug}/api/sim/driver-station`,
				{
					method: "PATCH",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(patch),
				},
			);
			if (!response.ok) {
				toast.error(
					await readError(response, "Unable to update Driver Station state."),
				);
				return;
			}
			setStatus(simStatusResponseSchema.parse(await response.json()));
		},
		[workspaceSlug],
	);

	return {
		status,
		runStatus: status?.run.status ?? "idle",
		refresh,
		startRun: (mode?: SimRunMode) => runCommand("start", mode),
		stopRun: () => runCommand("stop"),
		restartRun: () => runCommand("restart"),
		setDriverStation,
	};
}
