import { readdir } from "node:fs/promises";
import {
	autoChooserPatchSchema,
	driverStationPatchSchema,
	importRequestSchema,
	lessonLoadRequestSchema,
	type SimRunCommandResponse,
	simRunCommandRequestSchema,
	type WorkspaceId,
	workspaceSlugSchema,
} from "@frc-coderunner/contracts";
import {
	requireWebSocketOrigin,
	requireWorkspaceOwnership,
} from "../auth/middleware";
import type { CatalogSource } from "../catalog";
import { findGuestClassroom } from "../classrooms";
import type { GamepadSessions } from "../gamepad";
import type { HalSimBridge } from "../halsim";
import { ImportError, parseGitHubUrl, RateLimitError } from "../imports";
import { getLogger } from "../logging";
import type { Nt4AutoChooserBridge } from "../nt4-auto";
import type { RunManager } from "../runs";
import type { WorkspaceRuntimeProvider } from "../runtime";
import type { AppStorage } from "../storage";
import { webAssetResponse, webShellResponse } from "./assets";
import {
	deployFileDeleteResponse,
	deployFilesSnapshotResponse,
	deployFileWriteResponse,
	parseDeployFilePath,
} from "./deploy-files";
import {
	PREVIEW_FILES_PREFIX,
	previewDocumentsResponse,
	previewFileResponse,
} from "./preview";
import {
	halsimWebSocketResponse,
	nt4AliveResponse,
	nt4WebSocketResponse,
	vscodeHttpProxyResponse,
	vscodeWebSocketResponse,
} from "./proxy";
import {
	apiErrorResponse,
	capacityErrorResponse,
	jsonResponse,
	readHeartbeatRequest,
	redirect,
	sessionResponse,
} from "./responses";
import {
	autoChoosersSnapshot,
	containersStatusResponse,
	simStatusResponse,
	simStatusSnapshot,
} from "./status";
import type {
	BunUpgradeServer,
	HttpFetch,
	ImportSocketData,
	LessonLoadSocketData,
	SocketData,
} from "./types";

const log = getLogger("workspace");

// Single entry point for every WebSocket upgrade in this file. It bakes in the
// origin/CSRF check so a new WS route cannot silently skip it — reviewers should
// reject any `server.upgrade(` call outside this helper.
function upgradeWebSocket(
	request: Request,
	server: BunUpgradeServer | undefined,
	baseUrl: string,
	data: SocketData,
): Response {
	if (
		!server ||
		request.headers.get("upgrade")?.toLowerCase() !== "websocket"
	) {
		return new Response("Expected WebSocket upgrade.", { status: 426 });
	}
	const originError = requireWebSocketOrigin(request, baseUrl);
	if (originError) {
		return originError;
	}
	const upgraded = server.upgrade(request, { data });
	if (!upgraded) {
		return new Response("WebSocket upgrade failed.", { status: 400 });
	}
	return undefined as unknown as Response;
}

export type WorkspaceRouteContext = {
	storage: AppStorage;
	runs: RunManager;
	runtimeProvider: WorkspaceRuntimeProvider;
	halsim: HalSimBridge;
	gamepad: GamepadSessions;
	nt4Auto: Nt4AutoChooserBridge;
	catalogSource: CatalogSource;
	upstreamFetch: HttpFetch;
	/** Stops a workspace's run and container; files are kept. */
	stopWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
};

