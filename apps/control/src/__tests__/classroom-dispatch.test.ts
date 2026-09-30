import { describe, expect, test } from "bun:test";
import type { WorkspaceId } from "@frc-coderunner/contracts";
import type { ControlApp } from "../app";
import { createClassroom } from "../classrooms";
import {
	classroomJoinRequest,
	cookieFrom,
	login,
	sessionCookieFrom,
	withApp,
} from "./helpers";

function startClassroom(app: ControlApp) {
	return createClassroom(app.storage.db, {
		createdBy: "test-admin",
		durationMinutes: 240,
	});
}

/** Record stopWorkspace calls instead of talking to Docker. */
function spyOnStops(app: ControlApp): WorkspaceId[] {
	const stopped: WorkspaceId[] = [];
	app.runtime.stopWorkspace = async (workspaceId) => {
		stopped.push(workspaceId);
	};
	return stopped;
}

describe("classroom join dispatcher", () => {
	test("locks out one IP after 10 bad codes without affecting other IPs", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const attacker = { "x-forwarded-for": "203.0.113.5" };
			for (let i = 0; i < 10; i += 1) {
				const response = await app.fetch(
					classroomJoinRequest({ code: "000000", name: "Bot" }, attacker),
				);
				expect(response.status).toBe(404);
			}
			const blocked = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Bot" }, attacker),
			);
			expect(blocked.status).toBe(429);
			expect(await blocked.json()).toMatchObject({ code: "RATE_LIMITED" });

			const student = await app.fetch(
				classroomJoinRequest(
					{ code: classroom.code, name: "Alex" },
					{ "x-forwarded-for": "203.0.113.6" },
				),
			);
			expect(student.status).toBe(200);
		});
	});

	test("uses the rightmost X-Forwarded-For hop (the one our proxy appended)", async () => {
		await withApp(async (app) => {
			for (let i = 0; i < 10; i += 1) {
				await app.fetch(
					classroomJoinRequest(
						{ code: "000000", name: "Bot" },
						{ "x-forwarded-for": `198.51.100.${i}, 203.0.113.9` },
					),
				);
			}
			const blocked = await app.fetch(
				classroomJoinRequest(
					{ code: "000000", name: "Bot" },
					{ "x-forwarded-for": "198.51.100.200, 203.0.113.9" },
				),
			);
			expect(blocked.status).toBe(429);
		});
	});

	test("successful joins from one school IP are never rate limited", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const school = { "x-forwarded-for": "203.0.113.10" };
			for (let i = 0; i < 15; i += 1) {
				const response = await app.fetch(
					classroomJoinRequest(
						{ code: classroom.code, name: `Student ${i}` },
						school,
					),
				);
				expect(response.status).toBe(200);
			}
		});
	});

	test("joining over another guest's session retires it and stops that guest's container", async () => {
		await withApp(async (app) => {
			const stopped = spyOnStops(app);
			const classroom = startClassroom(app);
			const first = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex" }),
			);
			const firstBody = (await first.json()) as { userId: string };
			const firstCookie = sessionCookieFrom(first);
			const firstWorkspace = app.storage.findWorkspaceByUserId(
				firstBody.userId,
			);

			const second = await app.fetch(
				classroomJoinRequest(
					{ code: classroom.code, name: "Blake" },
					{ cookie: firstCookie },
				),
			);
			expect(second.status).toBe(200);

			expect(stopped).toEqual([firstWorkspace!.id]);
			const firstSessions = app.storage.db
				.query("SELECT COUNT(*) AS count FROM session WHERE userId = ?")
				.get(firstBody.userId) as { count: number };
			expect(firstSessions.count).toBe(0);
			// Alex's work is kept for a rejoin.
			expect(
				app.storage.findWorkspaceByUserId(firstBody.userId),
			).not.toBeNull();
		});
	});

	test("a failed stop of the previous guest's container still completes the join", async () => {
		await withApp(async (app) => {
			app.runtime.stopWorkspace = async () => {
				throw new Error("docker stop failed");
			};
			const classroom = startClassroom(app);
			const first = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex" }),
			);
			const second = await app.fetch(
				classroomJoinRequest(
					{ code: classroom.code, name: "Blake" },
					{ cookie: sessionCookieFrom(first) },
				),
			);
			expect(second.status).toBe(200);
			expect(sessionCookieFrom(second)).toMatch(/^coderunner_session=.+/u);
		});
	});

	test("a guest rejoining over their own session keeps their container", async () => {
		await withApp(async (app) => {
			const stopped = spyOnStops(app);
			const classroom = startClassroom(app);
			const first = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex" }),
			);
			const again = await app.fetch(
				classroomJoinRequest(
					{ code: classroom.code, name: "Alex", confirmExisting: true },
					{ cookie: sessionCookieFrom(first) },
				),
			);
			expect(again.status).toBe(200);
			expect(stopped).toEqual([]);
		});
	});

	test("joining from a coach's signed-in browser replaces the session but leaves the coach alone", async () => {
		await withApp(async (app) => {
			const stopped = spyOnStops(app);
			const coach = await login(app, "coach", { role: "admin" });
			const classroom = startClassroom(app);
			const response = await app.fetch(
				classroomJoinRequest(
					{ code: classroom.code, name: "Alex" },
					{ cookie: cookieFrom(coach) },
				),
			);
			expect(response.status).toBe(200);
			expect(stopped).toEqual([]);
			const coachRow = app.storage.db
				.query("SELECT role FROM user WHERE email = ?")
				.get("coach@test.local") as { role: string } | null;
			expect(coachRow?.role).toBe("admin");
		});
	});

	test("is disabled in demo mode", async () => {
		await withApp(
			async (app) => {
				const response = await app.fetch(
					classroomJoinRequest({ code: "123456", name: "Alex" }),
				);
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({ code: "DISABLED" });
			},
			{ demo: true },
		);
	});

	test("GET /join serves the web shell", async () => {
		await withApp(async (app) => {
			const response = await app.fetch(new Request("http://localhost/join"));
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("V2 test shell");
		});
	});
});
