import type {
	AllianceStation,
	BridgeConnection,
	DriverStationPatch,
	DsMode,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import { getLogger } from "./logging";
import { type BridgeEntryBase, ReconnectingWsBridge } from "./ws-bridge";

const log = getLogger("halsim");

type HalSimMessage = {
	type: string;
	device: string;
	data: Record<string, unknown>;
};

export type DriverStationState = {
	enabled: boolean;
	mode: DsMode;
	eStopped: boolean;
	alliance: AllianceStation;
};

export type HalSimBridgeSnapshot = {
	connection: BridgeConnection;
	connected: boolean;
	stale: boolean;
	lastMessageAt: string | null;
	error: string | null;
	driverStation: DriverStationState;
};

export type HalSimWebSocketFactory = (url: string) => WebSocket;

type BridgeEntry = HalSimBridgeSnapshot &
	BridgeEntryBase<WorkspaceId> & {
		reconnectTimer: ReturnType<typeof setTimeout> | null;
		reconnectBackoffMs: number;
		shouldReconnect: boolean;
	};

type HalSimBridgeOptions = {
	webSocketFactory?: HalSimWebSocketFactory;
};

export class HalSimBridgeUnavailableError extends Error {
	readonly status = 503;

	constructor(message = "HALSim bridge is not connected.") {
		super(message);
		this.name = "HalSimBridgeUnavailableError";
	}
}

const DRIVER_STATION_TYPE = "DriverStation";
const JOYSTICK_TYPE = "Joystick";
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export type JoystickWireState = {
	axes: number[];
	buttons: boolean[];
	povs: number[];
};

const DEFAULT_DRIVER_STATION: DriverStationState = {
	enabled: false,
	mode: "teleop",
	eStopped: false,
	alliance: "blue1",
};

function upstreamUrlFor(value: string | number): string {
	return typeof value === "number" ? `ws://127.0.0.1:${value}/wpilibws` : value;
}

const STATION_VALUES: Record<AllianceStation, string> = {
	red1: "red1",
	red2: "red2",
	red3: "red3",
	blue1: "blue1",
	blue2: "blue2",
	blue3: "blue3",
};

function parseStation(value: unknown): AllianceStation {
	if (typeof value === "string" && value in STATION_VALUES) {
		return value as AllianceStation;
	}
	// HALSim reports "unknown" until an alliance is set. Fall back to blue to
	// match WPILib's own getAlliance().orElse(Alliance.Blue) convention.
	return "blue1";
}

function parseDsMode(
	autonomous: unknown,
	test: unknown,
	current: DsMode,
): DsMode {
	if (test === true) return "test";
	if (autonomous === true) return "auto";
	if (autonomous === false && test === false) return "teleop";
	return current;
}

function readDsField(
	data: Record<string, unknown>,
	...names: string[]
): unknown {
	for (const name of names) {
		for (const prefix of ["<>", ">", "<", ""]) {
			const key = `${prefix}${name}`;
			if (key in data) {
				return data[key];
			}
		}
	}
	return undefined;
}

function defaultSnapshot(): HalSimBridgeSnapshot {
	return {
		connection: "disconnected",
		connected: false,
		stale: true,
		lastMessageAt: null,
		error: null,
		driverStation: { ...DEFAULT_DRIVER_STATION },
	};
}

export class HalSimBridge extends ReconnectingWsBridge<
	WorkspaceId,
	BridgeEntry
> {
	private readonly webSocketFactory: HalSimWebSocketFactory;

	constructor(options: HalSimBridgeOptions = {}) {
		super();
		this.webSocketFactory =
			options.webSocketFactory ?? ((url) => new WebSocket(url));
	}

	protected createEntry(
		workspaceId: WorkspaceId,
		upstreamUrl: string,
	): BridgeEntry {
		return {
			...defaultSnapshot(),
			workspaceId,
			upstreamUrl,
			socket: null,
			reconnectTimer: null,
			reconnectBackoffMs: DEFAULT_BACKOFF_MS,
			shouldReconnect: true,
		};
	}

	protected createSocket(entry: BridgeEntry): WebSocket {
		return this.webSocketFactory(entry.upstreamUrl);
	}

	getSnapshot(workspaceId: WorkspaceId): HalSimBridgeSnapshot {
		const entry = this.entries.get(workspaceId);
		if (!entry) {
			return defaultSnapshot();
		}
		return this.snapshotFromEntry(entry);
	}

	ensureConnected(
		workspaceId: WorkspaceId,
		target: string | number,
	): HalSimBridgeSnapshot {
		const upstreamUrl = upstreamUrlFor(target);
		const entry = this.ensureEntry(workspaceId, upstreamUrl);

		entry.shouldReconnect = true;
		if (!entry.socket && !entry.reconnectTimer) {
			log.info("halsim attach", { workspaceId, url: upstreamUrl });
			this.open(entry);
		}

		return this.snapshotFromEntry(entry);
	}

	applyDriverStationPatch(
		workspaceId: WorkspaceId,
		target: string | number,
		patch: DriverStationPatch,
	): HalSimBridgeSnapshot {
		const upstreamUrl = upstreamUrlFor(target);
		const snapshot = this.ensureConnected(workspaceId, upstreamUrl);
		const entry = this.entries.get(workspaceId);
		if (
			!entry ||
			entry.connection !== "connected" ||
			!entry.socket ||
			entry.socket.readyState !== WebSocket.OPEN
		) {
			throw new HalSimBridgeUnavailableError(
				snapshot.error ?? "HALSim bridge is not connected.",
			);
		}

		const next = { ...entry.driverStation };
		const modeChanged = patch.mode !== undefined && patch.mode !== next.mode;
		if (modeChanged && next.enabled) {
			this.sendDs(entry, { ">enabled": false, ">new_data": true });
			next.enabled = false;
		}

		if (patch.mode !== undefined) {
			next.mode = patch.mode;
			this.sendDs(entry, {
				">autonomous": patch.mode === "auto",
				">test": patch.mode === "test",
				">new_data": true,
			});
		}

		if (patch.alliance !== undefined) {
			next.alliance = patch.alliance;
			this.sendDs(entry, {
				">station": STATION_VALUES[patch.alliance],
				">new_data": true,
			});
		}

		if (patch.eStopped !== undefined) {
			next.eStopped = patch.eStopped;
			if (patch.eStopped) {
				next.enabled = false;
			}
			this.sendDs(entry, {
				">estop": patch.eStopped,
				...(patch.eStopped ? { ">enabled": false } : {}),
				">new_data": true,
			});
		}

		if (patch.enabled !== undefined) {
			next.enabled = patch.enabled && !next.eStopped;
			this.sendDs(entry, {
				">enabled": next.enabled,
				">autonomous": next.mode === "auto",
				">test": next.mode === "test",
				">new_data": true,
			});
		}

		entry.driverStation = next;
		entry.stale = false;
		entry.error = null;
		return this.snapshotFromEntry(entry);
	}

	applyJoystickState(
		workspaceId: WorkspaceId,
		target: string | number,
		port: number,
		state: JoystickWireState,
	): void {
		const upstreamUrl = upstreamUrlFor(target);
		const snapshot = this.ensureConnected(workspaceId, upstreamUrl);
		const entry = this.entries.get(workspaceId);
		if (
			!entry ||
			entry.connection !== "connected" ||
			!entry.socket ||
			entry.socket.readyState !== WebSocket.OPEN
		) {
			throw new HalSimBridgeUnavailableError(
				snapshot.error ?? "HALSim bridge is not connected.",
			);
		}

		const message: HalSimMessage = {
			type: JOYSTICK_TYPE,
			device: String(port),
			data: {
				">axes": state.axes,
				">buttons": state.buttons,
				">povs": state.povs,
			},
		};
		entry.socket.send(JSON.stringify(message));
		// Flush so robot code observes the new values on its next loop.
		this.sendDs(entry, { ">new_data": true });
	}

	releaseJoystick(
		workspaceId: WorkspaceId,
		target: string | number,
		port: number,
	): void {
		const upstreamUrl = upstreamUrlFor(target);
		// Zero out a joystick. We don't know the controller's axis/button count
		// here, so send a generous zeroed payload (6 axes, 16 buttons, 1 POV)
		// matching the standard WPILib XboxController layout plus headroom.
		this.applyJoystickState(workspaceId, upstreamUrl, port, {
			axes: [0, 0, 0, 0, 0, 0],
			buttons: Array<boolean>(16).fill(false),
			povs: [-1],
		});
		// Safety: disable the robot whenever a joystick is released, matching
		// Conductor's apply_joystick_safety behavior on disconnect.
		try {
			this.applyDriverStationPatch(workspaceId, upstreamUrl, {
				enabled: false,
			});
		} catch {
			// Already disconnected; the next ensureConnected will retry.
		}
	}

	disconnect(workspaceId: WorkspaceId): void {
		const entry = this.entries.get(workspaceId);
		if (!entry) return;
		// Disconnect gets called repeatedly during polling/teardown; only log a
		// real state transition, not no-op cleanup calls.
		if (entry.socket || entry.shouldReconnect) {
			log.info("halsim detach", { workspaceId });
		}
		entry.shouldReconnect = false;
		if (entry.reconnectTimer) {
			clearTimeout(entry.reconnectTimer);
			entry.reconnectTimer = null;
		}
		super.disconnect(workspaceId);
	}

	protected onSocketOpen(entry: BridgeEntry): void {
		// HALSim's reconnect loop can race a disconnect; honor shouldReconnect so a
		// late open from a torn-down attach doesn't re-arm the bridge.
		if (!entry.shouldReconnect) return;
		log.debug("halsim upstream open", {
			workspaceId: entry.workspaceId,
			url: entry.upstreamUrl,
		});
		entry.connection = "connected";
		entry.connected = true;
		entry.stale = false;
		entry.error = null;
		entry.reconnectBackoffMs = DEFAULT_BACKOFF_MS;
		this.sendDs(entry, { ">ds": true, ">fms": false, ">new_data": true });
	}

	protected onSocketMessage(entry: BridgeEntry, data: unknown): void {
		if (!entry.shouldReconnect) return;
		const raw = typeof data === "string" ? data : "";
		this.handleMessage(entry, raw);
	}

	protected onSocketClosed(entry: BridgeEntry, event: CloseEvent): void {
		// 1006 fires when the sim isn't running and the reconnect loop keeps retrying.
		const level = event.code === 1006 ? "trace" : "debug";
		log[level]("halsim upstream close", {
			workspaceId: entry.workspaceId,
			code: event.code,
			reason: event.reason,
			willReconnect: entry.shouldReconnect,
		});
		// The base already set disconnected/error=reason||null; HALSim auto-reconnects,
		// so override the connection state and schedule backoff when still attached.
		entry.connection = entry.shouldReconnect ? "reconnecting" : "disconnected";
		entry.error =
			event.reason ||
			(entry.shouldReconnect ? "HALSim upstream closed." : null);
		if (entry.shouldReconnect) {
			this.scheduleReconnect(entry);
		}
	}

	protected onSocketError(entry: BridgeEntry): void {
		log.trace("halsim upstream error", {
			workspaceId: entry.workspaceId,
			url: entry.upstreamUrl,
		});
		entry.error = "HALSim upstream error.";
	}

	private scheduleReconnect(entry: BridgeEntry): void {
		if (entry.reconnectTimer) return;
		const delay = entry.reconnectBackoffMs;
		entry.reconnectBackoffMs = Math.min(
			entry.reconnectBackoffMs * 2,
			MAX_BACKOFF_MS,
		);
		log.trace("halsim scheduling reconnect", {
			workspaceId: entry.workspaceId,
			delayMs: delay,
		});
		entry.reconnectTimer = setTimeout(() => {
			entry.reconnectTimer = null;
			if (entry.shouldReconnect && !entry.socket) {
				this.open(entry);
			}
		}, delay);
		entry.reconnectTimer.unref?.();
	}

	private handleMessage(entry: BridgeEntry, raw: string): void {
		let parsed: HalSimMessage;
		try {
			parsed = JSON.parse(raw) as HalSimMessage;
		} catch {
			return;
		}
		if (
			parsed.type !== DRIVER_STATION_TYPE ||
			parsed.device !== "" ||
			typeof parsed.data !== "object"
		) {
			return;
		}

		const data = parsed.data;
		const next = { ...entry.driverStation };
		const enabledValue = readDsField(data, "enabled");
		if (typeof enabledValue === "boolean") {
			next.enabled = enabledValue;
		}
		const auto = readDsField(data, "autonomous");
		const test = readDsField(data, "test");
		if (typeof auto === "boolean" || typeof test === "boolean") {
			next.mode = parseDsMode(auto, test, next.mode);
		}
		const eStopValue = readDsField(data, "estop", "eStop");
		if (typeof eStopValue === "boolean") {
			next.eStopped = eStopValue;
			if (eStopValue) {
				next.enabled = false;
			}
		}
		const stationValue = readDsField(data, "station", "allianceStationId");
		if (stationValue !== undefined) {
			next.alliance = parseStation(stationValue);
		}

		entry.driverStation = next;
		entry.lastMessageAt = new Date().toISOString();
		entry.stale = false;
		entry.error = null;
	}

	private sendDs(entry: BridgeEntry, fields: Record<string, unknown>): void {
		if (!entry.socket || entry.socket.readyState !== WebSocket.OPEN) {
			throw new HalSimBridgeUnavailableError();
		}
		const message: HalSimMessage = {
			type: DRIVER_STATION_TYPE,
			device: "",
			data: fields,
		};
		entry.socket.send(JSON.stringify(message));
	}

	private snapshotFromEntry(entry: BridgeEntry): HalSimBridgeSnapshot {
		return {
			connection: entry.connection,
			connected: entry.connected,
			stale: entry.stale,
			lastMessageAt: entry.lastMessageAt,
			error: entry.error,
			driverStation: { ...entry.driverStation },
		};
	}
}
