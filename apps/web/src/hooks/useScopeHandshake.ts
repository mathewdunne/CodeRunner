import { useEffect, useRef, useState } from "react";

export type ScopeStatus = "loading" | "configured" | "connected" | "timeout";

export function useScopeHandshake(
	workspaceSlug: string | null,
	frameRef: React.RefObject<HTMLIFrameElement | null>,
) {
	const [scopeStatus, setScopeStatus] = useState<ScopeStatus>("loading");
	const acknowledgedRef = useRef(false);

	useEffect(() => {
		if (!workspaceSlug) return;

		acknowledgedRef.current = false;
		const frame = frameRef.current;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const endpoint = {
			aliveUrl: `/u/${workspaceSlug}/sim/alive`,
			websocketUrl: `${protocol}//${window.location.host}/u/${workspaceSlug}/sim/nt4`,
		};

		const sendConfig = () => {
			setScopeStatus("configured");
			frame?.contentWindow?.postMessage(
				{
					type: "frc-sim:set-nt4-endpoint",
					endpoint,
				},
				window.location.origin,
			);
		};

		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) return;
			if (
				(event.data as { type?: unknown } | null)?.type !==
				"frc-sim:nt4-endpoint-ready"
			)
				return;
			acknowledgedRef.current = true;
			setScopeStatus("connected");
		};

		window.addEventListener("message", onMessage);
		frame?.addEventListener("load", sendConfig);
		if (frame?.contentWindow) {
			sendConfig();
		}

		const timeout = window.setTimeout(() => {
			if (!acknowledgedRef.current) {
				setScopeStatus("timeout");
			}
		}, 10_000);

		return () => {
			window.removeEventListener("message", onMessage);
			frame?.removeEventListener("load", sendConfig);
			window.clearTimeout(timeout);
		};
	}, [workspaceSlug, frameRef]);

	return scopeStatus;
}
