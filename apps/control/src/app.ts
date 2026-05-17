import type { AuthProvidersResponse } from "@frc-sim/contracts";
import { handleAdminRoute } from "./app/admin-routes";
import {
	handleUploadAsset,
	scopeResponse,
	userAssetsPath,
	webAssetResponse,
	webShellResponse,
} from "./app/assets";
import { jsonResponse, notFound, redirect } from "./app/responses";
import { openApiResponse } from "./app/status";
import type {
	AppSocket,
	BunUpgradeServer,
	ControlApp,
	ControlAppOptions,
} from "./app/types";
import { createWebSocketHandlers } from "./app/websocket";
import { handleWorkspaceRoute } from "./app/workspace-routes";
import { getSessionFromRequest, requireAdmin } from "./auth/middleware";
import { getEnabledAuthProviders } from "./auth/providers";
import { LocalDockerRuntimeProvider } from "./containers";
import { GamepadSessions } from "./gamepad";
import { HalSimBridge } from "./halsim";
import { IdleManager } from "./idle";
import { ImportManager } from "./imports";
import { getLogger } from "./logging";
import {
	httpRequestDuration,
	httpRequestsInFlight,
	idleSweepStopsTotal,
	renderMetrics,
	statusClass,
	templateRoute,
} from "./metrics";
import { DockerStatsPoller } from "./metrics-collector";
import { Nt4AutoChooserBridge } from "./nt4-auto";
import { RunManager } from "./runs";
import { createStorage } from "./storage";

const bootLog = getLogger("boot");
const httpLog = getLogger("http");
const idleLog = getLogger("idle");

// Frontend polls these every ~1s; logging each response would drown out useful events.
const NOISY_WORKSPACE_PATH =
	/^\/u\/[^/]+\/(sim\/alive|api\/sim\/(status|auto-choosers))$/u;

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i += 1) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

async function authorizeMetrics(
	storage: Awaited<ReturnType<typeof createStorage>>,
	request: Request,
): Promise<Response | null> {
	const token =
		(typeof Bun !== "undefined"
			? Bun.env.METRICS_TOKEN
			: process.env.METRICS_TOKEN) ?? "";
	if (token) {
		const header = request.headers.get("authorization") ?? "";
		const match = /^Bearer\s+(.+)$/u.exec(header);
		if (match && constantTimeEqual(match[1] ?? "", token)) {
			return null;
		}
		return new Response("Unauthorized", { status: 401 });
	}
	const adminResult = await requireAdmin(storage.auth, storage, request);
	if (adminResult instanceof Response) {
		return adminResult;
	}
	return null;
}

export { stripHopByHopHeaders } from "./app/proxy";
export type {
	AppSocket,
	BunUpgradeServer,
	ControlApp,
	ControlAppOptions,
} from "./app/types";

