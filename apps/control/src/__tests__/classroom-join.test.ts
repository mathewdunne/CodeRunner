import { describe, expect, test } from "bun:test";
import type { ControlApp } from "../app";
import {
	CLASSROOM_GUEST_CAP,
	createClassroom,
	endClassroom,
} from "../classrooms";
import { classroomJoinRequest, sessionCookieFrom, withApp } from "./helpers";

function startClassroom(app: ControlApp) {
	return createClassroom(app.storage.db, {
		createdBy: "test-admin",
		durationMinutes: 240,
	});
}

type GuestUser = {
	id: string;
	name: string;
	email: string;
	role: string;
	slug: string;
	classroomId: string;
	guestNameKey: string;
};

function guestsOf(app: ControlApp, classroomId: string): GuestUser[] {
	return app.storage.db
		.query(
			"SELECT id, name, email, role, slug, classroomId, guestNameKey FROM user WHERE classroomId = ?",
		)
		.all(classroomId) as GuestUser[];
}

describe("POST /api/auth/classroom/join", () => {
	test("creates a guest user, workspace, and a session that ends with the classroom", async () => {
		await withApp(async (app) => {
			// withApp starts with an empty allowlist, which blocks every OAuth
			// sign-in — a successful join proves guests bypass it.
			const classroom = startClassroom(app);
			const response = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "  Alex   D " }),
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { ok: boolean; userId: string };
			expect(body.ok).toBe(true);

			const [guest, ...rest] = guestsOf(app, classroom.id);
			expect(rest).toEqual([]);
			expect(guest?.id).toBe(body.userId);
			expect(guest?.name).toBe("Alex D");
			expect(guest?.email).toEndWith("@classroom.invalid");
			expect(guest?.role).toBe("student");
			expect(guest?.slug).toBe("alex-d");
			expect(guest?.guestNameKey).toBe("alexd");

			expect(app.storage.findWorkspaceByUserId(body.userId)?.slug).toBe(
				"alex-d",
			);

			const session = app.storage.db
				.query("SELECT expiresAt FROM session WHERE userId = ?")
				.get(body.userId) as { expiresAt: string };
			expect(
				Math.abs(
					new Date(session.expiresAt).getTime() -
						new Date(classroom.expires_at).getTime(),
				),
			).toBeLessThan(1000);

			const cookie = sessionCookieFrom(response);
			const sessionResponse = await app.fetch(
				new Request("http://localhost/u/alex-d/api/session", {
					headers: { cookie },
				}),
			);
			expect(sessionResponse.status).toBe(200);

			const audit = app.storage.db
				.query("SELECT action FROM audit_log WHERE action = ?")
				.all("classroom.guest_join");
			expect(audit.length).toBe(1);
		});
	});

	test("same name asks for confirmation, then reuses the same guest", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const first = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex D" }),
			);
			expect(first.status).toBe(200);

			const second = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "alex d." }),
			);
			expect(second.status).toBe(409);
			expect(await second.json()).toMatchObject({
				code: "NAME_TAKEN",
				displayName: "Alex D",
			});

			const third = await app.fetch(
				classroomJoinRequest({
					code: classroom.code,
					name: "alex d.",
					confirmExisting: true,
				}),
			);
			expect(third.status).toBe(200);

			const guests = guestsOf(app, classroom.id);
			expect(guests.length).toBe(1);
			const sessions = app.storage.db
				.query("SELECT COUNT(*) AS count FROM session WHERE userId = ?")
				.get(guests[0]?.id ?? "") as { count: number };
			expect(sessions.count).toBe(2);
		});
	});

	test("two simultaneous joins with the same name create exactly one guest", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const responses = await Promise.all([
				app.fetch(classroomJoinRequest({ code: classroom.code, name: "Sam" })),
				app.fetch(classroomJoinRequest({ code: classroom.code, name: "Sam" })),
			]);
			expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
			expect(guestsOf(app, classroom.id).length).toBe(1);
		});
	});

	test("a name with no Latin letters still gets a valid workspace slug", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const response = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "李雷" }),
			);
			expect(response.status).toBe(200);
			const [guest] = guestsOf(app, classroom.id);
			expect(guest?.guestNameKey).toBe("李雷");
			expect(guest?.slug).toMatch(/^student(-\d+)?$/u);
		});
	});

	test("many non-Latin names each get a distinct student slug", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			// More than the 16 numbered candidates (student, student-1 … student-15).
			const names = Array.from({ length: 18 }, (_, i) =>
				String.fromCodePoint(0x674e, 0x4e00 + i),
			);
			for (const name of names) {
				const response = await app.fetch(
					classroomJoinRequest({ code: classroom.code, name }),
				);
				expect(response.status).toBe(200);
			}
			const slugs = guestsOf(app, classroom.id).map((guest) => guest.slug);
			expect(slugs.length).toBe(names.length);
			for (const slug of slugs) expect(slug).toMatch(/^student(-\d+)?$/u);
			expect(new Set(slugs).size).toBe(names.length);
		});
	}, 30_000);

	test("unknown, expired, and ended codes are rejected the same way", async () => {
		await withApp(async (app) => {
			const unknown = await app.fetch(
				classroomJoinRequest({ code: "000000", name: "Alex" }),
			);
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toMatchObject({ code: "INVALID_CODE" });

			const expired = startClassroom(app);
			app.storage.db
				.query("UPDATE classrooms SET expires_at = ? WHERE id = ?")
				.run(new Date(Date.now() - 1000).toISOString(), expired.id);
			const expiredResponse = await app.fetch(
				classroomJoinRequest({ code: expired.code, name: "Alex" }),
			);
			expect(expiredResponse.status).toBe(404);

			const ended = startClassroom(app);
			endClassroom(app.storage.db, ended.id);
			const endedResponse = await app.fetch(
				classroomJoinRequest({ code: ended.code, name: "Alex" }),
			);
			expect(endedResponse.status).toBe(404);
		});
	});

	test("malformed input is a 400 with INVALID_INPUT", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			for (const body of [
				{ code: "12345", name: "Alex" },
				{ code: classroom.code, name: "" },
				{ code: classroom.code, name: "<script>" },
				{ code: classroom.code, name: "..." },
				{ name: "Alex" },
			]) {
				const response = await app.fetch(classroomJoinRequest(body));
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
			}
		});
	});

	test("a full classroom rejects new names but still lets existing guests rejoin", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			for (let i = 0; i < CLASSROOM_GUEST_CAP; i += 1) {
				const response = await app.fetch(
					classroomJoinRequest({ code: classroom.code, name: `Student ${i}` }),
				);
				expect(response.status).toBe(200);
			}
			const full = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "One More" }),
			);
			expect(full.status).toBe(403);
			expect(await full.json()).toMatchObject({ code: "CLASSROOM_FULL" });

			const rejoin = await app.fetch(
				classroomJoinRequest({
					code: classroom.code,
					name: "Student 0",
					confirmExisting: true,
				}),
			);
			expect(rejoin.status).toBe(200);
		});
		// 60 joins each create a workspace on disk; Bun's default is 5 s.
	}, 30_000);
});

