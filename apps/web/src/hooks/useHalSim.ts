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
        type: "DriverStation",
        device: "",
        data: fields,
      };
      ws.send(JSON.stringify(message));
    }
  }, []);

  const setEnabled = useCallback(
    (value: boolean) => {
      sendDs({ ">enabled": value, ">new_data": true });
    },
    [sendDs],
  );

  const setMode = useCallback(
    (newMode: DsMode) => {
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
      sendDs({ ">estop": value, ">new_data": true });
    },
    [sendDs],
  );

  const setAlliance = useCallback(
    (station: AllianceStation) => {
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
          type: "DriverStation",
          device: "",
          data: { ">ds": true, ">new_data": true },
        };
        ws.send(JSON.stringify(announce));
      });

      ws.addEventListener("message", (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(String(event.data)) as HalSimMessage;
          if (msg.type !== "DriverStation" || typeof msg.data !== "object") {
            return;
          }
          const d = msg.data;
          // Read authoritative state from the sim (fields with `<>` or `<` prefix
          // come from the sim; `>` fields are echoed back).
          if ("<>enabled" in d || ">enabled" in d) {
            const val = d["<>enabled"] ?? d[">enabled"];
            if (typeof val === "boolean") setEnabledState(val);
          }
          if ("<>autonomous" in d || ">autonomous" in d || "<>test" in d || ">test" in d) {
            const auto = d["<>autonomous"] ?? d[">autonomous"];
            const test = d["<>test"] ?? d[">test"];
            setModeState(parseDsMode(auto, test));
          }
          if ("<>estop" in d || ">estop" in d) {
            const val = d["<>estop"] ?? d[">estop"];
            if (typeof val === "boolean") setEStoppedState(val);
          }
          if ("<>station" in d || ">station" in d) {
            const val = d["<>station"] ?? d[">station"];
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
