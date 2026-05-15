import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSession } from "./useSession";

const VALID_SESSION = { workspaceId: "ws_abc", slug: "test-slug", status: "running" };

describe("useSession", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/session")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(VALID_SESSION) });
        }
        // heartbeat
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("returns loading initially, then ready on success", async () => {
    const { result } = renderHook(() => useSession("test-slug"));
    expect(result.current.status).toBe("loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
  });

  test("returns error on fetch failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/session")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
            json: () => Promise.reject(new Error("no body")),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    const { result } = renderHook(() => useSession("test-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("error");
  });

  test("error state includes server error message when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/session")) {
          return Promise.resolve({
            ok: false,
            status: 403,
            statusText: "Forbidden",
            json: () => Promise.resolve({ error: "Workspace not found" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    const { result } = renderHook(() => useSession("test-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("error");
    if (result.current.status === "error") {
      expect(result.current.message).toBe("Workspace not found");
    }
  });

  test("returns error when slug is null", () => {
    const { result } = renderHook(() => useSession(null));
    expect(result.current.status).toBe("error");
  });

  test("heartbeat sent on mount", async () => {
    renderHook(() => useSession("test-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const heartbeatCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("/api/heartbeat"),
    );
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
    expect(heartbeatCalls[0][1]).toMatchObject({ method: "POST" });
  });

  test("heartbeat sent every 60s", async () => {
    renderHook(() => useSession("test-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const countBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("/api/heartbeat"),
    ).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    const countAfter = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("/api/heartbeat"),
    ).length;
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test("cleanup stops heartbeat interval", async () => {
    const { unmount } = renderHook(() => useSession("test-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    const countAtUnmount = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("/api/heartbeat"),
    ).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    const countAfter = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes("/api/heartbeat"),
    ).length;
    expect(countAfter).toBe(countAtUnmount);
  });
});
