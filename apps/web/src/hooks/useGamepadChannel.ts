import { useCallback, useEffect, useRef, useState } from "react";
import { type GamepadState, gamepadServerMessageSchema } from "@/lib/contracts";

export type GamepadChannelConnection =
	| "connected"
	| "reconnecting"
	| "disconnected";

interface UseGamepadChannelReturn {
	connection: GamepadChannelConnection;
	error: string | null;
	halsimDisconnected: boolean;
	select: (id: string, label: string) => void;
	release: () => void;
	pushState: (state: GamepadState) => void;
}

// ~50 Hz send rate when state is changing, with a heartbeat every 250 ms so
// HALSim sees the joystick alive even when the student isn't moving sticks.
const SEND_INTERVAL_MS = 20;
const HEARTBEAT_MS = 250;

function statesEqual(a: GamepadState, b: GamepadState): boolean {
	if (a.axes.length !== b.axes.length) return false;
	if (a.buttons.length !== b.buttons.length) return false;
	if (a.povs.length !== b.povs.length) return false;
	for (let i = 0; i < a.axes.length; i++)
		if (a.axes[i] !== b.axes[i]) return false;
	for (let i = 0; i < a.buttons.length; i++)
		if (a.buttons[i] !== b.buttons[i]) return false;
	for (let i = 0; i < a.povs.length; i++)
		if (a.povs[i] !== b.povs[i]) return false;
	return true;
}

export function useGamepadChannel(
	workspaceSlug: string | null,
): UseGamepadChannelReturn {
	const [connection, setConnection] =
		useState<GamepadChannelConnection>("disconnected");
	const [error, setError] = useState<string | null>(null);
	const [halsimDisconnected, setHalsimDisconnected] = useState(false);

	const socketRef = useRef<WebSocket | null>(null);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const backoffRef = useRef(500);
	const mountedRef = useRef(true);

	const seqRef = useRef(0);
	const lastSentAtRef = useRef(0);
	const lastSentStateRef = useRef<GamepadState | null>(null);
	const selectionRef = useRef<{ id: string; label: string } | null>(null);

	useEffect(() => {
		mountedRef.current = true;
		if (!workspaceSlug) return;

		const connect = () => {
			if (!mountedRef.current) return;
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(
				`${protocol}//${window.location.host}/u/${workspaceSlug}/ws/gamepad`,
			);
			socketRef.current = socket;

			socket.addEventListener("open", () => {
				if (!mountedRef.current) return;
				backoffRef.current = 500;
				setConnection("connected");
				setError(null);
				setHalsimDisconnected(false);
				const selection = selectionRef.current;
				if (selection) {
					// Resend after reconnect so the server-side session picks up where
					// we left off.
					socket.send(
						JSON.stringify({
							type: "select",
							id: selection.id,
							label: selection.label,
						}),
					);
					seqRef.current = 0;
					lastSentStateRef.current = null;
					lastSentAtRef.current = 0;
				}
			});

			socket.addEventListener("message", (event) => {
				if (!mountedRef.current) return;
				try {
					const msg = gamepadServerMessageSchema.parse(
						JSON.parse(String(event.data)),
					);
					if (msg.type === "hello") return;
					if (msg.type === "halsim-disconnected") {
						setHalsimDisconnected(true);
						return;
					}
					setError(msg.message);
				} catch {
					// Ignore malformed server messages.
				}
			});

			socket.addEventListener("close", () => {
				if (!mountedRef.current) return;
				if (socketRef.current === socket) socketRef.current = null;
				setConnection("reconnecting");
				const delay = backoffRef.current;
				backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
				reconnectTimerRef.current = setTimeout(connect, delay);
			});

			socket.addEventListener("error", () => {
				// close handler schedules reconnect.
			});
		};

		connect();
		return () => {
			mountedRef.current = false;
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
	}, [workspaceSlug]);

	const select = useCallback((id: string, label: string) => {
		selectionRef.current = { id, label };
		seqRef.current = 0;
		lastSentStateRef.current = null;
		lastSentAtRef.current = 0;
		setHalsimDisconnected(false);
		setError(null);
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "select", id, label }));
		}
	}, []);

	const release = useCallback(() => {
		selectionRef.current = null;
		lastSentStateRef.current = null;
		lastSentAtRef.current = 0;
		const socket = socketRef.current;
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "release" }));
		}
	}, []);

	const pushState = useCallback((state: GamepadState) => {
		if (!selectionRef.current) return;
		const socket = socketRef.current;
		if (socket?.readyState !== WebSocket.OPEN) return;

		const now = performance.now();
		const last = lastSentStateRef.current;
		const sameAsLast = last !== null && statesEqual(last, state);
		const elapsed = now - lastSentAtRef.current;
		if (sameAsLast) {
			if (elapsed < HEARTBEAT_MS) return;
		} else if (elapsed < SEND_INTERVAL_MS) {
			return;
		}
		lastSentAtRef.current = now;
		lastSentStateRef.current = state;
		const seq = seqRef.current++;
		socket.send(JSON.stringify({ type: "state", seq, state }));
	}, []);

	return { connection, error, halsimDisconnected, select, release, pushState };
}
