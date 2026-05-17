import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useSimulationState } from "./useSimulationState";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const VALID_STATUS = {
	ok: true,
	workspace: { id: `ws_${"a".repeat(32)}`, slug: "test-slug" },
	container: { state: "running" },
	run: { status: "idle", runId: null },
	halsim: {
		connection: "disconnected",
		connected: false,
		stale: false,
		lastMessageAt: null,
		error: null,
	},
	driverStation: {
		enabled: false,
		mode: "teleop",
		eStopped: false,
		alliance: "blue1",
	},
	comms: { canEnable: false },
	joysticks: {
		status: "disconnected",
		port: null,
		label: null,
		lastInputAt: null,
	},
};

function mockFetchOk(body: unknown = VALID_STATUS) {
	return vi.fn().mockResolvedValue({
		ok: true,
		json: () => Promise.resolve(body),
	});
}

describe("useSimulationState", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", mockFetchOk());
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("returns idle when slug is null", () => {
		const { result } = renderHook(() => useSimulationState(null));
		expect(result.current.status).toBeNull();
		expect(result.current.runStatus).toBe("idle");
	});

	test("fetches status on mount", async () => {
		const { result } = renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(fetch).toHaveBeenCalledWith(
			"/u/test-slug/api/sim/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
		expect(result.current.status).not.toBeNull();
		expect(result.current.runStatus).toBe("idle");
	});

	test("polls every 1s", async () => {
		renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		const callsBefore = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(
			(fetch as ReturnType<typeof vi.fn>).mock.calls.length,
		).toBeGreaterThan(callsBefore);
	});

	test("startRun sends POST with action:start, refreshes status after", async () => {
		const { result } = renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		await act(async () => {
			await result.current.startRun();
		});

		const postCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => c[0] === "/u/test-slug/api/sim/run",
		);
		expect(postCall).toBeDefined();
		expect(postCall?.[1]).toMatchObject({
			method: "POST",
			body: JSON.stringify({ action: "start" }),
		});
	});

	test("error response shows toast", async () => {
		const { toast } = await import("sonner");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string) => {
				if (url.includes("/api/sim/run")) {
					return Promise.resolve({
						ok: false,
						json: () => Promise.resolve({ error: "Build failed" }),
					});
				}
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(VALID_STATUS),
				});
			}),
		);

		const { result } = renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		await act(async () => {
			await result.current.startRun();
		});

		expect(toast.error).toHaveBeenCalledWith("Build failed");
	});

	test("setDriverStation sends PATCH, updates local status on success", async () => {
		const updatedStatus = {
			...VALID_STATUS,
			driverStation: { ...VALID_STATUS.driverStation, enabled: true },
		};
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
				if (
					url.includes("/api/sim/driver-station") &&
					opts?.method === "PATCH"
				) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve(updatedStatus),
					});
				}
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve(VALID_STATUS),
				});
			}),
		);

		const { result } = renderHook(() => useSimulationState("test-slug"));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		await act(async () => {
			await result.current.setDriverStation({ enabled: true });
		});

		const patchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
			(c: unknown[]) => (c[0] as string).includes("/api/sim/driver-station"),
		);
		expect(patchCall?.[1]).toMatchObject({
			method: "PATCH",
			body: JSON.stringify({ enabled: true }),
		});
		expect(result.current.status?.driverStation.enabled).toBe(true);
	});
});
