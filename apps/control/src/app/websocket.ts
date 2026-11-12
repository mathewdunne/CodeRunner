import {
	gamepadClientMessageSchema,
	type ImportServerMessage,
	importRequestSchema,
	lessonLoadRequestSchema,
	runClientMessageSchema,
	type WorkspaceId,
} from "@frc-coderunner/contracts";
import { type CatalogSource, RemoteCatalogSource } from "../catalog";
import { upstreamEndpoints } from "../containers/converters";
import type { GamepadLease, GamepadSessions } from "../gamepad";
import type { HalSimBridge } from "../halsim";
import {
	ImportError,
	type ImportManager,
	parseGitHubUrl,
	RateLimitError,
} from "../imports";
import { getLogger } from "../logging";
import type { Nt4AutoChooserBridge } from "../nt4-auto";
import type { RunManager } from "../runs";
import type { WorkspaceRuntimeProvider } from "../runtime";
import type { AppStorage } from "../storage";
import { sendUpstreamWebSocketMessage } from "./proxy";
import { autoChoosersSnapshot, simStatusSnapshot } from "./status";
import {
	type AppSocket,
	PROXY_PENDING_LIMIT,
	type RunSocketData,
} from "./types";

const log = getLogger("ws");

// How often a run socket re-reads sim status and auto choosers. The browser
// used to poll both over HTTP at this rate; pushing them over the run socket
// keeps the same freshness without a proxied request per poll (decision 047).
export const SIM_SNAPSHOT_PUSH_INTERVAL_MS = 1_000;

export type WebSocketHandlerContext = {
	storage: AppStorage;
	runtimeProvider: WorkspaceRuntimeProvider;
	runs: RunManager;
	halsim: HalSimBridge;
	nt4Auto: Nt4AutoChooserBridge;
	gamepad: GamepadSessions;
	imports: ImportManager;
	catalogSource: CatalogSource;
};

function socketMessageText(message: string | ArrayBuffer | Uint8Array): string {
	if (typeof message === "string") {
		return message;
	}
	return new TextDecoder().decode(message);
}

