import { describe, expect, test } from "bun:test";
import type { AppSocket, SocketData } from "../app/types";
import { PROXY_PENDING_LIMIT } from "../app/types";
import { SIM_SNAPSHOT_PUSH_INTERVAL_MS } from "../app/websocket";
import {
	createFakeDocker,
	login,
	makeScriptedRunCommandFactory,
	waitFor,
	withApp,
	workspaceBySlug,
} from "./helpers";

/**
 * Characterization tests for `createWebSocketHandlers` (plan 008). These pin the
 * router's current `open`/`message`/`close` behavior across socket kinds so the
 * later shared-bridge refactor (plan 009) has a fast regression net. They assert
 * existing behavior and make NO production changes. The proxy `open` path (a real
 * upstream `new WebSocket`) is deliberately left to the e2e tier.
 */

type CloseCall = { code?: number | undefined; reason?: string | undefined };

type FakeSocket = AppSocket & {
	sent: Array<string | ArrayBuffer | Uint8Array>;
	closes: CloseCall[];
};

function fakeSocket(data: SocketData): FakeSocket {
	const sent: Array<string | ArrayBuffer | Uint8Array> = [];
	const closes: CloseCall[] = [];
	return {
		data,
		send(payload: string | ArrayBuffer | Uint8Array) {
			sent.push(payload);
			return undefined;
		},
		close(code?: number, reason?: string) {
			closes.push({ code, reason });
			return undefined;
		},
		sent,
		closes,
	};
}

/** Parse the first JSON string the handler sent on a socket. */
function firstSentJson(ws: FakeSocket): unknown {
	const first = ws.sent[0];
	expect(typeof first).toBe("string");
	return JSON.parse(first as string);
}

