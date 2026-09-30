/**
 * Control-plane side of classroom join codes (decision 043).
 *
 * `handleClassroomJoin` wraps the Better Auth plugin endpoint with the parts
 * that need the socket IP or the runtime: the demo-mode gate, the
 * failed-attempt rate limit, and retiring the browser's previous session.
 */

import type { WorkspaceId } from "@frc-coderunner/contracts";
import { type AuditActor, recordAuditEvent } from "../audit";
import { getSessionFromRequest } from "../auth/middleware";
import { cleanupClassroom } from "../classroom-sweeper";
import {
	CLASSROOM_DEFAULT_MINUTES,
	CLASSROOM_MAX_MINUTES,
	CLASSROOM_MIN_MINUTES,
	type ClassroomRow,
	createClassroom,
	endClassroom,
	type FailedAttemptLimiter,
	findGuestClassroom,
	getClassroom,
	listClassroomGuests,
	listLiveClassrooms,
} from "../classrooms";
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
	try {
		await ctx.stopWorkspace(workspace.id);
	} catch (error) {
		// The new student is already signed in; the idle reaper is the backstop.
		log.warn("stopping previous guest's workspace failed", {
			userId: previous.user.id,
			workspaceId: workspace.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export type AdminClassroomContext = {
	storage: AppStorage;
	deleteUser: (userId: string) => Promise<void>;
};

function classroomView(storage: AppStorage, classroom: ClassroomRow) {
	return {
		id: classroom.id,
		code: classroom.code,
		createdAt: classroom.created_at,
		expiresAt: classroom.expires_at,
		joinUrl: new URL(
			`/join?code=${classroom.code}`,
			storage.config.baseUrl,
		).toString(),
		guests: listClassroomGuests(storage.db, classroom.id).map((guest) => ({
			id: guest.id,
			displayName: guest.name,
			slug: guest.slug,
			joinedAt: guest.createdAt,
			lastAccessedAt: guest.lastAccessedAt,
		})),
	};
}

/** Admin classroom routes. Caller has already passed requireAdmin. */
export async function handleAdminClassroomRoute(
	ctx: AdminClassroomContext,
	url: URL,
	request: Request,
	actor: AuditActor,
): Promise<Response | null> {
	const { storage } = ctx;

	if (url.pathname === "/admin/classrooms" && request.method === "GET") {
		return jsonResponse({
			ok: true,
			classrooms: listLiveClassrooms(storage.db).map((classroom) =>
				classroomView(storage, classroom),
			),
		});
	}

	if (url.pathname === "/admin/classrooms" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as {
			durationMinutes?: unknown;
		};
		const durationMinutes = body.durationMinutes ?? CLASSROOM_DEFAULT_MINUTES;
		if (
			typeof durationMinutes !== "number" ||
			!Number.isInteger(durationMinutes) ||
			durationMinutes < CLASSROOM_MIN_MINUTES ||
			durationMinutes > CLASSROOM_MAX_MINUTES
		) {
			return jsonResponse(
				{
					error: `durationMinutes must be a whole number from ${CLASSROOM_MIN_MINUTES} to ${CLASSROOM_MAX_MINUTES}.`,
				},
				{ status: 400 },
			);
		}
		const classroom = createClassroom(storage.db, {
			createdBy: actor.userId,
			durationMinutes,
		});
		recordAuditEvent(storage, {
			actor,
			action: "classroom.create",
			target: { kind: "classroom", id: classroom.id },
			metadata: { expiresAt: classroom.expires_at },
		});
		log.info("classroom started", {
			classroomId: classroom.id,
			expiresAt: classroom.expires_at,
		});
		return jsonResponse(
			{ ok: true, classroom: classroomView(storage, classroom) },
			{ status: 201 },
		);
	}

	const endMatch = /^\/admin\/classrooms\/([^/]+)\/end$/u.exec(url.pathname);
	if (endMatch && request.method === "POST") {
		const classroom = getClassroom(storage.db, endMatch[1] ?? "");
		if (!classroom) {
			return jsonResponse({ error: "Classroom not found." }, { status: 404 });
		}
		endClassroom(storage.db, classroom.id);
		const guestCount = await cleanupClassroom(
			storage.db,
			classroom.id,
			ctx.deleteUser,
		);
		recordAuditEvent(storage, {
			actor,
			action: "classroom.end",
			target: { kind: "classroom", id: classroom.id },
			metadata: { guestCount },
		});
		return jsonResponse({ ok: true, guestCount });
	}

	return null;
}
