import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoChoosers } from "./useAutoChoosers";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const VALID_RESPONSE = {
  ok: true,
  nt4: { connection: "connected", connected: true, stale: false, lastMessageAt: null, error: null },
  choosers: [
    { key: "/SmartDashboard/Auto", displayKey: "Auto", options: ["Left", "Right"], default: "Left", active: "Left", selected: "Left" },
  ],
};

describe("useAutoChoosers", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(VALID_RESPONSE),
      }),
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("returns null when slug is null", () => {
    const { result } = renderHook(() => useAutoChoosers(null));
    expect(result.current.status).toBeNull();
  });

  test("fetches and parses on mount", async () => {
    const { result } = renderHook(() => useAutoChoosers("my-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch).toHaveBeenCalledWith("/u/my-slug/api/sim/auto-choosers", expect.objectContaining({ credentials: "same-origin" }));
    expect(result.current.status).toEqual(VALID_RESPONSE);
  });

  test("polls every 1s", async () => {
    renderHook(() => useAutoChoosers("my-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test("selectAuto sends PATCH, updates local status", async () => {
    const updatedResponse = {
      ...VALID_RESPONSE,
      choosers: [{ ...VALID_RESPONSE.choosers[0], selected: "Right" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/api/sim/auto-chooser") && opts?.method === "PATCH") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(updatedResponse) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(VALID_RESPONSE) });
      }),
    );

    const { result } = renderHook(() => useAutoChoosers("my-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.selectAuto({ key: "/SmartDashboard/Auto", selected: "Right" });
    });

    const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/api/sim/auto-chooser") && (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(result.current.status?.choosers[0].selected).toBe("Right");
  });

  test("error response shows toast", async () => {
    const { toast } = await import("sonner");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url.includes("/api/sim/auto-chooser") && opts?.method === "PATCH") {
          return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "NT4 not connected" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(VALID_RESPONSE) });
      }),
    );

    const { result } = renderHook(() => useAutoChoosers("my-slug"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await result.current.selectAuto({ key: "/SmartDashboard/Auto", selected: "Right" });
    });

    expect(toast.error).toHaveBeenCalledWith("NT4 not connected");
  });
});
