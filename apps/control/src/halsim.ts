import type {
  AllianceStation,
  BridgeConnection,
  DriverStationPatch,
  DsMode,
  WorkspaceId,
} from "@frc-sim/contracts";

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

type BridgeEntry = HalSimBridgeSnapshot & {
  workspaceId: WorkspaceId;
  upstreamUrl: string;
  socket: WebSocket | null;
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
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

const DEFAULT_DRIVER_STATION: DriverStationState = {
  enabled: false,
  mode: "teleop",
  eStopped: false,
  alliance: "red1",
};

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
  return "red1";
}

function parseDsMode(autonomous: unknown, test: unknown, current: DsMode): DsMode {
  if (test === true) return "test";
  if (autonomous === true) return "auto";
  if (autonomous === false && test === false) return "teleop";
  return current;
}

function readDsField(data: Record<string, unknown>, ...names: string[]): unknown {
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

function upstreamUrlFor(halsimPort: number): string {
  return `ws://127.0.0.1:${halsimPort}/wpilibws`;
}

export class HalSimBridge {
  private readonly webSocketFactory: HalSimWebSocketFactory;
  private readonly entries = new Map<WorkspaceId, BridgeEntry>();

  constructor(options: HalSimBridgeOptions = {}) {
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  getSnapshot(workspaceId: WorkspaceId): HalSimBridgeSnapshot {
    const entry = this.entries.get(workspaceId);
    if (!entry) {
      return defaultSnapshot();
    }
    return this.snapshotFromEntry(entry);
  }

  ensureConnected(workspaceId: WorkspaceId, halsimPort: number): HalSimBridgeSnapshot {
    const upstreamUrl = upstreamUrlFor(halsimPort);
    let entry = this.entries.get(workspaceId);
    if (entry && entry.upstreamUrl !== upstreamUrl) {
      this.disconnect(workspaceId);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        ...defaultSnapshot(),
        workspaceId,
        upstreamUrl,
        socket: null,
        reconnectTimer: null,
        reconnectBackoffMs: DEFAULT_BACKOFF_MS,
        shouldReconnect: true,
      };
      this.entries.set(workspaceId, entry);
    }

    entry.shouldReconnect = true;
    if (!entry.socket && !entry.reconnectTimer) {
      this.open(entry);
    }

    return this.snapshotFromEntry(entry);
  }

  applyDriverStationPatch(workspaceId: WorkspaceId, halsimPort: number, patch: DriverStationPatch): HalSimBridgeSnapshot {
    const snapshot = this.ensureConnected(workspaceId, halsimPort);
    const entry = this.entries.get(workspaceId);
    if (!entry || entry.connection !== "connected" || !entry.socket || entry.socket.readyState !== WebSocket.OPEN) {
      throw new HalSimBridgeUnavailableError(snapshot.error ?? "HALSim bridge is not connected.");
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
      this.sendDs(entry, { ">station": STATION_VALUES[patch.alliance], ">new_data": true });
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

  disconnect(workspaceId: WorkspaceId): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    entry.shouldReconnect = false;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    const socket = entry.socket;
    entry.socket = null;
    entry.connection = "disconnected";
    entry.connected = false;
    entry.stale = true;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
  }

  close(): void {
    for (const workspaceId of this.entries.keys()) {
      this.disconnect(workspaceId);
    }
    this.entries.clear();
  }

  private open(entry: BridgeEntry): void {
    entry.connection = "reconnecting";
    entry.connected = false;
    entry.stale = entry.lastMessageAt !== null;
    entry.error = null;

    const socket = this.webSocketFactory(entry.upstreamUrl);
    entry.socket = socket;

    socket.addEventListener("open", () => {
      if (entry.socket !== socket || !entry.shouldReconnect) return;
      entry.connection = "connected";
      entry.connected = true;
      entry.stale = false;
      entry.error = null;
      entry.reconnectBackoffMs = DEFAULT_BACKOFF_MS;
      this.sendDs(entry, { ">ds": true, ">fms": false, ">new_data": true });
    });

    socket.addEventListener("message", (event) => {
      if (entry.socket !== socket || !entry.shouldReconnect) return;
      const raw = typeof event.data === "string" ? event.data : "";
      this.handleMessage(entry, raw);
    });

    socket.addEventListener("close", (event) => {
      if (entry.socket !== socket) return;
      entry.socket = null;
      entry.connection = entry.shouldReconnect ? "reconnecting" : "disconnected";
      entry.connected = false;
      entry.stale = true;
      entry.error = event.reason || (entry.shouldReconnect ? "HALSim upstream closed." : null);
      if (entry.shouldReconnect) {
        this.scheduleReconnect(entry);
      }
    });

    socket.addEventListener("error", () => {
      if (entry.socket !== socket) return;
      entry.error = "HALSim upstream error.";
    });
  }

  private scheduleReconnect(entry: BridgeEntry): void {
    if (entry.reconnectTimer) return;
    const delay = entry.reconnectBackoffMs;
    entry.reconnectBackoffMs = Math.min(entry.reconnectBackoffMs * 2, MAX_BACKOFF_MS);
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
    if (parsed.type !== DRIVER_STATION_TYPE || parsed.device !== "" || typeof parsed.data !== "object") {
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
