import { describe, expect, test } from "bun:test";
import type { RunCommandFactory } from "../runs";
import {
	cookieFrom,
	createFakeDocker,
	login,
	waitFor,
	withApp,
	workspaceBySlug,
} from "./helpers";

class FakeWebSocket {
	readyState: number = WebSocket.CONNECTING;
	binaryType = "blob";
	sent: Array<string | Uint8Array> = [];
	private readonly listeners = new Map<string, Array<(event: any) => void>>();

	addEventListener(type: string, listener: (event: any) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(data: string | Uint8Array): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.emit("close", { reason: "closed" });
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.emit("open", {});
	}

	message(data: unknown): void {
		this.emit("message", { data: JSON.stringify(data) });
	}

	binary(data: Uint8Array): void {
		this.emit("message", { data });
	}

	private emit(type: string, event: any): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

function encodeMsgPack(value: unknown): Uint8Array {
	const chunks: number[] = [];
	const push = (...bytes: number[]) =>
		chunks.push(...bytes.map((byte) => byte & 0xff));
	const writeString = (item: string) => {
		const encoded = new TextEncoder().encode(item);
		push(0xa0 | encoded.length, ...encoded);
	};
	const write = (item: unknown) => {
		if (Array.isArray(item)) {
			push(0x90 | item.length);
			for (const child of item) write(child);
		} else if (typeof item === "string") {
			writeString(item);
		} else if (typeof item === "number") {
			push(item);
		}
	};
	write(value);
	return new Uint8Array(chunks);
}

function createControlledRunCommands() {
	const encoder = new TextEncoder();
	const commands: Array<{
		writeStdout(line: string): void;
		exit(code: number | null): void;
	}> = [];

	const commandFactory: RunCommandFactory = () => {
		let stdoutController: ReadableStreamDefaultController<Uint8Array>;
		let stderrController: ReadableStreamDefaultController<Uint8Array>;
		let resolveExit: (exit: {
			code: number | null;
			signal: string | null;
		}) => void = () => {};
		const exited = new Promise<{ code: number | null; signal: string | null }>(
			(resolve) => {
				resolveExit = resolve;
			},
		);
		const command = {
			writeStdout(line: string) {
				stdoutController.enqueue(encoder.encode(`${line}\n`));
			},
			exit(code: number | null) {
				stdoutController.close();
				stderrController.close();
				resolveExit({ code, signal: null });
			},
		};
		commands.push(command);
		return {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					stdoutController = controller;
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					stderrController = controller;
				},
			}),
			exited,
			kill() {
				command.exit(null);
			},
		};
	};

	return { commands, commandFactory };
}

