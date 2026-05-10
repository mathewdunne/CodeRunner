import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polls a function at a given interval, pausing when the tab is hidden.
 * Returns the latest result, loading state, and a manual refetch function.
 */
export function useAdminPoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): { data: T | null; loading: boolean; error: string | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback(async () => {
    try {
      const result = await fetcher();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void doFetch();

    function startPolling() {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => void doFetch(), intervalMs);
    }

    function stopPolling() {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void doFetch();
        startPolling();
      } else {
        stopPolling();
      }
    }

    startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [doFetch, intervalMs]);

  return { data, loading, error, refetch: doFetch };
}
