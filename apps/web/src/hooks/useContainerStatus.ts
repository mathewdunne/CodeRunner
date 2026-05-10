import { useEffect, useState } from "react";
import type { ContainersStatusResponse } from "@/lib/contracts";

export function useContainerStatus(workspaceSlug: string | null) {
  const [containerStatus, setContainerStatus] =
    useState<ContainersStatusResponse | null>(null);

  useEffect(() => {
    if (!workspaceSlug) return;

    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const response = await fetch(
          `/u/${workspaceSlug}/api/containers/status`,
          { credentials: "same-origin" },
        );
        if (!response.ok) throw new Error("fetch failed");
        const status =
          (await response.json()) as ContainersStatusResponse;
        if (!cancelled) setContainerStatus(status);
      } catch {
        if (!cancelled) setContainerStatus(null);
      }
    };

    void refreshStatus();
    const interval = window.setInterval(
      () => void refreshStatus(),
      5_000,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceSlug]);

  return containerStatus;
}
