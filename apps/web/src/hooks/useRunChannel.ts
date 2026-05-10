import { useCallback, useEffect, useRef, useState } from "react";
import { runServerMessageSchema } from "@/lib/contracts";

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
  startRun: () => void;
  stopRun: () => void;
}

const MAX_CONSOLE_LINES = 80;

export function useRunChannel(
  workspaceSlug: string | null,
): UseRunChannelReturn {
  const [runStatus, setRunStatus] = useState<RunStatus>("connecting");
  const [connection, setConnection] = useState<RunConnection>("disconnected");
  const [consoleLines, setConsoleLines] = useState<string[]>(["Connecting..."]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(500);
  const mountedRef = useRef(true);

  const logLine = useCallback((line: string) => {
    setConsoleLines((current) =>
      [
        ...current.filter((entry) => entry !== "Connecting..."),
        line,
      ].slice(-MAX_CONSOLE_LINES),
    );
  }, []);

  const clearConsole = useCallback((line: string) => {
    setConsoleLines([line]);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!workspaceSlug) {
      return;
    }

    const connect = () => {
      if (!mountedRef.current) return;

      const protocol =
        window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${protocol}//${window.location.host}/u/${workspaceSlug}/ws/run`,
      );
      socketRef.current = socket;
      setRunStatus("connecting");

      socket.addEventListener("open", () => {
        if (!mountedRef.current) return;
        backoffRef.current = 500;
        setConnection("connected");
        setRunStatus("idle");
        logLine("Run channel connected.");
      });

      socket.addEventListener("message", (event) => {
        if (!mountedRef.current) return;
        try {
          const message = runServerMessageSchema.parse(
            JSON.parse(String(event.data)),
          );
          if (message.type === "hello") return;
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
        if (!mountedRef.current) return;
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setConnection("reconnecting");
        logLine("Run channel disconnected. Reconnecting...");

        const delay = backoffRef.current;
        backoffRef.current = Math.min(backoffRef.current * 2, 10_000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
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
      const socket = socketRef.current;
      if (socket) {
        socketRef.current = null;
        socket.close();
      }
    };
  }, [workspaceSlug, logLine]);

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

  return { runStatus, connection, consoleLines, startRun, stopRun };
}