export async function handleWorkspaceRoute(
	ctx: WorkspaceRouteContext,
	url: URL,
	request: Request,
	server: BunUpgradeServer | undefined,
): Promise<Response | null> {
	const workspaceMatch = /^\/u\/([^/]+)(\/.*)?$/.exec(url.pathname);
	if (!workspaceMatch) {
		return null;
	}

	const {
		storage,
		runs,
		runtimeProvider,
		halsim,
		gamepad,
		nt4Auto,
		catalogSource,
		upstreamFetch,
	} = ctx;
	const slug = workspaceMatch[1] ?? "";
	const suffix = workspaceMatch[2] ?? "";
	if (suffix === "") {
		return redirect(`/u/${slug}/`);
	}

	if (!workspaceSlugSchema.safeParse(slug).success) {
		return new Response("Invalid workspace slug.", { status: 400 });
	}

	// Older web bundles emitted a relative favicon path, which browsers resolve
	// under /u/:slug/. Serve the root icon here so those bundles keep working.
	if (
		(suffix === "/coderunner-icon.png" || suffix === "/favicon.ico") &&
		request.method === "GET"
	) {
		return webAssetResponse(storage, "coderunner-icon.png");
	}

	// --- Preview resources: token-authenticated, ahead of the cookie check ---
	//
	// This is the one workspace route that cannot use `requireWorkspaceOwnership`,
	// and it is deliberate rather than an oversight. Preview frames are sandboxed
	// without `allow-same-origin`, so the framed document has an opaque origin and
	// the browser drops the SameSite=Lax session cookie from every subresource and
	// in-frame navigation it makes; the cookie check would 401 every stylesheet,
	// script and report page link. The grant travels in the URL path instead — see
	// `preview-token.ts`. Read-only, GET-only, and the token is signed over the
	// workspace id, so it authorises exactly the tree its owner could already read.
	if (suffix.startsWith(PREVIEW_FILES_PREFIX)) {
		if (request.method !== "GET") {
			return jsonResponse({ error: "Method not allowed." }, { status: 405 });
		}
		const workspace = storage.findWorkspaceBySlug(slug);
		if (!workspace) {
			return jsonResponse({ error: "Not found." }, { status: 404 });
		}
		return previewFileResponse(
			storage.config.sessionSecret,
			workspace,
			url,
			suffix.slice(PREVIEW_FILES_PREFIX.length),
		);
	}

	const isApiRequest = suffix.startsWith("/api/");
	const auth = await requireWorkspaceOwnership(storage, request, slug);
	if (auth instanceof Response) {
		if (!isApiRequest && auth.status === 401) return redirect("/login");
		return auth;
	}

	if (suffix === "/" && request.method === "GET") {
		log.debug("workspace shell requested", {
			slug,
			workspaceId: auth.workspace.id,
		});
		if (storage.config.containerAutoStart) {
			void runtimeProvider
				.ensureWorkspaceRunning(auth.workspace.id)
				.catch((err: unknown) => {
					// Status endpoints expose startup failures; opening the shell should not block on runtime startup.
					log.warn("background ensureWorkspaceRunning failed", {
						workspaceId: auth.workspace.id,
						err: err instanceof Error ? err : new Error(String(err)),
					});
				});
		}
		return webShellResponse(storage);
	}

	if (suffix === "/ws/run" && request.method === "GET") {
		return upgradeWebSocket(request, server, storage.config.baseUrl, {
			kind: "run",
			workspace: auth.workspace,
		});
	}

	if (suffix === "/ws/gamepad" && request.method === "GET") {
		return upgradeWebSocket(request, server, storage.config.baseUrl, {
			kind: "gamepad",
			workspace: auth.workspace,
		});
	}

	if (suffix === "/sim/alive" && request.method === "GET") {
		try {
			return await nt4AliveResponse(
				storage,
				runtimeProvider,
				auth,
				upstreamFetch,
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Simulator not available.")
			);
		}
	}

	if (suffix === "/sim/nt4" && request.method === "GET") {
		try {
			return await nt4WebSocketResponse(
				storage,
				runtimeProvider,
				auth,
				request,
				server,
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Simulator not available.")
			);
		}
	}

	if (suffix === "/sim/halsim" && request.method === "GET") {
		try {
			return await halsimWebSocketResponse(
				storage,
				runtimeProvider,
				auth,
				request,
				server,
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Simulator not available.")
			);
		}
	}

	// --- Editor proxy: codium-server (VSCodium reh-web) ---
	// Match /vscode or /vscode/* (the suffix starts with /vscode).
	// The full URL path including /u/<slug>/vscode/ is passed through
	// unchanged because codium-server is launched with
	// --server-base-path /u/<slug>/vscode/.
	if (suffix === "/vscode" || suffix.startsWith("/vscode/")) {
		const fullPath = url.pathname + (url.search || "");
		try {
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				return await vscodeWebSocketResponse(
					storage,
					runtimeProvider,
					auth,
					request,
					fullPath,
					upstreamFetch,
					server,
				);
			}
			return await vscodeHttpProxyResponse(
				storage,
				runtimeProvider,
				auth,
				request,
				fullPath,
				upstreamFetch,
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Editor not available.")
			);
		}
	}

	if (suffix.startsWith("/assets/") && request.method === "GET") {
		return webAssetResponse(
			storage,
			`assets/${suffix.slice("/assets/".length)}`,
		);
	}

	if (suffix === "/api/session" && request.method === "GET") {
		let projectEmpty = true;
		try {
			projectEmpty = (await readdir(auth.workspace.project_path)).length === 0;
		} catch {
			// Treat an unreadable/missing project dir as empty (first-login state).
			projectEmpty = true;
		}
		const classroom = findGuestClassroom(storage.db, auth.user.id);
		return jsonResponse(
			sessionResponse(auth, {
				demo: storage.config.demo,
				projectEmpty,
				guest: classroom
					? { classroomEndsAt: classroom.expires_at }
					: undefined,
			}),
		);
	}

	if (suffix === "/api/containers/status" && request.method === "GET") {
		try {
			return await containersStatusResponse(runtimeProvider, auth);
		} catch (error) {
			return apiErrorResponse(error, "Unable to read container status.");
		}
	}

	if (suffix === "/api/sim/status" && request.method === "GET") {
		try {
			return await simStatusResponse(
				storage,
				runtimeProvider,
				runs,
				halsim,
				gamepad,
				auth,
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Unable to read simulation status.")
			);
		}
	}

	if (suffix === "/api/sim/auto-choosers" && request.method === "GET") {
		try {
			return jsonResponse(
				await autoChoosersSnapshot(
					storage,
					runtimeProvider,
					runs,
					nt4Auto,
					auth,
				),
			);
		} catch (error) {
			return (
				capacityErrorResponse(error) ??
				apiErrorResponse(error, "Unable to read auto choosers.")
			);
		}
	}

	if (suffix === "/api/sim/run" && request.method === "POST") {
		try {
			const parsed = simRunCommandRequestSchema.parse(await request.json());
			let runId: string | null = null;
			if (parsed.action === "stop") {
				runs.stopWorkspace(auth.workspace.id);
				halsim.disconnect(auth.workspace.id);
				nt4Auto.disconnect(auth.workspace.id);
				gamepad.reset(auth.workspace.id);
			} else {
				halsim.disconnect(auth.workspace.id);
				nt4Auto.disconnect(auth.workspace.id);
				gamepad.reset(auth.workspace.id);
				runId = runs.start(auth.workspace);
			}
			const snapshot = runs.getWorkspaceSnapshot(auth.workspace.id);
			const body: SimRunCommandResponse = {
				ok: true,
				action: parsed.action,
				runId: runId ?? snapshot.runId,
				status: snapshot.status,
			};
			return jsonResponse(body, {
				status: parsed.action === "stop" ? 200 : 202,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Invalid simulation run command.";
			return jsonResponse({ error: message }, { status: 400 });
		}
	}

	if (suffix === "/api/sim/driver-station" && request.method === "PATCH") {
		try {
			const patch = driverStationPatchSchema.parse(await request.json());
			const run = runs.getWorkspaceSnapshot(auth.workspace.id);
			if (run.status !== "running") {
				return jsonResponse(
					{ error: "Robot code is not running." },
					{ status: 409 },
				);
			}
			const runtime = await runtimeProvider.ensureWorkspaceRunning(
				auth.workspace.id,
			);
			if (runtime.state !== "running" || !runtime.endpoints.halsim) {
				return jsonResponse(
					{ error: runtime.error ?? "HALSim is not available." },
					{ status: 503 },
				);
			}
			halsim.applyDriverStationPatch(
				auth.workspace.id,
				runtime.endpoints.halsim.wsUrl,
				patch,
			);
			return jsonResponse(
				await simStatusSnapshot(
					storage,
					runtimeProvider,
					runs,
					halsim,
					gamepad,
					auth,
				),
			);
		} catch (error) {
			const status =
				error instanceof Error &&
				typeof (error as Error & { status?: unknown }).status === "number"
					? (error as Error & { status: number }).status
					: 400;
			const message =
				error instanceof Error
					? error.message
					: "Invalid Driver Station command.";
			return jsonResponse({ error: message }, { status });
		}
	}

	if (suffix === "/api/sim/auto-chooser" && request.method === "PATCH") {
		try {
			const patch = autoChooserPatchSchema.parse(await request.json());
			const run = runs.getWorkspaceSnapshot(auth.workspace.id);
			if (run.status !== "running") {
				return jsonResponse(
					{ error: "Robot code is not running." },
					{ status: 409 },
				);
			}
			const runtime = await runtimeProvider.ensureWorkspaceRunning(
				auth.workspace.id,
			);
			if (runtime.state !== "running" || !runtime.endpoints.nt4) {
				return jsonResponse(
					{ error: runtime.error ?? "NT4 is not available." },
					{ status: 503 },
				);
			}
			return jsonResponse(
				nt4Auto.select(auth.workspace.id, runtime.endpoints.nt4.wsUrl, patch),
			);
		} catch (error) {
			const status =
				error instanceof Error &&
				typeof (error as Error & { status?: unknown }).status === "number"
					? (error as Error & { status: number }).status
					: 400;
			const message =
				error instanceof Error
					? error.message
					: "Invalid auto chooser command.";
			return jsonResponse({ error: message }, { status });
		}
	}

	if (suffix === "/api/run" && request.method === "POST") {
		halsim.disconnect(auth.workspace.id);
		nt4Auto.disconnect(auth.workspace.id);
		gamepad.reset(auth.workspace.id);
		const runId = runs.start(auth.workspace);
		return jsonResponse({ ok: true, runId }, { status: 202 });
	}

	if (suffix === "/api/run/stop" && request.method === "POST") {
		halsim.disconnect(auth.workspace.id);
		nt4Auto.disconnect(auth.workspace.id);
		gamepad.reset(auth.workspace.id);
		return jsonResponse({
			ok: true,
			stopped: runs.stopWorkspace(auth.workspace.id),
		});
	}

	// --- Lesson catalog endpoints ---
	if (suffix === "/api/lessons" && request.method === "GET") {
		const { modules, error } = await catalogSource.getManifest();
		return jsonResponse({ ok: true, modules, error });
	}

	if (suffix === "/api/lessons/load" && request.method === "POST") {
		try {
			const parsed = lessonLoadRequestSchema.parse(await request.json());
			// Resolve only — the actual load streams over WS.
			await catalogSource.resolveModule(parsed.moduleId);
			return jsonResponse({ ok: true });
		} catch (error) {
			if (error instanceof ImportError) {
				return jsonResponse({ error: error.message }, { status: 404 });
			}
			const message =
				error instanceof Error ? error.message : "Invalid lesson load request.";
			return jsonResponse({ error: message }, { status: 400 });
		}
	}

	if (suffix === "/ws/lesson-load" && request.method === "GET") {
		return upgradeWebSocket(request, server, storage.config.baseUrl, {
			kind: "lesson-load",
			workspace: auth.workspace,
			userId: auth.user.id,
		} satisfies LessonLoadSocketData);
	}

	// --- Preview (project Markdown / HTML reader) ---
	// The document list is an ordinary same-origin fetch from the shell, so it
	// keeps the cookie check. Only `/api/preview/files/` needs the path token.
	if (suffix === "/api/preview/documents" && request.method === "GET") {
		return previewDocumentsResponse(
			storage.config.sessionSecret,
			auth.workspace,
		);
	}

	// --- Deploy files (PathPlanner) endpoints ---
	if (suffix === "/api/deploy-files/snapshot" && request.method === "GET") {
		return deployFilesSnapshotResponse(auth.workspace);
	}

	if (suffix.startsWith("/api/deploy-files/")) {
		const rawPath = suffix.slice("/api/deploy-files/".length);
		const filePath = parseDeployFilePath(rawPath);
		if (!filePath) {
			return jsonResponse(
				{ error: "Invalid deploy file path." },
				{ status: 400 },
			);
		}
		if (request.method === "PUT") {
			return deployFileWriteResponse(auth.workspace, filePath, request);
		}
		if (request.method === "DELETE") {
			return deployFileDeleteResponse(auth.workspace, filePath);
		}
		return jsonResponse({ error: "Method not allowed." }, { status: 405 });
	}

	// --- Import endpoints ---
	if (suffix === "/api/project/import" && request.method === "POST") {
		try {
			const body = await request.json();
			const parsed = importRequestSchema.parse(body);
			const { cloneUrl } = parseGitHubUrl(parsed.url);
			// Validate only — actual import runs via WS stream
			return jsonResponse({ ok: true, cloneUrl });
		} catch (error) {
			if (error instanceof ImportError) {
				return jsonResponse({ error: error.message }, { status: 400 });
			}
			if (error instanceof RateLimitError) {
				return jsonResponse({ error: error.message }, { status: 429 });
			}
			const message =
				error instanceof Error ? error.message : "Invalid import request.";
			return jsonResponse({ error: message }, { status: 400 });
		}
	}

	if (suffix === "/ws/import" && request.method === "GET") {
		return upgradeWebSocket(request, server, storage.config.baseUrl, {
			kind: "import",
			workspace: auth.workspace,
			userId: auth.user.id,
		} satisfies ImportSocketData);
	}

	// Classroom guests click "Leave" so the next student at the station gets a
	// container slot straight away instead of after the idle timeout.
	if (suffix === "/api/leave" && request.method === "POST") {
		await ctx.stopWorkspace(auth.workspace.id);
		log.info("workspace left", {
			slug,
			workspaceId: auth.workspace.id,
		});
		return jsonResponse({ ok: true });
	}

	if (suffix === "/api/heartbeat" && request.method === "POST") {
		try {
			return jsonResponse(await readHeartbeatRequest(request, storage, auth));
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid heartbeat request.";
			return jsonResponse({ error: message }, { status: 400 });
		}
	}

	return null;
}
