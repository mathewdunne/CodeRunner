import { useEffect, useState } from "react";
import type { SessionResponse } from "@/lib/contracts";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceSlug: string; session: SessionResponse }
  | { status: "error"; workspaceSlug: string; message: string };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText || "request failed"}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") {
        detail = body.error;
      }
    } catch {
      // Preserve the HTTP status when the server did not return an API error body.
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export function useSession(workspaceSlug: string | null) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Load session on mount
  useEffect(() => {
    if (!workspaceSlug) {
      return;
    }

    const slug = workspaceSlug;
    let cancelled = false;

    async function loadSession() {
      try {
        const session = await fetchJson<SessionResponse>(
          `/u/${slug}/api/session`,
        );
        if (!cancelled) {
          setState({ status: "ready", workspaceSlug: slug, session });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load workspace.";
        if (!cancelled) {
          setState({ status: "error", workspaceSlug: slug, message });
        }
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [workspaceSlug]);

  // Heartbeat every 60s
  useEffect(() => {
    if (!workspaceSlug) return;

    const sendHeartbeat = (closing = false) => {
      void fetch(`/u/${workspaceSlug}/api/heartbeat`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ closing }),
        keepalive: true,
      });
    };

    const onPageHide = () => sendHeartbeat(true);

    sendHeartbeat();
    const interval = window.setInterval(() => sendHeartbeat(), 60_000);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [workspaceSlug]);

  if (!workspaceSlug) {
    return { status: "error", message: "Workspace route is invalid." } as const;
  }
  if (state.status !== "loading" && state.workspaceSlug !== workspaceSlug) {
    return { status: "loading" } as const;
  }
  return state;
}

export type { LoadState };