export async function createApp(
	configInput: ControlAppOptions = {},
): Promise<ControlApp> {
	const {
		runtimeProvider: configuredRuntimeProvider,
		dockerRunner,
		portAvailable,
		upstreamFetch: configuredUpstreamFetch,
		runCommandFactory,
		halsimWebSocketFactory,
		nt4AutoWebSocketFactory,
		...storageConfig
	} = configInput;
	const upstreamFetch = configuredUpstreamFetch ?? globalThis.fetch;
	const storage = await createStorage(storageConfig);
	const runtimeProvider =
		configuredRuntimeProvider ??
		new LocalDockerRuntimeProvider(storage, { dockerRunner, portAvailable });
	const containers = runtimeProvider as LocalDockerRuntimeProvider;
	const halsim = new HalSimBridge(
		halsimWebSocketFactory ? { webSocketFactory: halsimWebSocketFactory } : {},
	);
	const gamepad = new GamepadSessions(halsim);
	const nt4Auto = new Nt4AutoChooserBridge(
		nt4AutoWebSocketFactory
			? { webSocketFactory: nt4AutoWebSocketFactory }
			: {},
	);
	const runs = new RunManager(storage, runtimeProvider, {
		commandFactory: runCommandFactory,
	});
	const orphanedRuns = runs.reconcileOrphanedRuns();
	if (orphanedRuns > 0) {
		bootLog.info("reconciled orphaned simulation runs", {
			count: orphanedRuns,
		});
	} else {
		bootLog.debug("no orphaned runs to reconcile");
	}

	const imports = new ImportManager(storage, runtimeProvider);
	const idle = new IdleManager({
		storage,
		runtimeProvider,
		onStop: (workspaceId) => {
			halsim.disconnect(workspaceId);
			nt4Auto.disconnect(workspaceId);
			gamepad.reset(workspaceId);
			idleSweepStopsTotal.inc();
			idleLog.info("idle sweep stopped workspace", { workspaceId });
		},
	});
	idle.start();
	const dockerStatsPoller = new DockerStatsPoller({ containers });
	dockerStatsPoller.start();

	const adminCtx = { storage, runs, runtimeProvider };
	const workspaceCtx = {
		storage,
		runs,
		runtimeProvider,
		halsim,
		gamepad,
		nt4Auto,
		upstreamFetch,
	};

	async function fetch(
		request: Request,
		server?: BunUpgradeServer,
	): Promise<Response> {
		const url = new URL(request.url);
		const start = performance.now();
		const route = templateRoute(url.pathname);
		httpRequestsInFlight.inc();
		let response: Response;
		let observedStatus: number;
		try {
			response = await dispatch(request, server, url);
			observedStatus = response.status;
		} catch (err) {
			httpRequestsInFlight.dec();
			httpRequestDuration.observe(
				{ method: request.method, route, status_class: "5xx" },
				(performance.now() - start) / 1000,
			);
			httpLog.error("unhandled error in request dispatcher", {
				method: request.method,
				path: url.pathname,
				err: err instanceof Error ? err : new Error(String(err)),
			});
			throw err;
		}
		httpRequestsInFlight.dec();
		const durationSec = (performance.now() - start) / 1000;
		httpRequestDuration.observe(
			{
				method: request.method,
				route,
				status_class: statusClass(observedStatus),
			},
			durationSec,
		);
		const durationMs = Math.round(durationSec * 1000);
		const isNoisy =
			url.pathname === "/healthz" ||
			url.pathname.startsWith("/scope/") ||
			url.pathname.startsWith("/assets/") ||
			url.pathname === "/coderunner-icon.png" ||
			url.pathname === "/favicon.ico" ||
			NOISY_WORKSPACE_PATH.test(url.pathname);
		const fields = {
			method: request.method,
			path: url.pathname,
			status: response.status,
			durationMs,
		};
		if (isNoisy) {
			httpLog.trace("http", fields);
		} else if (response.status >= 500) {
			httpLog.error("http", fields);
		} else if (response.status >= 400) {
			httpLog.warn("http", fields);
		} else {
			httpLog.debug("http", fields);
		}
		return response;
	}

	async function dispatch(
		request: Request,
		server: BunUpgradeServer | undefined,
		url: URL,
	): Promise<Response> {
		if (url.pathname === "/healthz") {
			return Response.json({ ok: true, service: "control", version: "v2-3" });
		}

		if (url.pathname === "/api/openapi.json" && request.method === "GET") {
			return openApiResponse();
		}

		if (url.pathname === "/metrics" && request.method === "GET") {
			const authError = await authorizeMetrics(storage, request);
			if (authError) return authError;
			const { body, contentType } = await renderMetrics();
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": contentType,
					"cache-control": "no-store",
				},
			});
		}

		// --- AdvantageScope Lite: upload asset (POST, authenticated) ---
		if (url.pathname === "/scope/uploadAsset" && request.method === "POST") {
			return handleUploadAsset(storage, request);
		}

		if (
			(url.pathname === "/scope" || url.pathname.startsWith("/scope/")) &&
			request.method === "GET"
		) {
			// Resolve user assets dir from session (best-effort; unauthenticated users get bundled only)
			let scopeUserAssetsDir: string | undefined;
			const session = await getSessionFromRequest(storage.auth, request);
			if (session) {
				const workspace = storage.findWorkspaceByUserId(session.user.id);
				if (workspace) {
					scopeUserAssetsDir = userAssetsPath(workspace);
				}
			}
			return scopeResponse(storage, url.pathname, scopeUserAssetsDir);
		}

		if (url.pathname === "/api/auth/providers" && request.method === "GET") {
			return jsonResponse({
				providers: getEnabledAuthProviders(storage.config),
			} satisfies AuthProvidersResponse);
		}

		// --- Better Auth API routes ---
		if (url.pathname.startsWith("/api/auth/")) {
			return storage.auth.handler(request);
		}

		if (url.pathname === "/" && request.method === "GET") {
			const session = await getSessionFromRequest(storage.auth, request);
			if (session) {
				const workspace = storage.findWorkspaceByUserId(session.user.id);
				if (workspace) {
					return redirect(`/u/${workspace.slug}/`);
				}
			}
			return webShellResponse(storage);
		}

		if (url.pathname === "/login" && request.method === "GET") {
			return webShellResponse(storage);
		}

		// Serve the favicon from the site root for pages outside the /u/:slug/ scope
		// and for browsers that fall back to requesting /favicon.ico automatically.
		if (
			(url.pathname === "/coderunner-icon.png" ||
				url.pathname === "/favicon.ico") &&
			request.method === "GET"
		) {
			return webAssetResponse(storage, "coderunner-icon.png");
		}

		// Serve Vite-processed assets for pages outside /u/:slug/ (e.g. /login)
		if (url.pathname.startsWith("/assets/") && request.method === "GET") {
			return webAssetResponse(storage, url.pathname.slice(1));
		}

		// --- Default-deny: everything below requires a session (or admin token). ---
		// Public routes (healthz, scope, /api/auth/providers, other api/auth routes, /, /login,
		// /coderunner-icon.png, /assets/*) are handled above.
		// If we reach here without matching a gated route, we return 404.

		// --- Admin / operator routes ---
		if (url.pathname === "/admin") {
			const adminResult = await requireAdmin(storage.auth, storage, request);
			if (adminResult instanceof Response) {
				return adminResult;
			}
			return redirect("/admin/", { status: 308 });
		}

		if (url.pathname === "/admin/") {
			const adminResult = await requireAdmin(storage.auth, storage, request);
			if (adminResult instanceof Response) {
				return adminResult;
			}
			if (request.method === "GET") {
				return webShellResponse(storage);
			}
		}

		if (url.pathname.startsWith("/admin/")) {
			return handleAdminRoute(adminCtx, url, request);
		}

		const workspaceResponse = await handleWorkspaceRoute(
			workspaceCtx,
			url,
			request,
			server,
		);
		if (workspaceResponse) {
			return workspaceResponse;
		}

		return notFound();
	}

	const websocket = createWebSocketHandlers({
		storage,
		runs,
		halsim,
		nt4Auto,
		gamepad,
		imports,
	});

	return {
		fetch,
		websocket: websocket as {
			open(ws: AppSocket): void;
			message(ws: AppSocket, message: string | ArrayBuffer | Uint8Array): void;
			close(ws: AppSocket): void;
		},
		storage,
		runtime: runtimeProvider,
		containers,
		halsim,
		gamepad,
		nt4Auto,
		runs,
		imports,
		idle,
		close() {
			bootLog.info("shutting down");
			idle.stop();
			dockerStatsPoller.stop();
			halsim.close();
			nt4Auto.close();
			storage.close();
			bootLog.info("shutdown complete");
		},
	};
}
