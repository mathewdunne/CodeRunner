/**
 * Better Auth plugin for classroom join codes (decision 043).
 *
 * Modelled on Better Auth's built-in `anonymous` plugin — same internal
 * APIs, so guests hold ordinary Better Auth sessions and cookies — but it
 * finds an existing guest by (classroom, name) so a student can rejoin their
 * own workspace. Rate limiting and retiring the browser's previous session
 * happen in the control-plane dispatcher (app/classroom-routes.ts), which has
 * the socket IP and the runtime; this plugin has neither.
 */

import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { classroomJoinRequestSchema } from "@frc-coderunner/contracts";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { AuditEventInput } from "../audit";
import {
	findGuest,
	findLiveClassroomByCode,
	GUEST_EMAIL_DOMAIN,
	getClassroom,
	guestNameKey,
	isClassroomLive,
	normalizeDisplayName,
	reserveGuestSlot,
	trackClassroomJoin,
} from "../classrooms";
import { getLogger } from "../logging";

const log = getLogger("classroom");

export type ClassroomPluginOptions = {
	db: Database;
	ensureWorkspace: (userId: string, slug: string) => Promise<void>;
	audit: (event: AuditEventInput) => void;
};

export function classroomPlugin(options: ClassroomPluginOptions) {
	const { db } = options;
	return {
		id: "coderunner-classroom",
		endpoints: {
			joinClassroom: createAuthEndpoint(
				"/classroom/join",
				{ method: "POST" },
				async (ctx) => {
					const parsed = classroomJoinRequestSchema.safeParse(ctx.body);
					if (!parsed.success) {
						throw new APIError("BAD_REQUEST", {
							code: "INVALID_INPUT",
							message: "Enter the 6-digit classroom code and your name.",
						});
					}
					const displayName = normalizeDisplayName(parsed.data.name);
					if (!displayName) {
						throw new APIError("BAD_REQUEST", {
							code: "INVALID_INPUT",
							message:
								"Names can use letters, numbers, spaces, - ' and . (up to 40 characters).",
						});
					}

					const classroom = findLiveClassroomByCode(db, parsed.data.code);
					if (!classroom) {
						throw new APIError("NOT_FOUND", {
							code: "INVALID_CODE",
							message: "That code isn't valid or has expired.",
						});
					}

					// Registered in the same tick as the liveness check above, so cleanup
					// can wait for this join instead of missing the guest it creates.
					return trackClassroomJoin(classroom.id, async () => {
						const nameKey = guestNameKey(displayName);
						let guest = findGuest(db, classroom.id, nameKey);
						const rejoin = guest !== null;
						if (!guest) {
							const releaseSlot = reserveGuestSlot(db, classroom.id);
							if (!releaseSlot) {
								throw new APIError("FORBIDDEN", {
									code: "CLASSROOM_FULL",
									message: "This classroom is full. Ask your coach for help.",
								});
							}
							try {
								await ctx.context.internalAdapter.createUser({
									email: `guest-${randomBytes(12).toString("hex")}@${GUEST_EMAIL_DOMAIN}`,
									emailVerified: false,
									name: displayName,
									classroomId: classroom.id,
									guestNameKey: nameKey,
								});
							} catch (error) {
								// A concurrent join with the same name won the unique index
								// (idx_user_classroom_guest); treat it like an existing name.
								if (!findGuest(db, classroom.id, nameKey)) throw error;
								const winner = findGuest(db, classroom.id, nameKey);
								throw new APIError("CONFLICT", {
									code: "NAME_TAKEN",
									message: `${winner?.name ?? displayName} already joined this classroom.`,
									displayName: winner?.name ?? displayName,
								});
							} finally {
								releaseSlot();
							}
							guest = findGuest(db, classroom.id, nameKey);
							if (!guest) {
								throw new APIError("INTERNAL_SERVER_ERROR", {
									code: "JOIN_FAILED",
									message: "Couldn't create your guest account.",
								});
							}
						} else if (parsed.data.confirmExisting !== true) {
							throw new APIError("CONFLICT", {
								code: "NAME_TAKEN",
								message: `${guest.name} already joined this classroom.`,
								displayName: guest.name,
							});
						}

						// The classroom may have ended while the guest was created. Its
						// cleanup is waiting on this join and deletes the guest afterwards.
						const current = getClassroom(db, classroom.id);
						if (!current || !isClassroomLive(current)) {
							throw new APIError("NOT_FOUND", {
								code: "INVALID_CODE",
								message: "That code isn't valid or has expired.",
							});
						}

						try {
							await options.ensureWorkspace(guest.id, guest.slug ?? "student");
						} catch (error) {
							// The guest row stays; the classroom sweeper removes it at the end.
							log.error("classroom guest workspace setup failed", {
								classroomId: classroom.id,
								userId: guest.id,
								error: error instanceof Error ? error.message : String(error),
							});
							throw new APIError("INTERNAL_SERVER_ERROR", {
								code: "JOIN_FAILED",
								message: "Couldn't set up your workspace. Please try again.",
							});
						}

						// Read the user after ensureWorkspace: it can move the slug (e.g.
						// "student" → "student-1"), and the cookie cache must carry the final one.
						const user = await ctx.context.internalAdapter.findUserById(
							guest.id,
						);
						if (!user) {
							throw new APIError("INTERNAL_SERVER_ERROR", {
								code: "JOIN_FAILED",
								message: "Couldn't find your guest account.",
							});
						}

						// overrideAll=true so the classroom's end time wins over the global
						// 14-day session lifetime.
						const session = await ctx.context.internalAdapter.createSession(
							guest.id,
							false,
							{ expiresAt: new Date(classroom.expires_at) },
							true,
						);
						if (!session) {
							throw new APIError("INTERNAL_SERVER_ERROR", {
								code: "JOIN_FAILED",
								message: "Couldn't start your session.",
							});
						}
						await setSessionCookie(ctx, { session, user });

						log.info("classroom guest joined", {
							classroomId: classroom.id,
							userId: guest.id,
							rejoin,
						});
						options.audit({
							actor: { userId: guest.id, email: user.email },
							action: "classroom.guest_join",
							target: { kind: "classroom", id: classroom.id },
							metadata: { displayName: guest.name, rejoin },
						});
						return ctx.json({ ok: true, userId: guest.id });
					});
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