describe("simulation HTTP API", () => {
	test("returns an authenticated idle simulation snapshot", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/status", {
						headers: { cookie },
					}),
				);

				expect(response.status).toBe(200);
				const body = (await response.json()) as {
					run: { status: string };
					halsim: { connection: string };
					comms: { canEnable: boolean };
				};
				expect(body.run.status).toBe("idle");
				expect(body.halsim.connection).toBe("disconnected");
				expect(body.comms.canEnable).toBe(false);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26010, end: 26019 },
				vscodePortRange: { start: 33310, end: 33319 },
				halsimPortRange: { start: 34310, end: 34319 },
			},
		);
	});

	test("HTTP run start streams logs to an existing run WebSocket client", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				const messages: unknown[] = [];
				app.runs.connect(workspace, (message) => messages.push(message));

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/run", {
						method: "POST",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ action: "start" }),
					}),
				);

				expect(response.status).toBe(202);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(() => JSON.stringify(messages).includes("running"));
				expect(messages).toContainEqual({ type: "status", status: "running" });
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26020, end: 26029 },
				vscodePortRange: { start: 33320, end: 33329 },
				halsimPortRange: { start: 34320, end: 34329 },
			},
		);
	});

	test("Driver Station patch returns 409 when robot code is not running", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/driver-station", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ enabled: true }),
					}),
				);

				expect(response.status).toBe(409);
				expect(await response.json()).toMatchObject({
					error: "Robot code is not running.",
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26030, end: 26039 },
				vscodePortRange: { start: 33330, end: 33339 },
				halsimPortRange: { start: 34330, end: 34339 },
			},
		);
	});

	test("Driver Station patch returns 503 when HALSim is unavailable", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const sockets: FakeWebSocket[] = [];

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				app.runs.start(workspace);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/driver-station", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ enabled: true }),
					}),
				);

				expect(response.status).toBe(503);
				expect(await response.json()).toMatchObject({
					error: "HALSim bridge is not connected.",
				});
				expect(sockets).toHaveLength(1);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				halsimWebSocketFactory: () => {
					const socket = new FakeWebSocket();
					sockets.push(socket);
					return socket as unknown as WebSocket;
				},
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26040, end: 26049 },
				vscodePortRange: { start: 33340, end: 33349 },
				halsimPortRange: { start: 34340, end: 34349 },
			},
		);
	});

	test("Driver Station patch sends desired state through the HALSim bridge", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const sockets: FakeWebSocket[] = [];

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				app.runs.start(workspace);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);

				const statusResponse = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/status", {
						headers: { cookie },
					}),
				);
				expect(statusResponse.status).toBe(200);
				await waitFor(
					() =>
						sockets.length === 1 && sockets[0]?.readyState === WebSocket.OPEN,
				);

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/driver-station", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({ mode: "test", enabled: true }),
					}),
				);

				expect(response.status).toBe(200);
				const sent = sockets[0]!.sent
					.filter((raw): raw is string => typeof raw === "string")
					.map((raw) => JSON.parse(raw) as { data: Record<string, unknown> });
				expect(sent.some((message) => message.data[">test"] === true)).toBe(
					true,
				);
				expect(sent.some((message) => message.data[">enabled"] === true)).toBe(
					true,
				);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				halsimWebSocketFactory: () => {
					const socket = new FakeWebSocket();
					sockets.push(socket);
					queueMicrotask(() => {
						socket.open();
						socket.message({
							type: "DriverStation",
							device: "",
							data: {
								">enabled": false,
								">autonomous": false,
								">test": false,
								">estop": false,
								">station": "red1",
							},
						});
					});
					return socket as unknown as WebSocket;
				},
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26050, end: 26059 },
				vscodePortRange: { start: 33350, end: 33359 },
				halsimPortRange: { start: 34350, end: 34359 },
			},
		);
	});

	test("auto chooser API discovers options and writes selected routine to NT4", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const sockets: FakeWebSocket[] = [];

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				app.runs.start(workspace);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);

				const statusResponse = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);
				expect(statusResponse.status).toBe(200);
				await waitFor(
					() =>
						sockets.length === 1 && sockets[0]?.readyState === WebSocket.OPEN,
				);

				const chooserResponse = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);
				expect(await chooserResponse.json()).toMatchObject({
					choosers: [
						{
							key: "SmartDashboard/Auto Choices",
							options: ["Taxi", "Score"],
							default: "Taxi",
							active: "Taxi",
						},
					],
				});

				const selectResponse = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-chooser", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({
							key: "SmartDashboard/Auto Choices",
							selected: "Score",
						}),
					}),
				);
				expect(selectResponse.status).toBe(200);
				const textMessages = sockets[0]!.sent.filter(
					(data): data is string => typeof data === "string",
				);
				expect(
					textMessages.some(
						(raw) =>
							raw.includes('"publish"') &&
							raw.includes("/SmartDashboard/Auto Choices/selected"),
					),
				).toBe(true);
				expect(
					sockets[0]?.sent.some((data) => data instanceof Uint8Array),
				).toBe(true);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				nt4AutoWebSocketFactory: () => {
					const socket = new FakeWebSocket();
					sockets.push(socket);
					queueMicrotask(() => {
						socket.open();
						socket.message([
							{
								method: "announce",
								params: {
									id: 1,
									name: "/SmartDashboard/Auto Choices/.type",
									type: "string",
								},
							},
							{
								method: "announce",
								params: {
									id: 2,
									name: "/SmartDashboard/Auto Choices/options",
									type: "string[]",
								},
							},
							{
								method: "announce",
								params: {
									id: 3,
									name: "/SmartDashboard/Auto Choices/default",
									type: "string",
								},
							},
							{
								method: "announce",
								params: {
									id: 4,
									name: "/SmartDashboard/Auto Choices/active",
									type: "string",
								},
							},
						]);
						socket.binary(encodeMsgPack([1, 0, 4, "String Chooser"]));
						socket.binary(encodeMsgPack([2, 0, 20, ["Taxi", "Score"]]));
						socket.binary(encodeMsgPack([3, 0, 4, "Taxi"]));
						socket.binary(encodeMsgPack([4, 0, 4, "Taxi"]));
					});
					return socket as unknown as WebSocket;
				},
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26060, end: 26069 },
				vscodePortRange: { start: 33360, end: 33369 },
				halsimPortRange: { start: 34360, end: 34369 },
			},
		);
	});

	test("auto chooser bridge ignores malformed NT4 binary frames instead of crashing", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const sockets: FakeWebSocket[] = [];

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				app.runs.start(workspace);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);

				const response = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);
				await waitFor(
					() =>
						sockets.length === 1 && sockets[0]?.readyState === WebSocket.OPEN,
				);
				const refreshed = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);

				expect(response.status).toBe(200);
				expect(refreshed.status).toBe(200);
				expect(await refreshed.json()).toMatchObject({
					ok: true,
					nt4: { connected: true },
				});
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				nt4AutoWebSocketFactory: () => {
					const socket = new FakeWebSocket();
					sockets.push(socket);
					queueMicrotask(() => {
						socket.open();
						socket.binary(new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff]));
					});
					return socket as unknown as WebSocket;
				},
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26070, end: 26079 },
				vscodePortRange: { start: 33370, end: 33379 },
				halsimPortRange: { start: 34370, end: 34379 },
			},
		);
	});

	test("auto chooser bridge republishes selected topic after NT4 reconnect", async () => {
		const fakeDocker = createFakeDocker();
		const controlled = createControlledRunCommands();
		const sockets: FakeWebSocket[] = [];

		function announceChooser(socket: FakeWebSocket): void {
			socket.message([
				{
					method: "announce",
					params: {
						id: 1,
						name: "/SmartDashboard/Auto Choices/.type",
						type: "string",
					},
				},
				{
					method: "announce",
					params: {
						id: 2,
						name: "/SmartDashboard/Auto Choices/options",
						type: "string[]",
					},
				},
				{
					method: "announce",
					params: {
						id: 3,
						name: "/SmartDashboard/Auto Choices/default",
						type: "string",
					},
				},
				{
					method: "announce",
					params: {
						id: 4,
						name: "/SmartDashboard/Auto Choices/active",
						type: "string",
					},
				},
			]);
			socket.binary(encodeMsgPack([1, 0, 4, "String Chooser"]));
			socket.binary(encodeMsgPack([2, 0, 20, ["None", "Score"]]));
			socket.binary(encodeMsgPack([3, 0, 4, "None"]));
			socket.binary(encodeMsgPack([4, 0, 4, "None"]));
		}

		await withApp(
			async (app) => {
				const loginResponse = await login(app, "alice");
				const cookie = cookieFrom(loginResponse);
				const workspace = workspaceBySlug(app, "alice");
				app.runs.start(workspace);
				await waitFor(() => controlled.commands.length === 1);
				controlled.commands[0]?.writeStdout("NT4 listening on 5810");
				await waitFor(
					() =>
						app.runs.getWorkspaceSnapshot(workspace.id).status === "running",
				);

				const initialSnapshot = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);
				expect(initialSnapshot.status).toBe(200);
				await waitFor(
					() =>
						sockets.length === 1 && sockets[0]?.readyState === WebSocket.OPEN,
				);

				const firstSelect = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-chooser", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({
							key: "SmartDashboard/Auto Choices",
							selected: "Score",
						}),
					}),
				);
				expect(firstSelect.status).toBe(200);
				sockets[0]?.close();

				const reconnectSnapshot = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-choosers", {
						headers: { cookie },
					}),
				);
				expect(reconnectSnapshot.status).toBe(200);
				await waitFor(
					() =>
						sockets.length === 2 && sockets[1]?.readyState === WebSocket.OPEN,
				);

				const secondSelect = await app.fetch(
					new Request("http://localhost/u/alice/api/sim/auto-chooser", {
						method: "PATCH",
						headers: { cookie, "content-type": "application/json" },
						body: JSON.stringify({
							key: "SmartDashboard/Auto Choices",
							selected: "Score",
						}),
					}),
				);
				expect(secondSelect.status).toBe(200);
				const secondTextMessages = sockets[1]!.sent.filter(
					(data): data is string => typeof data === "string",
				);
				expect(
					secondTextMessages.some(
						(raw) =>
							raw.includes('"publish"') &&
							raw.includes("/SmartDashboard/Auto Choices/selected"),
					),
				).toBe(true);
				app.runs.stopWorkspace(workspace.id);
			},
			{
				dockerRunner: fakeDocker.runner,
				runCommandFactory: controlled.commandFactory,
				nt4AutoWebSocketFactory: () => {
					const socket = new FakeWebSocket();
					sockets.push(socket);
					queueMicrotask(() => {
						socket.open();
						announceChooser(socket);
					});
					return socket as unknown as WebSocket;
				},
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 26080, end: 26089 },
				vscodePortRange: { start: 33380, end: 33389 },
				halsimPortRange: { start: 34380, end: 34389 },
			},
		);
	});
});
