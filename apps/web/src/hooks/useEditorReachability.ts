import { useEffect, useState } from "react";

export type EditorStatus = "loading" | "reachable" | "error";

export function useEditorReachability(editorUrl: string | null) {
	const [editorStatus, setEditorStatus] = useState<EditorStatus>("loading");

	useEffect(() => {
		if (!editorUrl) return;

		let cancelled = false;
		const probeEditor = async () => {
			try {
				const response = await fetch(editorUrl, {
					credentials: "same-origin",
					method: "GET",
				});
				if (!cancelled) {
					setEditorStatus(response.status >= 500 ? "error" : "reachable");
				}
			} catch {
				if (!cancelled) setEditorStatus("error");
			}
		};

		void probeEditor();
		const interval = window.setInterval(() => void probeEditor(), 10_000);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	}, [editorUrl]);

	return editorStatus;
}
