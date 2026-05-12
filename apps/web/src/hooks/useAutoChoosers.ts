import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  autoChoosersResponseSchema,
  type AutoChooserPatch,
  type AutoChoosersResponse,
} from "@/lib/contracts";

interface UseAutoChoosersReturn {
  status: AutoChoosersResponse | null;
  refresh: () => Promise<void>;
  selectAuto: (patch: AutoChooserPatch) => Promise<void>;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function useAutoChoosers(workspaceSlug: string | null): UseAutoChoosersReturn {
  const [status, setStatus] = useState<AutoChoosersResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceSlug) {
      setStatus(null);
      return;
    }
    try {
      const response = await fetch(`/u/${workspaceSlug}/api/sim/auto-choosers`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Unable to read auto choosers."));
      }
      setStatus(autoChoosersResponseSchema.parse(await response.json()));
    } catch {
      setStatus(null);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void refresh();
    if (!workspaceSlug) return;

    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(interval);
  }, [refresh, workspaceSlug]);

  const selectAuto = useCallback(
    async (patch: AutoChooserPatch) => {
      if (!workspaceSlug) return;
      const response = await fetch(`/u/${workspaceSlug}/api/sim/auto-chooser`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        toast.error(await readError(response, "Unable to select autonomous routine."));
        return;
      }
      setStatus(autoChoosersResponseSchema.parse(await response.json()));
    },
    [workspaceSlug],
  );

  return { status, refresh, selectAuto };
}
