import { describe, expect, test } from "bun:test";
import {
	createClassroom,
	endClassroom,
	FailedAttemptLimiter,
	findLiveClassroomByCode,
	generateClassroomCode,
	getClassroom,
	guestNameKey,
	isClassroomLive,
	listClassroomsNeedingCleanup,
	listLiveClassrooms,
	markClassroomCleaned,
	normalizeDisplayName,
} from "../classrooms";
import { withApp } from "./helpers";

describe("normalizeDisplayName", () => {
	test("trims and collapses whitespace", () => {
		expect(normalizeDisplayName("  Alex   D  ")).toBe("Alex D");
	});

	test("accepts unicode letters, digits, apostrophes, hyphens and periods", () => {
		expect(normalizeDisplayName("Zoë O'Neil-Smith Jr.")).toBe(
			"Zoë O'Neil-Smith Jr.",
		);
		expect(normalizeDisplayName("李雷")).toBe("李雷");
		expect(normalizeDisplayName("Sam 2")).toBe("Sam 2");
	});

	test("rejects empty, too long, markup, and punctuation-only names", () => {
		expect(normalizeDisplayName("")).toBeNull();
		expect(normalizeDisplayName("   ")).toBeNull();
		expect(normalizeDisplayName("a".repeat(41))).toBeNull();
		expect(normalizeDisplayName("<script>")).toBeNull();
		expect(normalizeDisplayName("...")).toBeNull();
	});
});

describe("guestNameKey", () => {
	test("ignores case, accents, spaces and punctuation", () => {
		expect(guestNameKey("Alex D")).toBe("alexd");
		expect(guestNameKey("alex d.")).toBe("alexd");
		expect(guestNameKey("Zoë")).toBe(guestNameKey("zoe"));
	});

	test("keeps non-Latin letters", () => {
		expect(guestNameKey("李雷")).toBe("李雷");
	});
});

describe("generateClassroomCode", () => {
	test("always produces six digits", () => {
		for (let i = 0; i < 200; i += 1) {
			expect(generateClassroomCode()).toMatch(/^\d{6}$/u);
		}
	});
});

describe("classroom storage", () => {
	test("create, find by code, list, end, and cleanup bookkeeping", async () => {
		await withApp(async (app) => {
			const db = app.storage.db;
			const now = new Date("2026-09-30T15:00:00.000Z");
			const classroom = createClassroom(db, {
				createdBy: "admin-1",
				durationMinutes: 240,
				now,
			});
			expect(classroom.id).toMatch(/^cls_[a-f0-9]{32}$/u);
			expect(classroom.code).toMatch(/^\d{6}$/u);
			expect(classroom.expires_at).toBe("2026-09-30T19:00:00.000Z");
			expect(isClassroomLive(classroom, now)).toBe(true);

			expect(findLiveClassroomByCode(db, classroom.code, now)?.id).toBe(
				classroom.id,
			);
			expect(listLiveClassrooms(db, now).map((c) => c.id)).toEqual([
				classroom.id,
			]);
			expect(listClassroomsNeedingCleanup(db, now)).toEqual([]);

			// Expired: no longer found by code, and now needs cleanup.
			const later = new Date("2026-09-30T19:00:00.001Z");
			expect(findLiveClassroomByCode(db, classroom.code, later)).toBeNull();
			expect(listLiveClassrooms(db, later)).toEqual([]);
			expect(listClassroomsNeedingCleanup(db, later).map((c) => c.id)).toEqual([
				classroom.id,
			]);

			markClassroomCleaned(db, classroom.id, later);
			expect(listClassroomsNeedingCleanup(db, later)).toEqual([]);
			expect(getClassroom(db, classroom.id)?.cleaned_at).toBe(
				later.toISOString(),
			);
		});
	});

	test("ending a classroom makes it not live and due for cleanup", async () => {
		await withApp(async (app) => {
			const db = app.storage.db;
			const classroom = createClassroom(db, {
				createdBy: "admin-1",
				durationMinutes: 60,
			});
			endClassroom(db, classroom.id);
			const ended = getClassroom(db, classroom.id);
			expect(ended?.ended_at).not.toBeNull();
			expect(isClassroomLive(ended!)).toBe(false);
			expect(findLiveClassroomByCode(db, classroom.code)).toBeNull();
			expect(listClassroomsNeedingCleanup(db).map((c) => c.id)).toEqual([
				classroom.id,
			]);
		});
	});

	test("a code already used by a live classroom is not reused", async () => {
		await withApp(async (app) => {
			const db = app.storage.db;
			const codes = ["111111", "111111", "222222"];
			const generateCode = () => codes.shift() ?? "999999";
			const first = createClassroom(db, {
				createdBy: "a",
				durationMinutes: 60,
				generateCode,
			});
			const second = createClassroom(db, {
				createdBy: "a",
				durationMinutes: 60,
				generateCode,
			});
			expect(first.code).toBe("111111");
			expect(second.code).toBe("222222");
		});
	});

	test("a code from an ended classroom can be reused", async () => {
		await withApp(async (app) => {
			const db = app.storage.db;
			const first = createClassroom(db, {
				createdBy: "a",
				durationMinutes: 60,
				generateCode: () => "333333",
			});
			endClassroom(db, first.id);
			const second = createClassroom(db, {
				createdBy: "a",
				durationMinutes: 60,
				generateCode: () => "333333",
			});
			expect(second.code).toBe("333333");
			expect(findLiveClassroomByCode(db, "333333")?.id).toBe(second.id);
		});
	});
});

describe("FailedAttemptLimiter", () => {
	test("blocks one IP after 10 failures within the window", () => {
		const limiter = new FailedAttemptLimiter();
		const t0 = 1_000_000;
		for (let i = 0; i < 9; i += 1) limiter.recordFailure("1.1.1.1", t0);
		expect(limiter.isBlocked("1.1.1.1", t0)).toBe(false);
		limiter.recordFailure("1.1.1.1", t0);
		expect(limiter.isBlocked("1.1.1.1", t0)).toBe(true);
		expect(limiter.isBlocked("2.2.2.2", t0)).toBe(false);
	});

	test("failures age out after 10 minutes", () => {
		const limiter = new FailedAttemptLimiter();
		const t0 = 1_000_000;
		for (let i = 0; i < 10; i += 1) limiter.recordFailure("1.1.1.1", t0);
		expect(limiter.isBlocked("1.1.1.1", t0 + 10 * 60_000 - 1)).toBe(true);
		expect(limiter.isBlocked("1.1.1.1", t0 + 10 * 60_000 + 1)).toBe(false);
	});

	test("blocks everyone after 100 failures across many IPs", () => {
		const limiter = new FailedAttemptLimiter();
		const t0 = 1_000_000;
		for (let i = 0; i < 100; i += 1) limiter.recordFailure(`10.0.0.${i}`, t0);
		expect(limiter.isBlocked("192.168.1.1", t0)).toBe(true);
	});
});