describe("websocket message router", () => {
	describe("open", () => {
		test("gamepad open sends a hello frame", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "gamepad", workspace });

				app.websocket.open(ws);

				expect(ws.sent).toHaveLength(1);
				expect(firstSentJson(ws)).toEqual({ type: "hello" });
				expect(ws.closes).toHaveLength(0);
			});
		});

		test("import and lesson-load open are no-ops", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const userId = workspace.user_id;

				const importWs = fakeSocket({ kind: "import", workspace, userId });
				const lessonWs = fakeSocket({
					kind: "lesson-load",
					workspace,
					userId,
				});

				app.websocket.open(importWs);
				app.websocket.open(lessonWs);

				expect(importWs.sent).toHaveLength(0);
				expect(importWs.closes).toHaveLength(0);
				expect(lessonWs.sent).toHaveLength(0);
				expect(lessonWs.closes).toHaveLength(0);
			});
		});

		test("run open registers a run connection", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "run", workspace });

				app.websocket.open(ws);

				expect(
					ws.data.kind === "run" ? ws.data.connection : undefined,
				).toBeDefined();
				app.websocket.close(ws);
			});
		});

		test("run open pushes sim snapshots and skips unchanged ones", async () => {
			const fakeDocker = createFakeDocker();
			await withApp(
				async (app) => {
					await login(app, "Alice");
					const workspace = workspaceBySlug(app, "alice");
					const ws = fakeSocket({ kind: "run", workspace });

					app.websocket.open(ws);
					// runs.connect sends its own hello first; the two pushes follow.
					const pushes = () =>
						ws.sent
							.map((raw) => JSON.parse(raw as string) as { type: string })
							.filter((m) => m.type !== "hello");
					await waitFor(() => pushes().length >= 2);

					expect(pushes()).toEqual([
						expect.objectContaining({
							type: "sim-status",
							status: expect.objectContaining({
								ok: true,
								workspace: { id: workspace.id, slug: "alice" },
							}),
						}),
						expect.objectContaining({
							type: "auto-choosers",
							status: expect.objectContaining({ ok: true }),
						}),
					]);

					// Nothing changed, so the next tick sends nothing.
					await Bun.sleep(SIM_SNAPSHOT_PUSH_INTERVAL_MS + 200);
					expect(pushes()).toHaveLength(2);

					app.websocket.close(ws);
					expect(
						ws.data.kind === "run" ? ws.data.snapshotTimer : "not-run",
					).toBeUndefined();
				},
				{
					dockerRunner: fakeDocker.runner,
					codeImage: "coderunner-workspace:test",
					simPortRange: { start: 26120, end: 26129 },
					vscodePortRange: { start: 33420, end: 33429 },
					halsimPortRange: { start: 34420, end: 34429 },
				},
			);
		});
	});

	describe("message — gamepad", () => {
		test("invalid JSON sends an error frame", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "gamepad", workspace });

				app.websocket.message(ws, "not json");

				expect(ws.sent).toHaveLength(1);
				expect(firstSentJson(ws)).toMatchObject({ type: "error" });
			});
		});
	});

	describe("message — run", () => {
		test("start dispatches a run and replies with hello+runId", async () => {
			const fakeDocker = createFakeDocker();
			await withApp(
				async (app) => {
					await login(app, "Alice");
					const workspace = workspaceBySlug(app, "alice");
					// No open() here: a run socket can dispatch start without a
					// registered connection (connection is optional), which keeps
					// sent[0] the start reply rather than the initial connect hello.
					const ws = fakeSocket({ kind: "run", workspace });

					app.websocket.message(ws, JSON.stringify({ type: "start" }));

					const hello = firstSentJson(ws) as { type: string; runId: string };
					expect(hello.type).toBe("hello");
					expect(typeof hello.runId).toBe("string");
					// The run was registered synchronously; the build is in flight.
					expect(app.runs.getWorkspaceSnapshot(workspace.id)).toMatchObject({
						status: "building",
						runId: hello.runId,
					});

					// Let the async build settle to a terminal state so it does not
					// write to the DB after withApp tears the app down.
					app.runs.stopWorkspace(workspace.id);
					await waitFor(
						() =>
							app.runs.getWorkspaceSnapshot(workspace.id).status === "stopped",
					);
				},
				{
					dockerRunner: fakeDocker.runner,
					runCommandFactory: makeScriptedRunCommandFactory([
						{ exit: 0, signal: null },
					]),
					codeImage: "coderunner-workspace:test",
					simPortRange: { start: 25840, end: 25849 },
					vscodePortRange: { start: 33040, end: 33049 },
				},
			);
		});

		test("invalid JSON sends an error frame", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "run", workspace });

				app.websocket.message(ws, "{");

				expect(ws.sent).toHaveLength(1);
				expect(firstSentJson(ws)).toMatchObject({ type: "error" });
			});
		});
	});

	describe("message — import", () => {
		test("a non-GitHub URL sends an error and closes 1000", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({
					kind: "import",
					workspace,
					userId: workspace.user_id,
				});

				app.websocket.message(
					ws,
					JSON.stringify({ url: "https://example.com/not-github" }),
				);

				expect(firstSentJson(ws)).toMatchObject({ type: "error" });
				expect(ws.closes).toHaveLength(1);
				expect(ws.closes[0]?.code).toBe(1000);
			});
		});
	});

	describe("message — lesson-load", () => {
		test("an unknown module sends an error and closes 1000", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({
					kind: "lesson-load",
					workspace,
					userId: workspace.user_id,
				});

				// This path runs in a detached async IIFE; await the side effects.
				app.websocket.message(
					ws,
					JSON.stringify({ moduleId: "definitely-not-a-real-module" }),
				);

				await waitFor(() => ws.closes.length > 0);
				expect(firstSentJson(ws)).toMatchObject({ type: "error" });
				expect(ws.closes[0]?.code).toBe(1000);
			});
		});
	});

	describe("message — proxy (nt4/vscode/halsim)", () => {
		test("buffers when upstream is not open", async () => {
			await withApp(async (app) => {
				const ws = fakeSocket({
					kind: "nt4",
					upstreamUrl: "ws://127.0.0.1:1/x",
					protocols: [],
					upstream: undefined,
					upstreamOpen: false,
					pendingMessages: [],
				});

				app.websocket.message(ws, "hello");

				expect(ws.data.kind === "nt4" ? ws.data.pendingMessages : []).toEqual([
					"hello",
				]);
			});
		});

		test("forwards to upstream when open", async () => {
			await withApp(async (app) => {
				const forwarded: Array<string | ArrayBuffer | Uint8Array> = [];
				const fakeUpstream = {
					readyState: WebSocket.OPEN,
					send(payload: string | ArrayBuffer | Uint8Array) {
						forwarded.push(payload);
					},
					close() {},
				} as unknown as WebSocket;
				const ws = fakeSocket({
					kind: "nt4",
					upstreamUrl: "ws://127.0.0.1:1/x",
					protocols: [],
					upstream: fakeUpstream,
					upstreamOpen: true,
					pendingMessages: [],
				});

				app.websocket.message(ws, "payload");

				expect(forwarded).toEqual(["payload"]);
				expect(
					ws.data.kind === "nt4" ? ws.data.pendingMessages : ["x"],
				).toEqual([]);
			});
		});

		test("closes 1013 once the pending buffer is full", async () => {
			await withApp(async (app) => {
				const pending: Array<string | ArrayBuffer | Uint8Array> = [];
				const ws = fakeSocket({
					kind: "halsim",
					upstreamUrl: "ws://127.0.0.1:1/x",
					protocols: [],
					upstream: undefined,
					upstreamOpen: false,
					pendingMessages: pending,
				});

				for (let i = 0; i < PROXY_PENDING_LIMIT; i += 1) {
					app.websocket.message(ws, `m${i}`);
				}
				expect(pending).toHaveLength(PROXY_PENDING_LIMIT);
				expect(ws.closes).toHaveLength(0);

				// One past the limit closes with 1013 and does not buffer.
				app.websocket.message(ws, "overflow");

				expect(pending).toHaveLength(PROXY_PENDING_LIMIT);
				expect(ws.closes).toHaveLength(1);
				expect(ws.closes[0]?.code).toBe(1013);
			});
		});

		test("close tears down upstream and clears the buffer", async () => {
			await withApp(async (app) => {
				let upstreamClosed = false;
				const fakeUpstream = {
					readyState: WebSocket.OPEN,
					send() {},
					close() {
						upstreamClosed = true;
					},
				} as unknown as WebSocket;
				const pending: Array<string | ArrayBuffer | Uint8Array> = ["a", "b"];
				const ws = fakeSocket({
					kind: "vscode",
					upstreamUrl: "ws://127.0.0.1:1/x",
					protocols: [],
					upstream: fakeUpstream,
					upstreamOpen: true,
					pendingMessages: pending,
				});

				app.websocket.close(ws);

				expect(upstreamClosed).toBe(true);
				expect(pending).toHaveLength(0);
			});
		});
	});

	describe("close — gamepad and run", () => {
		test("gamepad close does not throw or send", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "gamepad", workspace });

				expect(() => app.websocket.close(ws)).not.toThrow();
				expect(ws.sent).toHaveLength(0);
			});
		});

		test("run close disconnects without throwing", async () => {
			await withApp(async (app) => {
				await login(app, "Alice");
				const workspace = workspaceBySlug(app, "alice");
				const ws = fakeSocket({ kind: "run", workspace });
				app.websocket.open(ws); // sets ws.data.connection

				expect(() => app.websocket.close(ws)).not.toThrow();
			});
		});
	});
});
