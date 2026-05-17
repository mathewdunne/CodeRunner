/**
 * useRunChannel hook tests — covers the run WS state machine, reconnect, and
 * cleanup-on-unmount. Uses a fake WebSocket implementation rather than mocking
 * the global, so we get deterministic dispatch in the same tick.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useRunChannel } from "./useRunChannel";

type Listener = (event: unknown) => void;

class FakeSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static instances: FakeSocket[] = [];

	readyState = 0;
	url: string;
	sent: string[] = [];
	private listeners: Record<string, Listener[]> = {};

	constructor(url: string) {
		this.url = url;
		FakeSocket.instances.push(this);
	}

	addEventListener(event: string, listener: Listener) {
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic ??= initialize-and-use
		(this.listeners[event] ??= []).push(listener);
	}
	removeEventListener(event: string, listener: Listener) {
		this.listeners[event] = (this.listeners[event] ?? []).filter(
			(l) => l !== listener,
		);
	}
	send(payload: string) {
		this.sent.push(payload);
	}
	close() {
		this.readyState = FakeSocket.CLOSED;
		this.fire("close");
	}
	fire(event: string, payload?: unknown) {
		for (const l of this.listeners[event] ?? []) l(payload);
	}
	open() {
		this.readyState = FakeSocket.OPEN;
		this.fire("open");
	}
	message(data: unknown) {
		this.fire("message", {
			data: typeof data === "string" ? data : JSON.stringify(data),
		});
	}
}

describe("useRunChannel", () => {
	const originalWS = globalThis.WebSocket;

	beforeEach(() => {
		FakeSocket.instances = [];
		// @ts-expect-error overriding global for test
		globalThis.WebSocket = FakeSocket;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		// @ts-expect-error restore
		globalThis.WebSocket = originalWS;
	});

	test("does not connect when slug is null", () => {
		renderHook(() => useRunChannel(null));
		expect(FakeSocket.instances).toHaveLength(0);
	});

	test("connects to /u/<slug>/ws/run", () => {
		renderHook(() => useRunChannel("alice"));
		expect(FakeSocket.instances).toHaveLength(1);
		expect(FakeSocket.instances[0]?.url).toMatch(/\/u\/alice\/ws\/run$/);
	});

	test("on open → status:idle, connection:connected", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		act(() => {
			FakeSocket.instances[0]?.open();
		});
		expect(result.current.runStatus).toBe("idle");
		expect(result.current.connection).toBe("connected");
	});

	test("handles status messages from server", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		const sock = FakeSocket.instances[0]!;
		act(() => sock.open());
		act(() => sock.message({ type: "status", status: "building" }));
		expect(result.current.runStatus).toBe("building");
		act(() => sock.message({ type: "status", status: "running" }));
		expect(result.current.runStatus).toBe("running");
		act(() => sock.message({ type: "status", status: "stopped" }));
		expect(result.current.runStatus).toBe("stopped");
	});

	test("appends log lines into the console", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		const sock = FakeSocket.instances[0]!;
		act(() => sock.open());
		act(() => sock.message({ type: "log", stream: "stdout", line: "hello" }));
		expect(result.current.consoleLines.some((l) => l.includes("hello"))).toBe(
			true,
		);
	});

	test("invalid messages are ignored gracefully", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		const sock = FakeSocket.instances[0]!;
		act(() => sock.open());
		act(() => sock.fire("message", { data: "not json" }));
		expect(result.current.runStatus).toBe("idle"); // didn't crash
	});

	test("startRun sends {type:start}", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		const sock = FakeSocket.instances[0]!;
		act(() => sock.open());
		act(() => result.current.startRun());
		expect(sock.sent.some((s) => s.includes('"start"'))).toBe(true);
	});

	test("stopRun sends {type:stop} and sets status:stopping", () => {
		const { result } = renderHook(() => useRunChannel("alice"));
		const sock = FakeSocket.instances[0]!;
		act(() => sock.open());
		act(() => result.current.stopRun());
		expect(sock.sent.some((s) => s.includes('"stop"'))).toBe(true);
		expect(result.current.runStatus).toBe("stopping");
	});

	test("reconnects with backoff after close", () => {
		renderHook(() => useRunChannel("alice"));
		expect(FakeSocket.instances).toHaveLength(1);
		act(() => FakeSocket.instances[0]?.close());
		expect(FakeSocket.instances).toHaveLength(1);
		act(() => {
			vi.advanceTimersByTime(600);
		});
		expect(FakeSocket.instances).toHaveLength(2);
	});

	test("unmount stops reconnect timer (no zombie sockets)", () => {
		const { unmount } = renderHook(() => useRunChannel("alice"));
		act(() => FakeSocket.instances[0]?.close());
		unmount();
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		expect(FakeSocket.instances.length).toBe(1);
	});
});
