import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useContainerStatus } from "./useContainerStatus";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const VALID_STATUS = { state: "running", containerId: "abc123" };

describe("useContainerStatus", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: () => Promise.resolve(VALID_STATUS),
			}),
		);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("returns null when slug is null", () => {
		const { result } = renderHook(() => useContainerStatus(null));
		expect(result.current).toBeNull();
	});

	test("fetches on mount, returns parsed status", async () => {
		const { result } = renderHook(() => useContainerStatus("my-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(fetch).toHaveBeenCalledWith(
			"/u/my-slug/api/containers/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
		expect(result.current).toEqual(VALID_STATUS);
	});

	test("polls every 5s", async () => {
		renderHook(() => useContainerStatus("my-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		const callsAfterMount = (fetch as ReturnType<typeof vi.fn>).mock.calls
			.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(
			(fetch as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeGreaterThan(callsAfterMount);
	});

	test("503 capacity shows toast only once for repeated 503s", async () => {
		const { toast } = await import("sonner");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
				json: () => Promise.resolve({ error: "capacity" }),
			}),
		);

		const { result } = renderHook(() => useContainerStatus("my-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(result.current).toBeNull();

		// Second poll — toast should NOT fire again
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	test("network error returns null", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
		const { result } = renderHook(() => useContainerStatus("my-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(result.current).toBeNull();
	});

	test("cleanup cancels interval", async () => {
		const { unmount } = renderHook(() => useContainerStatus("my-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		unmount();
		const callsAtUnmount = (fetch as ReturnType<typeof vi.fn>).mock.calls
			.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			callsAtUnmount,
		);
	});
});
