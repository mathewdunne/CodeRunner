import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ContainersStatusResponse } from "@/lib/contracts";

export function useContainerStatus(workspaceSlug: string | null) {
  const [containerStatus, setContainerStatus] =
    useState<ContainersStatusResponse | null>(null);

  useEffect(() => {
    if (!workspaceSlug) return;

    let cancelled = false;
    let capacityToastShown = false;
    const refreshStatus = async () => {
      try {
        const response = await fetch(
          `/u/${workspaceSlug}/api/containers/status`,
          { credentials: "same-origin" },
        );
        if (response.status === 503) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          if (body.error === "capacity" && !capacityToastShown) {
            capacityToastShown = true;
            toast.error(
              "Server at capacity — your coach has been notified. Please try again in a few minutes.",
              { duration: 15_000 },
            );
          }
          if (!cancelled) setContainerStatus(null);
          return;
        }
        if (!response.ok) throw new Error("fetch failed");
        capacityToastShown = false;
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
