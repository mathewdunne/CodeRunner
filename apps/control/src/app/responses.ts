import {
	type HeartbeatResponse,
	heartbeatRequestSchema,
	type SessionResponse,
} from "@frc-coderunner/contracts";
import { CapacityExceededError, type CodeContainerStatus } from "../containers";
import type { WorkspaceRuntime } from "../runtime";
import type { AppStorage, AuthContext } from "../storage";

export function htmlResponse(body: string, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "text/html; charset=utf-8");
	return new Response(body, { ...init, headers });
}

export function redirect(location: string, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("location", location);
	return new Response(null, { ...init, status: init.status ?? 303, headers });
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

export function sessionResponse(
	auth: AuthContext,
	options: {
		demo?: boolean;
		projectEmpty: boolean;
		guest?: { classroomEndsAt: string } | undefined;
	},
): SessionResponse {
	return {
		user: {
			id: auth.user.id,
			displayName: auth.user.name,
			email: auth.user.email,
			avatarUrl: auth.user.image,
			slug: auth.workspace.slug,
			role: auth.user.role as "student" | "admin",
			...(options.guest ? { guest: options.guest } : {}),
		},
		workspace: {
			id: auth.workspace.id,
			slug: auth.workspace.slug,
			currentModule: auth.workspace.current_module ?? null,
			currentModuleKind: auth.workspace.current_module_kind ?? null,
			projectEmpty: options.projectEmpty,
		},
		...(options.demo ? { demo: true } : {}),
	};
}

export function apiErrorResponse(error: unknown, fallback: string): Response {
	const message = error instanceof Error ? error.message : fallback;
	const maybeStatus =
		error instanceof Error
			? (error as Error & { status?: unknown }).status
			: undefined;
	const status = typeof maybeStatus === "number" ? maybeStatus : 500;
	return jsonResponse({ error: message }, { status });
}

export function codeStatusFromRuntime(
	runtime: WorkspaceRuntime,
): CodeContainerStatus {
	return {
		role: "code",
		state: runtime.state,
		image: runtime.image,
		containerName: runtime.runtimeName,
		// "Allocated" means the upstream endpoint is resolvable. In port mode the
		// endpoint exists iff a host port is leased; in network mode there are no
		// host ports and the endpoint exists iff the container is on the network.
		simPortAllocated: runtime.endpoints.nt4 !== null,
		vscodePortAllocated: runtime.endpoints.vscode !== null,
		halsimPortAllocated: runtime.endpoints.halsim !== null,
		lastUsedAt: runtime.lastUsedAt,
		error: runtime.error,
	};
}

export async function readHeartbeatRequest(
	request: Request,
	storage: AppStorage,
	auth: AuthContext,
): Promise<HeartbeatResponse> {
	const text = await request.text();
	const input = text.trim() ? JSON.parse(text) : {};
	const parsed = heartbeatRequestSchema.parse(input);
	storage.touchContainerLeaseActivity(auth.workspace.id);
	return { ok: true, closing: parsed.closing ?? false };
}

export function capacityErrorResponse(error: unknown): Response | null {
	if (error instanceof CapacityExceededError) {
		return jsonResponse(
			{ error: "capacity", limit: error.limit, current: error.current },
			{ status: 503 },
		);
	}
	return null;
}
