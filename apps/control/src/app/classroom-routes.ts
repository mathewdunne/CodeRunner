/**
 * Control-plane side of classroom join codes (decision 043).
 *
 * `handleClassroomJoin` wraps the Better Auth plugin endpoint with the parts
 * that need the socket IP or the runtime: the demo-mode gate, the
 * failed-attempt rate limit, and retiring the browser's previous session.
 */

import type { WorkspaceId } from "@frc-coderunner/contracts";
import { getSessionFromRequest } from "../auth/middleware";
import { type FailedAttemptLimiter, findGuestClassroom } from "../classrooms";
import { getLogger } from "../logging";
import type { AppStorage } from "../storage";
import { jsonResponse } from "./responses";
import type { BunUpgradeServer } from "./types";

const log = getLogger("classroom");

export type ClassroomJoinContext = {
	storage: AppStorage;
	limiter: FailedAttemptLimiter;
	stopWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
};

/**
 * Rightmost X-Forwarded-For hop — the address our Caddy front appended — else
 * the socket address. Spoofable without a proxy; the limiter's global bucket
 * covers that case.
 */
export function clientIp(
	request: Request,
	server: BunUpgradeServer | undefined,
): string {
	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const hops = forwarded
			.split(",")
			.map((hop) => hop.trim())
			.filter(Boolean);
		const last = hops.at(-1);
		if (last) return last;
	}
	return server?.requestIP?.(request)?.address ?? "unknown";
}

export async function handleClassroomJoin(
	ctx: ClassroomJoinContext,
	request: Request,
	server: BunUpgradeServer | undefined,
): Promise<Response> {
	const { storage, limiter } = ctx;
	if (storage.config.demo) {
		return jsonResponse(
			{
				code: "DISABLED",
				message: "Joining a classroom isn't available in demo mode.",
			},
			{ status: 404 },
		);
	}

	const ip = clientIp(request, server);
	if (limiter.isBlocked(ip)) {
		log.warn("classroom join rate limited", { ip });
		return jsonResponse(
			{
				code: "RATE_LIMITED",
				message: "Too many attempts. Wait a few minutes and try again.",
			},
			{ status: 429 },
		);
	}

	const previous = await getSessionFromRequest(storage, request);
	const response = await storage.auth.handler(request);

	if (response.status === 404) {
		limiter.recordFailure(ip);
		return response;
	}
	if (response.ok && previous) {
		const body = (await response
			.clone()
			.json()
			.catch(() => null)) as { userId?: string } | null;
		await retirePreviousSession(ctx, previous, body?.userId ?? null);
	}
	return response;
}

/**
 * The browser already held a session: delete it, and if it was a different
 * classroom guest (the previous student walked away without clicking Leave),
 * stop their container so the seat's capacity is freed. Their files are kept.
 */
async function retirePreviousSession(
	ctx: ClassroomJoinContext,
	previous: { user: { id: string }; session: { token: string } },
	newUserId: string | null,
): Promise<void> {
	const { storage } = ctx;
	storage.db
		.query("DELETE FROM session WHERE token = ?")
		.run(previous.session.token);
	if (previous.user.id === newUserId) return;
	if (!findGuestClassroom(storage.db, previous.user.id)) return;
	const workspace = storage.findWorkspaceByUserId(previous.user.id);
	if (!workspace) return;
	log.info("stopping previous guest's workspace", {
		userId: previous.user.id,
		workspaceId: workspace.id,
	});
	await ctx.stopWorkspace(workspace.id);
}