export function createWebSocketHandlers(ctx: WebSocketHandlerContext) {
	const {
		storage,
		runtimeProvider,
		runs,
		halsim,
		nt4Auto,
		gamepad,
		imports,
		catalogSource,
	} = ctx;

	// Stop the active run and disconnect all sim state before a destructive
	// project swap (D12).
	const stopActiveRun = (workspaceId: WorkspaceId): void => {
		runs.stopWorkspace(workspaceId);
		halsim.disconnect(workspaceId);
		nt4Auto.disconnect(workspaceId);
		gamepad.reset(workspaceId);
	};

	// Workspace-scoped sockets trust the workspace they were authenticated
	// with, so ending the session (Leave, classroom end, user deletion) must
	// close them or a later message could start a run without a session.
	const workspaceSockets = new Map<WorkspaceId, Set<AppSocket>>();

	const closeWorkspaceSockets = (workspaceId: WorkspaceId): void => {
		const sockets = workspaceSockets.get(workspaceId);
		if (!sockets) return;
		workspaceSockets.delete(workspaceId);
		for (const ws of sockets) {
			try {
				ws.close(1008, "Session ended.");
			} catch {}
		}
	};

	const resolveGamepadLease = (
		workspaceId: WorkspaceId,
	): GamepadLease | null => {
		const snapshot = runs.getWorkspaceSnapshot(workspaceId);
		if (snapshot.status !== "running") return null;
		const workspace = storage.findWorkspaceById(workspaceId);
		if (!workspace) return null;
		const lease = storage.getContainerLease(workspaceId);
		const { endpoints } = upstreamEndpoints(
			storage.config.containerNetwork,
			workspace,
			lease,
		);
		if (!endpoints.halsim) return null;
		return { halsimUrl: endpoints.halsim.wsUrl };
	};

	const sendSnapshotIfChanged = (
		ws: AppSocket,
		data: RunSocketData,
		message: { type: "sim-status" | "auto-choosers"; status: unknown },
	): void => {
		const text = JSON.stringify(message);
		if (data.lastSnapshots?.get(message.type) === text) return;
		data.lastSnapshots?.set(message.type, text);
		try {
			ws.send(text);
		} catch {}
	};

	// Each tick runs the same snapshot code as GET /api/sim/status and
	// /api/sim/auto-choosers, including their bridge (re)connect side effects.
	const pushSimSnapshots = async (
		ws: AppSocket,
		data: RunSocketData,
	): Promise<void> => {
		if (data.snapshotInFlight) return;
		data.snapshotInFlight = true;
		try {
			const read = async <T>(
				label: string,
				snapshot: () => Promise<T>,
			): Promise<T | null> => {
				try {
					return await snapshot();
				} catch (error) {
					log.debug("sim snapshot push failed", {
						label,
						workspaceId: data.workspace.id,
						err: error instanceof Error ? error.message : String(error),
					});
					return null;
				}
			};
			const simStatus = await read("sim-status", () =>
				simStatusSnapshot(
					storage,
					runtimeProvider,
					runs,
					halsim,
					gamepad,
					data,
				),
			);
			const autoChoosers = await read("auto-choosers", () =>
				autoChoosersSnapshot(storage, runtimeProvider, runs, nt4Auto, data),
			);
			// The socket may have closed while the snapshots were being read.
			if (data.snapshotTimer === undefined) return;
			sendSnapshotIfChanged(ws, data, {
				type: "sim-status",
				status: simStatus,
			});
			sendSnapshotIfChanged(ws, data, {
				type: "auto-choosers",
				status: autoChoosers,
			});
		} finally {
			data.snapshotInFlight = false;
		}
	};

	const pushingSockets = new Set<RunSocketData>();

	const startSnapshotPush = (ws: AppSocket, data: RunSocketData): void => {
		pushingSockets.add(data);
		data.lastSnapshots = new Map();
		data.snapshotTimer = setInterval(
			() => void pushSimSnapshots(ws, data),
			SIM_SNAPSHOT_PUSH_INTERVAL_MS,
		);
		void pushSimSnapshots(ws, data);
	};

	const stopSnapshotPush = (data: RunSocketData): void => {
		pushingSockets.delete(data);
		if (data.snapshotTimer !== undefined) {
			clearInterval(data.snapshotTimer);
			data.snapshotTimer = undefined;
		}
	};

	function openProxyUpstream(
		ws: AppSocket,
		label: "NT4" | "VSCode" | "HALSim",
		protocols: string[] | undefined,
	): void {
		if (
			ws.data.kind !== "nt4" &&
			ws.data.kind !== "vscode" &&
			ws.data.kind !== "halsim"
		) {
			return;
		}
		const upstreamUrl = ws.data.upstreamUrl;
		const upstream = new WebSocket(
			upstreamUrl,
			protocols && protocols.length > 0 ? protocols : undefined,
		);
		ws.data.upstream = upstream;
		upstream.binaryType = "arraybuffer";

		upstream.addEventListener("open", () => {
			if (
				ws.data.kind !== "nt4" &&
				ws.data.kind !== "vscode" &&
				ws.data.kind !== "halsim"
			) {
				return;
			}
			// The browser was told (in the upgrade handshake) that we picked
			// protocols[0]. If upstream actually negotiated something else, the
			// browser believes a protocol that the upstream isn't speaking. Close
			// with 1002 (protocol error) so AS Lite reconnects rather than silently
			// talking past the sim.
			if (
				protocols &&
				protocols.length > 0 &&
				upstream.protocol &&
				upstream.protocol !== protocols[0]
			) {
				log.warn("upstream subprotocol mismatch", {
					label,
					browserExpected: protocols[0],
					upstreamChose: upstream.protocol,
				});
				ws.close(1002, `${label} subprotocol mismatch.`);
				upstream.close();
				return;
			}
			log.debug("ws upstream open", { label, url: upstreamUrl });
			ws.data.upstreamOpen = true;
			for (const message of ws.data.pendingMessages.splice(0)) {
				sendUpstreamWebSocketMessage(upstream, message);
			}
		});
		upstream.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				ws.send(event.data);
			} else if (event.data instanceof ArrayBuffer) {
				ws.send(event.data);
			} else if (event.data instanceof Uint8Array) {
				ws.send(event.data);
			}
		});
		upstream.addEventListener("close", (event) => {
			log.debug("ws upstream close", {
				label,
				code: event.code,
				reason: event.reason,
			});
			ws.close(event.code || 1011, event.reason || `${label} upstream closed.`);
		});
		upstream.addEventListener("error", () => {
			log.warn("ws upstream error", { label, url: upstreamUrl });
			ws.close(1011, `${label} upstream error.`);
		});
	}

	return {
		closeWorkspaceSockets,
		/** Stop every run socket's snapshot timer (app shutdown). */
		stopSnapshotPushes(): void {
			for (const data of [...pushingSockets]) stopSnapshotPush(data);
		},
		open(ws: AppSocket): void {
			log.debug("ws open", {
				kind: ws.data.kind,
				workspaceId: "workspace" in ws.data ? ws.data.workspace.id : null,
			});
			if ("workspace" in ws.data) {
				const workspaceId = ws.data.workspace.id;
				let sockets = workspaceSockets.get(workspaceId);
				if (!sockets) {
					sockets = new Set();
					workspaceSockets.set(workspaceId, sockets);
				}
				sockets.add(ws);
			}
			if (ws.data.kind === "nt4") {
				openProxyUpstream(ws, "NT4", ws.data.protocols);
				return;
			}
			if (ws.data.kind === "vscode") {
				openProxyUpstream(ws, "VSCode", ws.data.protocols);
				return;
			}
			if (ws.data.kind === "halsim") {
				openProxyUpstream(ws, "HALSim", ws.data.protocols);
				return;
			}
			if (ws.data.kind === "import" || ws.data.kind === "lesson-load") {
				// WS is open; the client sends a request message to start the load.
				return;
			}
			if (ws.data.kind === "gamepad") {
				ws.send(JSON.stringify({ type: "hello" }));
				return;
			}
			ws.data.connection = runs.connect(ws.data.workspace, (message) => {
				ws.send(JSON.stringify(message));
			});
			startSnapshotPush(ws, ws.data);
		},
		message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void {
			if (
				ws.data.kind === "nt4" ||
				ws.data.kind === "vscode" ||
				ws.data.kind === "halsim"
			) {
				if (ws.data.upstreamOpen && ws.data.upstream) {
					sendUpstreamWebSocketMessage(ws.data.upstream, message);
				} else {
					if (ws.data.pendingMessages.length >= PROXY_PENDING_LIMIT) {
						ws.close(1013, "Upstream is not ready; please retry.");
						return;
					}
					ws.data.pendingMessages.push(message);
				}
				return;
			}

			if (ws.data.kind === "gamepad") {
				try {
					const parsed = gamepadClientMessageSchema.parse(
						JSON.parse(socketMessageText(message)),
					);
					const outcome = gamepad.handleMessage(
						ws.data.workspace.id,
						parsed,
						resolveGamepadLease,
					);
					if (outcome === "no-lease") {
						ws.send(
							JSON.stringify({
								type: "error",
								message: "Simulator is not running.",
							}),
						);
					} else if (outcome === "halsim-unavailable") {
						ws.send(JSON.stringify({ type: "halsim-disconnected" }));
					}
				} catch (error) {
					const detail =
						error instanceof Error ? error.message : "Invalid gamepad message.";
					log.warn("invalid gamepad message", {
						workspaceId: ws.data.workspace.id,
						err: error instanceof Error ? error : new Error(detail),
					});
					try {
						ws.send(JSON.stringify({ type: "error", message: detail }));
					} catch {}
				}
				return;
			}

			if (ws.data.kind === "import") {
				const { workspace, userId } = ws.data;
				try {
					const parsed = importRequestSchema.parse(
						JSON.parse(socketMessageText(message)),
					);
					const { cloneUrl } = parseGitHubUrl(parsed.url);
					const send = (msg: ImportServerMessage) => {
						try {
							ws.send(JSON.stringify(msg));
						} catch {}
					};
					// Stop the active run before wiping project files (D12).
					stopActiveRun(workspace.id);
					void imports
						.run({
							source: "github",
							workspace,
							userId,
							cloneUrl,
							send,
						})
						.catch((error) => {
							const detail =
								error instanceof Error ? error.message : "Import failed.";
							log.warn("import request failed before start", {
								workspaceId: workspace.id,
								err: error instanceof Error ? error : new Error(detail),
							});
							send({ type: "error", message: detail });
						})
						.finally(() => {
							try {
								ws.close(1000, "Import finished.");
							} catch {}
						});
				} catch (error) {
					if (error instanceof RateLimitError) {
						log.warn("import rate limited", {
							workspaceId: workspace.id,
							err: error,
						});
						ws.send(JSON.stringify({ type: "error", message: error.message }));
						ws.close(1000, "Rate limited.");
						return;
					}
					const detail =
						error instanceof Error ? error.message : "Invalid import request.";
					log.warn("invalid import request", {
						workspaceId: workspace.id,
						err: error instanceof Error ? error : new Error(detail),
					});
					ws.send(JSON.stringify({ type: "error", message: detail }));
					ws.close(1000, "Invalid request.");
				}
				return;
			}

			if (ws.data.kind === "lesson-load") {
				const { workspace, userId } = ws.data;
				const send = (msg: ImportServerMessage) => {
					try {
						ws.send(JSON.stringify(msg));
					} catch {}
				};
				void (async () => {
					try {
						const parsed = lessonLoadRequestSchema.parse(
							JSON.parse(socketMessageText(message)),
						);
						const module = await catalogSource.resolveModule(parsed.moduleId);
						const remote =
							catalogSource instanceof RemoteCatalogSource
								? {
										cloneUrl: catalogSource.cloneUrl,
										branch: catalogSource.branchName,
									}
								: null;
						// Stop the active run before wiping project files (D12).
						stopActiveRun(workspace.id);
						await imports.run({
							source: "catalog",
							workspace,
							userId,
							moduleId: module.id,
							subdir: module.subdir,
							kind: module.kind,
							remote,
							send,
						});
					} catch (error) {
						const detail =
							error instanceof ImportError
								? error.message
								: error instanceof Error
									? error.message
									: "Invalid lesson load request.";
						log.warn("invalid lesson load request", {
							workspaceId: workspace.id,
							err: error instanceof Error ? error : new Error(detail),
						});
						send({ type: "error", message: detail });
					} finally {
						try {
							ws.close(1000, "Lesson load finished.");
						} catch {}
					}
				})();
				return;
			}

			try {
				const parsed = runClientMessageSchema.parse(
					JSON.parse(socketMessageText(message)),
				);
				if (parsed.type === "start") {
					halsim.disconnect(ws.data.workspace.id);
					nt4Auto.disconnect(ws.data.workspace.id);
					const runId = runs.start(ws.data.workspace, ws.data.connection);
					log.info("run start requested", {
						workspaceId: ws.data.workspace.id,
						runId,
					});
					ws.send(JSON.stringify({ type: "hello", runId }));
				} else if (parsed.type === "stop") {
					log.info("run stop requested", { workspaceId: ws.data.workspace.id });
					halsim.disconnect(ws.data.workspace.id);
					nt4Auto.disconnect(ws.data.workspace.id);
					runs.stopWorkspace(ws.data.workspace.id);
				}
				// ping: no-op keepalive, no state change
			} catch (error) {
				const detail =
					error instanceof Error ? error.message : "Invalid run message.";
				log.warn("invalid run message", {
					workspaceId: ws.data.workspace.id,
					err: error instanceof Error ? error : new Error(detail),
				});
				ws.send(JSON.stringify({ type: "error", message: detail }));
			}
		},
		close(ws: AppSocket): void {
			log.debug("ws close", {
				kind: ws.data.kind,
				workspaceId: "workspace" in ws.data ? ws.data.workspace.id : null,
			});
			if ("workspace" in ws.data) {
				const workspaceId = ws.data.workspace.id;
				const sockets = workspaceSockets.get(workspaceId);
				sockets?.delete(ws);
				if (sockets?.size === 0) workspaceSockets.delete(workspaceId);
			}
			if (
				ws.data.kind === "nt4" ||
				ws.data.kind === "vscode" ||
				ws.data.kind === "halsim"
			) {
				ws.data.upstream?.close();
				ws.data.pendingMessages.length = 0;
				return;
			}

			if (ws.data.kind === "import" || ws.data.kind === "lesson-load") {
				// WS closed — job will finish/fail on its own
				return;
			}

			if (ws.data.kind === "gamepad") {
				gamepad.closeSession(ws.data.workspace.id, resolveGamepadLease);
				return;
			}

			stopSnapshotPush(ws.data);
			if (ws.data.connection) {
				runs.disconnect(ws.data.connection);
			}
		},
	};
}
