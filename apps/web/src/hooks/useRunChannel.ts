import { useCallback, useEffect, useRef, useState } from "react";
import {
	type AutoChoosersResponse,
	runServerMessageSchema,
	type SimStatusResponse,
} from "@/lib/contracts";

export type RunStatus =
	| "connecting"
	| "idle"
	| "building"
	| "running"
	| "stopping"
	| "failed"
	| "stopped"
	| "error";

export type RunConnection = "connected" | "reconnecting" | "disconnected";

interface UseRunChannelReturn {
	runStatus: RunStatus;
	connection: RunConnection;
	consoleLines: string[];
	/** Pushed by the server on connect and on change; null while disconnected. */
	simStatus: SimStatusResponse | null;
	autoChoosers: AutoChoosersResponse | null;
	startRun: () => void;
	stopRun: () => void;
}

const MAX_CONSOLE_LINES = 500;

export function useRunChannel(
	workspaceSlug: string | null,
): UseRunChannelReturn {
	const [runStatus, setRunStatus] = useState<RunStatus>("connecting");
	const [connection, setConnection] = useState<RunConnection>("disconnected");
	const [consoleLines, setConsoleLines] = useState<string[]>(["Connecting..."]);
	const [simStatus, setSimStatus] = useState<SimStatusResponse | null>(null);
	const [autoChoosers, setAutoChoosers] = useState<AutoChoosersResponse | null>(
		null,
	);
	const socketRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const backoffRef = useRef(500);

	const logLine = useCallback((line: string) => {
		setConsoleLines((current) =>
			[...current.filter((entry) => entry !== "Connecting..."), line].slice(
				-MAX_CONSOLE_LINES,
			),
		);
	}, []);

	const clearConsole = useCallback((line: string) => {
		setConsoleLines([line]);
	}, []);

	useEffect(() => {
		let disposed = false;
		if (!workspaceSlug) {
			return;
		}

		const connect = () => {
			if (disposed) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(
				`${protocol}//${window.location.host}/u/${workspaceSlug}/ws/run`,
			);
			socketRef.current = socket;
			setRunStatus("connecting");

			socket.addEventListener("open", () => {
				if (disposed || socketRef.current !== socket) return;
				backoffRef.current = 500;
				setConnection("connected");
				setRunStatus("idle");
				logLine("Run channel connected.");
			});

			socket.addEventListener("message", (event) => {
				if (disposed || socketRef.current !== socket) return;
				try {
					const message = runServerMessageSchema.parse(
						JSON.parse(String(event.data)),
					);
					if (message.type === "hello") return;
					if (message.type === "sim-status") {
						setSimStatus(message.status);
						return;
					}
					if (message.type === "auto-choosers") {
						setAutoChoosers(message.status);
						return;
					}
					if (message.type === "status") {
						setRunStatus(message.status);
						return;
					}
					if (message.type === "log") {
						logLine(`[${message.stream}] ${message.line}`);
						return;
					}
					if (message.type === "exit") {
						logLine(
							`Run exited with code ${message.code ?? "none"}${message.signal ? ` (${message.signal})` : ""}.`,
						);
						return;
					}
					setRunStatus("error");
					logLine(message.message);
				} catch {
					logLine("Ignored an invalid run message from the server.");
				}
			});

			socket.addEventListener("close", () => {
				if (disposed || socketRef.current !== socket) return;
				socketRef.current = null;
				setConnection("reconnecting");
				setSimStatus(null);
				setAutoChoosers(null);
				logLine("Run channel disconnected. Reconnecting...");

				const delay = backoffRef.current;
				backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
				reconnectTimerRef.current = setTimeout(() => {
					reconnectTimerRef.current = null;
					connect();
				}, delay);
			});

			socket.addEventListener("error", () => {
				// The close event handles reconnect scheduling.
			});
		};

		connect();
		return () => {
			disposed = true;
			setSimStatus(null);
			setAutoChoosers(null);
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = null;
			}
			const socket = socketRef.current;
			if (socket) {
				socketRef.current = null;
				socket.close();
			}
		};
	}, [workspaceSlug, logLine]);

	// Keep the WS alive through Cloudflare's 100-second idle timeout.
	useEffect(() => {
		if (connection !== "connected" || runStatus !== "idle") return;
		const interval = setInterval(() => {
			const socket = socketRef.current;
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "ping" }));
			}
		}, 30_000);
		return () => clearInterval(interval);
	}, [connection, runStatus]);

	const startRun = useCallback(() => {
		clearConsole("Starting run...");
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "start" }));
		}
	}, [clearConsole]);

	const stopRun = useCallback(() => {
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "stop" }));
			setRunStatus("stopping");
		}
	}, []);

	return {
		runStatus,
		connection,
		consoleLines,
		simStatus,
		autoChoosers,
		startRun,
		stopRun,
	};
}
