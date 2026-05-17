/**
 * Minimal fake NT4 server for E2E tests. Accepts WebSocket connections and
 * sends a configurable "announce" frame on connect so tests can verify that
 * the NT4 proxy delivers traffic to the correct workspace only.
 *
 * The NT4 wire protocol uses MessagePack for binary frames and JSON for text
 * frames. AdvantageScope Lite's NT4 client sends JSON subscribe messages and
 * the server responds with JSON topic announcements. This fake only handles
 * the JSON text-mode subset which is sufficient for proxy-isolation tests.
 */
import type { Server, ServerWebSocket } from "bun";

export type FakeNt4Handle = {
	/** WebSocket URL clients connect to */
	wsUrl: string;
	/** HTTP URL for alive-check probes */
	httpUrl: string;
	/** Frames received from connected clients */
	receivedFrames(): Array<unknown>;
	/** Push a JSON frame to all connected clients */
	pushFrame(frame: unknown): void;
	/** Number of active WS connections */
	connections(): number;
	/** Wait until at least `n` connections have been opened */
	awaitConnection(n?: number, timeout?: number): Promise<void>;
	/** Tear down the server */
	stop(): Promise<void>;
};

export type FakeNt4Options = {
	/** Topic announcements sent to every new client on connect */
	announceTopics?: Array<{ name: string; type: string; id: number }>;
};

export async function startFakeNt4(
	options: FakeNt4Options = {},
): Promise<FakeNt4Handle> {
	const receivedFrames: Array<unknown> = [];
	const conns = new Set<ServerWebSocket<unknown>>();
	let connectionCount = 0;
	let connectionWaiters: Array<{ resolve: () => void; target: number }> = [];

	function checkWaiters() {
		for (const waiter of connectionWaiters) {
			if (connectionCount >= waiter.target) {
				waiter.resolve();
			}
		}
		connectionWaiters = connectionWaiters.filter(
			(w) => connectionCount < w.target,
		);
	}

	const server: Server = Bun.serve({
		port: 0,
		fetch(request, srv) {
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const upgraded = srv.upgrade(request);
				return upgraded
					? undefined
					: new Response("upgrade failed", { status: 400 });
			}
			// HTTP alive-check probe
			return new Response("nt4 alive\n", {
				headers: { "content-type": "text/plain" },
			});
		},
		websocket: {
			open(ws) {
				conns.add(ws);
				connectionCount++;
				checkWaiters();

				// Send topic announcements on connect (mimics NT4 server behavior)
				if (options.announceTopics && options.announceTopics.length > 0) {
					for (const topic of options.announceTopics) {
						ws.send(
							JSON.stringify({
								method: "announce",
								params: {
									name: topic.name,
									type: topic.type,
									id: topic.id,
								},
							}),
						);
					}
				}
			},
			message(_ws, message) {
				try {
					receivedFrames.push(
						typeof message === "string" ? JSON.parse(message) : message,
					);
				} catch {
					receivedFrames.push(message);
				}
			},
			close(ws) {
				conns.delete(ws);
			},
		},
	});

	const port = server.port;

	return {
		wsUrl: `ws://127.0.0.1:${port}/`,
		httpUrl: `http://127.0.0.1:${port}/`,
		receivedFrames: () => [...receivedFrames],
		pushFrame(frame: unknown) {
			const data = typeof frame === "string" ? frame : JSON.stringify(frame);
			for (const ws of conns) ws.send(data);
		},
		connections: () => conns.size,
		awaitConnection(n?: number, timeout = 5000): Promise<void> {
			const target = n ?? connectionCount + 1;
			if (connectionCount >= target) return Promise.resolve();
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					connectionWaiters = connectionWaiters.filter(
						(w) => w.resolve !== resolve,
					);
					reject(
						new Error(
							`Timed out waiting for NT4 connection #${target} (got ${connectionCount})`,
						),
					);
				}, timeout);
				connectionWaiters.push({
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
					target,
				});
			});
		},
		async stop() {
			server.stop(true);
		},
	};
}
