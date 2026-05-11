import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  simStatusResponseSchema,
  type DriverStationPatch,
  type SimRunStatus,
  type SimStatusResponse,
} from "@/lib/contracts";

type SimRunAction = "start" | "stop" | "restart";

interface UseSimulationStateReturn {
  status: SimStatusResponse | null;
  runStatus: SimRunStatus;
  refresh: () => Promise<void>;
  startRun: () => Promise<void>;
  stopRun: () => Promise<void>;
  restartRun: () => Promise<void>;
  setDriverStation: (patch: DriverStationPatch) => Promise<void>;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function useSimulationState(workspaceSlug: string | null): UseSimulationStateReturn {
  const [status, setStatus] = useState<SimStatusResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceSlug) {
      setStatus(null);
      return;
    }
    try {
      const response = await fetch(`/u/${workspaceSlug}/api/sim/status`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Unable to read simulation status."));
      }
      setStatus(simStatusResponseSchema.parse(await response.json()));
    } catch {
      setStatus(null);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void refresh();
    if (!workspaceSlug) return;

    const interval = window.setInterval(() => void refresh(), 1_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh, workspaceSlug]);

  const runCommand = useCallback(
    async (action: SimRunAction) => {
      if (!workspaceSlug) return;
      const response = await fetch(`/u/${workspaceSlug}/api/sim/run`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        toast.error(await readError(response, "Unable to update robot code."));
        return;
      }
      await refresh();
    },
    [refresh, workspaceSlug],
  );

  const setDriverStation = useCallback(
    async (patch: DriverStationPatch) => {
      if (!workspaceSlug) return;
      const response = await fetch(`/u/${workspaceSlug}/api/sim/driver-station`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        toast.error(await readError(response, "Unable to update Driver Station state."));
        return;
      }
      setStatus(simStatusResponseSchema.parse(await response.json()));
    },
    [workspaceSlug],
  );

  return {
    status,
    runStatus: status?.run.status ?? "idle",
    refresh,
    startRun: () => runCommand("start"),
    stopRun: () => runCommand("stop"),
    restartRun: () => runCommand("restart"),
    setDriverStation,
  };
}