describe("guest session lifetime", () => {
	async function joinedGuest(app: ControlApp) {
		const classroom = startClassroom(app);
		const response = await app.fetch(
			classroomJoinRequest({ code: classroom.code, name: "Alex D" }),
		);
		expect(response.status).toBe(200);
		return { classroom, cookie: sessionCookieFrom(response) };
	}

	function sessionStatus(app: ControlApp, cookie: string) {
		return app
			.fetch(
				new Request("http://localhost/u/alex-d/api/session", {
					headers: { cookie },
				}),
			)
			.then((response) => response.status);
	}

	test("ending the classroom signs the guest out immediately", async () => {
		await withApp(async (app) => {
			const { classroom, cookie } = await joinedGuest(app);
			expect(await sessionStatus(app, cookie)).toBe(200);
			endClassroom(app.storage.db, classroom.id);
			expect(await sessionStatus(app, cookie)).toBe(401);
		});
	});

	test("an expired classroom rejects the guest even if the session row was refreshed", async () => {
		await withApp(async (app) => {
			const { classroom, cookie } = await joinedGuest(app);
			// Simulate Better Auth's updateAge refresh pushing the session out.
			app.storage.db
				.query("UPDATE session SET expiresAt = ?")
				.run(new Date(Date.now() + 14 * 86_400_000).toISOString());
			app.storage.db
				.query("UPDATE classrooms SET expires_at = ? WHERE id = ?")
				.run(new Date(Date.now() - 1000).toISOString(), classroom.id);
			expect(await sessionStatus(app, cookie)).toBe(401);
		});
	});
});
