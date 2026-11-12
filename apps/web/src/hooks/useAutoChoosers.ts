import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type AutoChooserPatch,
	type AutoChoosersResponse,
	autoChoosersResponseSchema,
} from "@/lib/contracts";

interface UseAutoChoosersReturn {
	status: AutoChoosersResponse | null;
	refresh: () => Promise<void>;
	selectAuto: (patch: AutoChooserPatch) => Promise<void>;
}

async function readError(
	response: Response,
	fallback: string,
): Promise<string> {
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	return body.error ?? fallback;
}

/** `pushedStatus` comes from the run socket (useRunChannel). */
export function useAutoChoosers(
	workspaceSlug: string | null,
	pushedStatus: AutoChoosersResponse | null,
): UseAutoChoosersReturn {
	const [status, setStatus] = useState<AutoChoosersResponse | null>(null);

	const refresh = useCallback(async () => {
		if (!workspaceSlug) {
			setStatus(null);
			return;
		}
		try {
			const response = await fetch(
				`/u/${workspaceSlug}/api/sim/auto-choosers`,
				{
					credentials: "same-origin",
				},
			);
			if (!response.ok) {
				throw new Error(
					await readError(response, "Unable to read auto choosers."),
				);
			}
			setStatus(autoChoosersResponseSchema.parse(await response.json()));
		} catch {
			setStatus(null);
		}
	}, [workspaceSlug]);

	useEffect(() => {
		setStatus(workspaceSlug ? pushedStatus : null);
	}, [pushedStatus, workspaceSlug]);

	const selectAuto = useCallback(
		async (patch: AutoChooserPatch) => {
			if (!workspaceSlug) return;
			const response = await fetch(`/u/${workspaceSlug}/api/sim/auto-chooser`, {
				method: "PATCH",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (!response.ok) {
				toast.error(
					await readError(response, "Unable to select autonomous routine."),
				);
				return;
			}
			setStatus(autoChoosersResponseSchema.parse(await response.json()));
		},
		[workspaceSlug],
	);

	return { status, refresh, selectAuto };
}
