/**
 * Classroom join codes (decision 043): short-lived 6-digit codes that let a
 * student sign in as a guest with just the code and their name.
 *
 * This module only touches SQLite and has no runtime dependencies, so both
 * the Better Auth plugin and the auth middleware can import it.
 */

import type { Database } from "bun:sqlite";
import { randomBytes, randomInt } from "node:crypto";

export const CLASSROOM_GUEST_CAP = 60;
export const CLASSROOM_MIN_MINUTES = 60;
export const CLASSROOM_MAX_MINUTES = 720;
export const CLASSROOM_DEFAULT_MINUTES = 240;
export const GUEST_EMAIL_DOMAIN = "classroom.invalid";

export type ClassroomRow = {
	id: string;
	code: string;
	created_by: string;
	created_at: string;
	expires_at: string;
	ended_at: string | null;
	cleaned_at: string | null;
};

const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} .'-]+$/u;

/** Canonical display name, or null when the input is not an acceptable name. */
export function normalizeDisplayName(raw: string): string | null {
	const name = raw.trim().replace(/\s+/gu, " ");
	if (name.length < 1 || name.length > 40) return null;
	if (!DISPLAY_NAME_PATTERN.test(name)) return null;
	if (guestNameKey(name) === "") return null;
	return name;
}

/** Identity key for rejoining: "Alex D", "alex d." and "ALEX-D" are the same guest. */
export function guestNameKey(displayName: string): string {
	return displayName
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/gu, "")
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

export function generateClassroomCode(): string {
	return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function isClassroomLive(row: ClassroomRow, now = new Date()): boolean {
	return (
		row.ended_at === null && new Date(row.expires_at).getTime() > now.getTime()
	);
}

export function createClassroom(
	db: Database,
	input: {
		createdBy: string;
		durationMinutes: number;
		now?: Date;
		generateCode?: () => string;
	},
): ClassroomRow {
	const now = input.now ?? new Date();
	const generateCode = input.generateCode ?? generateClassroomCode;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const code = generateCode();
		if (findLiveClassroomByCode(db, code, now)) continue;
		const row: ClassroomRow = {
			id: `cls_${randomBytes(16).toString("hex")}`,
			code,
			created_by: input.createdBy,
			created_at: now.toISOString(),
			expires_at: new Date(
				now.getTime() + input.durationMinutes * 60_000,
			).toISOString(),
			ended_at: null,
			cleaned_at: null,
		};
		db.query(
			"INSERT INTO classrooms (id, code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
		).run(row.id, row.code, row.created_by, row.created_at, row.expires_at);
		return row;
	}
	throw new Error("Could not allocate a unique classroom code.");
}

export function getClassroom(db: Database, id: string): ClassroomRow | null {
	return (
		(db
			.query("SELECT * FROM classrooms WHERE id = ?")
			.get(id) as ClassroomRow | null) ?? null
	);
}

export function findLiveClassroomByCode(
	db: Database,
	code: string,
	now = new Date(),
): ClassroomRow | null {
	return (
		(db
			.query(
				"SELECT * FROM classrooms WHERE code = ? AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
			)
			.get(code, now.toISOString()) as ClassroomRow | null) ?? null
	);
}

export function listLiveClassrooms(
	db: Database,
	now = new Date(),
): ClassroomRow[] {
	return db
		.query(
			"SELECT * FROM classrooms WHERE ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
		)
		.all(now.toISOString()) as ClassroomRow[];
}

export function endClassroom(db: Database, id: string, now = new Date()): void {
	db.query(
		"UPDATE classrooms SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
	).run(now.toISOString(), id);
}

export function listClassroomsNeedingCleanup(
	db: Database,
	now = new Date(),
): ClassroomRow[] {
	return db
		.query(
			"SELECT * FROM classrooms WHERE cleaned_at IS NULL AND (ended_at IS NOT NULL OR expires_at <= ?) ORDER BY created_at",
		)
		.all(now.toISOString()) as ClassroomRow[];
}

export function markClassroomCleaned(
	db: Database,
	id: string,
	now = new Date(),
): void {
	db.query("UPDATE classrooms SET cleaned_at = ? WHERE id = ?").run(
		now.toISOString(),
		id,
	);
}

/**
 * Counts failed join attempts (bad or expired codes) per client IP and
 * globally. Successful joins are never counted: every student at a school
 * shares one public IP. The global bucket bounds guessing even when the
 * client IP can be spoofed.
 */
export class FailedAttemptLimiter {
	private readonly windowMs: number;
	private readonly perIpMax: number;
	private readonly globalMax: number;
	private readonly perIp = new Map<string, number[]>();
	private global: number[] = [];

	constructor(
		options: { windowMs?: number; perIpMax?: number; globalMax?: number } = {},
	) {
		this.windowMs = options.windowMs ?? 10 * 60_000;
		this.perIpMax = options.perIpMax ?? 10;
		this.globalMax = options.globalMax ?? 100;
	}

	isBlocked(ip: string, now = Date.now()): boolean {
		this.prune(now);
		return (
			(this.perIp.get(ip)?.length ?? 0) >= this.perIpMax ||
			this.global.length >= this.globalMax
		);
	}

	recordFailure(ip: string, now = Date.now()): void {
		this.prune(now);
		const attempts = this.perIp.get(ip) ?? [];
		attempts.push(now);
		this.perIp.set(ip, attempts);
		this.global.push(now);
	}

	private prune(now: number): void {
		const cutoff = now - this.windowMs;
		this.global = this.global.filter((time) => time > cutoff);
		for (const [ip, attempts] of this.perIp) {
			const kept = attempts.filter((time) => time > cutoff);
			if (kept.length > 0) {
				this.perIp.set(ip, kept);
			} else {
				this.perIp.delete(ip);
			}
		}
	}
}
