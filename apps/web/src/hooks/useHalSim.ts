import { useCallback, useEffect, useRef, useState } from "react";

export type DsMode = "auto" | "teleop" | "test";
export type AllianceStation = "red1" | "red2" | "red3" | "blue1" | "blue2" | "blue3";
export type HalSimConnection = "connected" | "reconnecting" | "disconnected";

export interface HalSimState {
  connected: boolean;
  connection: HalSimConnection;
  enabled: boolean;
  mode: DsMode;
  eStopped: boolean;
  alliance: AllianceStation;
}

export interface HalSimActions {
  setEnabled(value: boolean): void;
  setMode(mode: DsMode): void;
  setEStop(value: boolean): void;
  setAlliance(station: AllianceStation): void;
}

export type UseHalSimReturn = HalSimState & HalSimActions;

// HALSim WS envelope: { type, device, data }
type HalSimMessage = {
  type: string;
  device: string;
  data: Record<string, unknown>;
};

const DRIVER_STATION_TYPE = "DriverStation";

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

function parseDsMode(autonomous: unknown, test: unknown): DsMode {
  if (test === true) return "test";
  if (autonomous === true) return "auto";
  return "teleop";
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

/**
 * React hook that connects to the HALSim WebSocket proxy at
 * `/u/<slug>/sim/halsim` and exposes Driver Station control state.
 *
 * Reconnects with exponential backoff (500ms → 10s) matching useRunChannel.
 * Sends `>ds` = true while connected so the sim knows a DS is attached.
 * On reconnect, re-reads authoritative state from the sim's initial burst.
 */
export function useHalSim(workspaceSlug: string | null): UseHalSimReturn {
  const [connection, setConnection] = useState<HalSimConnection>("disconnected");
  const [enabled, setEnabledState] = useState(false);
  const [mode, setModeState] = useState<DsMode>("teleop");
  const [eStopped, setEStoppedState] = useState(false);
  const [alliance, setAllianceState] = useState<AllianceStation>("red1");

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(500);
  const mountedRef = useRef(true);

  const sendDs = useCallback((fields: Record<string, unknown>) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const message: HalSimMessage = {
        type: DRIVER_STATION_TYPE,
        device: "",
        data: fields,
      };
      ws.send(JSON.stringify(message));
    }
  }, []);

  const setEnabled = useCallback(
    (value: boolean) => {
      setEnabledState(value);
      sendDs({ ">enabled": value, ">new_data": true });
    },
    [sendDs],
  );

  const setMode = useCallback(
    (newMode: DsMode) => {
      setModeState(newMode);
      sendDs({
        ">autonomous": newMode === "auto",
        ">test": newMode === "test",
        ">new_data": true,
      });
    },
    [sendDs],
  );

  const setEStop = useCallback(
    (value: boolean) => {
      setEStoppedState(value);
      if (value) {
        setEnabledState(false);
      }
      sendDs({
        ">estop": value,
        ...(value ? { ">enabled": false } : {}),
        ">new_data": true,
      });
    },
    [sendDs],
  );

  const setAlliance = useCallback(
    (station: AllianceStation) => {
      setAllianceState(station);
      sendDs({ ">station": STATION_VALUES[station], ">new_data": true });
    },
    [sendDs],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (!workspaceSlug) {
      return;
    }

    const connect = () => {
      if (!mountedRef.current) return;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${window.location.host}/u/${workspaceSlug}/sim/halsim`,
      );
      socketRef.current = ws;
      setConnection("reconnecting");

      ws.addEventListener("open", () => {
        if (!mountedRef.current) return;
        backoffRef.current = 500;
        setConnection("connected");

        // Announce DS presence
        const announce: HalSimMessage = {
          type: DRIVER_STATION_TYPE,
          device: "",
          data: { ">ds": true, ">fms": false, ">new_data": true },
        };
        ws.send(JSON.stringify(announce));
      });

      ws.addEventListener("message", (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(String(event.data)) as HalSimMessage;
          if (msg.type !== DRIVER_STATION_TYPE || typeof msg.data !== "object") {
            return;
          }
          const d = msg.data;
          // Read authoritative state from the sim (fields with `<>` or `<` prefix
          // come from the sim; `>` fields are echoed back).
          const enabledValue = readDsField(d, "enabled");
          if (typeof enabledValue === "boolean") {
            setEnabledState(enabledValue);
          }
          const auto = readDsField(d, "autonomous");
          const test = readDsField(d, "test");
          if (typeof auto === "boolean" || typeof test === "boolean") {
            setModeState(parseDsMode(auto, test));
          }
          const eStopValue = readDsField(d, "estop", "eStop");
          if (typeof eStopValue === "boolean") {
            setEStoppedState(eStopValue);
          }
          const stationValue = readDsField(d, "station", "allianceStationId");
          if (stationValue !== undefined) {
            const val = stationValue;
            setAllianceState(parseStation(val));
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.addEventListener("close", () => {
        if (!mountedRef.current) return;
        if (socketRef.current === ws) {
          socketRef.current = null;
        }
        setConnection("reconnecting");
        setEnabledState(false);

        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener("error", () => {
        // The close event handles reconnect scheduling.
      });
    };

    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = socketRef.current;
      if (ws) {
        socketRef.current = null;
        ws.close();
      }
    };
  }, [workspaceSlug]);

  return {
    connected: connection === "connected",
    connection,
    enabled,
    mode,
    eStopped,
    alliance,
    setEnabled,
    setMode,
    setEStop,
    setAlliance,
  };
}
