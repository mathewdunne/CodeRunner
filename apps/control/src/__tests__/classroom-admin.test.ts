import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import type { ControlApp } from "../app";
import { ClassroomSweeper } from "../classroom-sweeper";
import { createClassroom, getClassroom } from "../classrooms";
import { deleteUserAndWorkspace } from "../user-deletion";
import {
	classroomJoinRequest,
	cookieFrom,
	exists,
	login,
	sessionCookieFrom,
	withApp,
} from "./helpers";

type ClassroomView = {
	id: string;
	code: string;
	expiresAt: string;
	joinUrl: string;
	guests: { displayName: string; slug: string | null }[];
};

async function adminCookie(app: ControlApp): Promise<string> {
	return cookieFrom(await login(app, "coach", { role: "admin" }));
}

function adminRequest(
	cookie: string,
	path: string,
	init: { method?: string; body?: unknown } = {},
): Request {
	return new Request(`http://localhost${path}`, {
		method: init.method ?? "GET",
		headers: { cookie, "content-type": "application/json" },
		body: init.body === undefined ? null : JSON.stringify(init.body),
	});
}

async function joinGuest(app: ControlApp, code: string, name: string) {
	const response = await app.fetch(classroomJoinRequest({ code, name }));
	expect(response.status).toBe(200);
	return (await response.json()) as { userId: string };
}

function sweeperFor(app: ControlApp): ClassroomSweeper {
	return new ClassroomSweeper({
		storage: app.storage,
		deleteUser: (userId) =>
			deleteUserAndWorkspace(
				{ storage: app.storage, runs: app.runs, runtimeProvider: app.runtime },
				userId,
			),
	});
}

describe("admin classroom routes", () => {
	test("admin starts a classroom with the default 4 hours", async () => {
		await withApp(async (app) => {
			const cookie = await adminCookie(app);
			const before = Date.now();
			const response = await app.fetch(
				adminRequest(cookie, "/admin/classrooms", { method: "POST", body: {} }),
			);
			expect(response.status).toBe(201);
			const { classroom } = (await response.json()) as {
				classroom: ClassroomView;
			};
			expect(classroom.code).toMatch(/^\d{6}$/u);
			expect(classroom.joinUrl).toBe(
				`http://localhost:4000/join?code=${classroom.code}`,
			);
			const minutes =
				(new Date(classroom.expiresAt).getTime() - before) / 60_000;
			expect(minutes).toBeGreaterThan(239.9);
			expect(minutes).toBeLessThan(240.1);
			const audit = app.storage.db
				.query("SELECT COUNT(*) AS count FROM audit_log WHERE action = ?")
				.get("classroom.create") as { count: number };
			expect(audit.count).toBe(1);
		});
	});

	test("rejects durations outside 60–720 whole minutes", async () => {
		await withApp(async (app) => {
			const cookie = await adminCookie(app);
			for (const durationMinutes of [30, 721, 90.5, "240"]) {
				const response = await app.fetch(
					adminRequest(cookie, "/admin/classrooms", {
						method: "POST",
						body: { durationMinutes },
					}),
				);
				expect(response.status).toBe(400);
			}
		});
	});

	test("lists live classrooms with their guests", async () => {
		await withApp(async (app) => {
			const cookie = await adminCookie(app);
			const classroom = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			await joinGuest(app, classroom.code, "Alex D");
			const response = await app.fetch(
				adminRequest(cookie, "/admin/classrooms"),
			);
			expect(response.status).toBe(200);
			const { classrooms } = (await response.json()) as {
				classrooms: ClassroomView[];
			};
			expect(classrooms.map((c) => c.id)).toEqual([classroom.id]);
			expect(classrooms[0]?.guests).toMatchObject([
				{ displayName: "Alex D", slug: "alex-d" },
			]);
		});
	});

	test("End now deletes guests, their workspaces and files, and hides the classroom", async () => {
		await withApp(async (app) => {
			const cookie = await adminCookie(app);
			const classroom = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			const { userId } = await joinGuest(app, classroom.code, "Alex D");
			const workspace = app.storage.findWorkspaceByUserId(userId)!;
			expect(await exists(dirname(workspace.project_path))).toBe(true);

			const response = await app.fetch(
				adminRequest(cookie, `/admin/classrooms/${classroom.id}/end`, {
					method: "POST",
				}),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ ok: true, guestCount: 1 });

			const user = app.storage.db
				.query("SELECT id FROM user WHERE id = ?")
				.get(userId);
			expect(user).toBeNull();
			expect(app.storage.findWorkspaceByUserId(userId)).toBeNull();
			expect(await exists(dirname(workspace.project_path))).toBe(false);
			const row = getClassroom(app.storage.db, classroom.id);
			expect(row?.ended_at).not.toBeNull();
			expect(row?.cleaned_at).not.toBeNull();

			const list = await app.fetch(adminRequest(cookie, "/admin/classrooms"));
			expect(
				((await list.json()) as { classrooms: ClassroomView[] }).classrooms,
			).toEqual([]);
		});
	});

	test("ending an unknown classroom is a 404", async () => {
		await withApp(async (app) => {
			const cookie = await adminCookie(app);
			const response = await app.fetch(
				adminRequest(cookie, "/admin/classrooms/cls_nope/end", {
					method: "POST",
				}),
			);
			expect(response.status).toBe(404);
		});
	});

	test("students and classroom guests cannot use admin routes", async () => {
		await withApp(async (app) => {
			const student = cookieFrom(await login(app, "alice"));
			expect(
				(await app.fetch(adminRequest(student, "/admin/classrooms"))).status,
			).toBe(403);

			const classroom = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			const joined = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex" }),
			);
			const guest = sessionCookieFrom(joined);
			expect(
				(await app.fetch(adminRequest(guest, "/admin/classrooms"))).status,
			).toBe(403);
			expect(
				(await app.fetch(adminRequest(guest, "/admin/status"))).status,
			).toBe(403);
		});
	});
});

