import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SimStatusResponse } from "@/lib/contracts";
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
		const { result } = renderHook(() => useSimulationState(null, null));
		expect(result.current.status).toBeNull();
		expect(result.current.runStatus).toBe("idle");
	});

	test("adopts the status pushed over the run socket", () => {
		const { result, rerender } = renderHook(
			({ pushed }) => useSimulationState("test-slug", pushed),
			{ initialProps: { pushed: null as SimStatusResponse | null } },
		);
		expect(result.current.status).toBeNull();

		const running = {
			...VALID_STATUS,
			run: { status: "running", runId: "run_1" },
		} as SimStatusResponse;
		rerender({ pushed: running });
		expect(result.current.runStatus).toBe("running");

		rerender({ pushed: null });
		expect(result.current.status).toBeNull();
	});

	test("does not poll the status endpoint", async () => {
		renderHook(() => useSimulationState("test-slug", null));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	test("startRun sends POST with action:start, refreshes status after", async () => {
		const { result } = renderHook(() => useSimulationState("test-slug", null));
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

	test("startRun sends the mode only when one is given; restartRun sends none", async () => {
		const { result } = renderHook(() => useSimulationState("test-slug", null));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		await act(async () => {
			await result.current.startRun("debug");
			await result.current.startRun();
			await result.current.restartRun();
		});

		const bodies = (fetch as ReturnType<typeof vi.fn>).mock.calls
			.filter((c: unknown[]) => c[0] === "/u/test-slug/api/sim/run")
			.map((c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string));
		expect(bodies).toEqual([
			{ action: "start", mode: "debug" },
			{ action: "start" },
			{ action: "restart" },
		]);
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

		const { result } = renderHook(() => useSimulationState("test-slug", null));
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

		const { result } = renderHook(() => useSimulationState("test-slug", null));
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