describe("ClassroomSweeper", () => {
	test("deletes guests of expired classrooms once, and leaves live ones alone", async () => {
		await withApp(async (app) => {
			const expired = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			const live = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			await joinGuest(app, expired.code, "Alex");
			await joinGuest(app, expired.code, "Blake");
			const keeper = await joinGuest(app, live.code, "Casey");
			app.storage.db
				.query("UPDATE classrooms SET expires_at = ? WHERE id = ?")
				.run(new Date(Date.now() - 1000).toISOString(), expired.id);

			const sweeper = sweeperFor(app);
			expect(await sweeper.sweep()).toEqual([expired.id]);
			const remaining = app.storage.db
				.query("SELECT id FROM user WHERE classroomId IS NOT NULL")
				.all() as { id: string }[];
			expect(remaining.map((row) => row.id)).toEqual([keeper.userId]);
			expect(
				getClassroom(app.storage.db, expired.id)?.cleaned_at,
			).not.toBeNull();

			expect(await sweeper.sweep()).toEqual([]);
			const audit = app.storage.db
				.query("SELECT metadata_json FROM audit_log WHERE action = ?")
				.all("classroom.cleanup") as { metadata_json: string }[];
			expect(audit.map((row) => JSON.parse(row.metadata_json))).toEqual([
				{ guestCount: 2 },
			]);
		});
	});

	test("skips a sweep while the previous one is still running", async () => {
		await withApp(async (app) => {
			const expired = createClassroom(app.storage.db, {
				createdBy: "x",
				durationMinutes: 60,
			});
			await joinGuest(app, expired.code, "Alex");
			app.storage.db
				.query("UPDATE classrooms SET expires_at = ? WHERE id = ?")
				.run(new Date(Date.now() - 1000).toISOString(), expired.id);

			let release = () => {};
			const deletes: string[] = [];
			const sweeper = new ClassroomSweeper({
				storage: app.storage,
				deleteUser: async (userId) => {
					deletes.push(userId);
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				},
			});
			const first = sweeper.sweep();
			expect(await sweeper.sweep()).toEqual([]);
			release();
			expect(await first).toEqual([expired.id]);
			expect(deletes.length).toBe(1);
		});
	});
});
