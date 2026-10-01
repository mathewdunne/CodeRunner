# Classroom Join Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin start a short-lived classroom with a 6-digit code so students can join CodeRunner with just the code and their name — no OAuth, no allowlist — and have guests cleaned up automatically when the classroom ends.

**Architecture:** A custom Better Auth plugin (`/api/auth/classroom/join`) mints real Better Auth sessions for guest users (a user with a non-null `classroomId`). A thin control-plane dispatcher in front of it owns rate limiting (needs the socket IP) and retiring the previous guest's session/container (needs the runtime). A 60-second sweeper deletes guests of ended/expired classrooms using a user-deletion helper extracted from the existing admin route. The web shell gets a `/join` page, a guest variant of the user menu with a **Leave** button, and an admin **Classrooms** tab.

**Tech Stack:** Bun + TypeScript control plane, `bun:sqlite`, Better Auth 1.6.10 (`better-auth/api`, `better-auth/cookies`), zod v4 in `packages/contracts`, React 19 + react-router 7 + Vitest/Testing Library in `apps/web`, Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-09-30-classroom-join-codes-design.md`

## Global Constraints

- All non-container code is TypeScript on Bun; run `bun run check:fix` before each commit (Biome lint + format + import order). `bun run verify` gates CI on `biome ci`.
- Work on a branch named `classroom-join-codes`, never directly on `main`.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Classroom code: exactly 6 digits, zero-padded, cryptographically random, unique among **live** classrooms.
- Classroom is **live** iff `ended_at IS NULL AND expires_at > now`.
- Duration: whole minutes, 60–720, default 240.
- Guest cap: 60 guests per classroom.
- Rate limit: failed attempts only; per client IP 10 per rolling 10 min; global 100 per rolling 10 min.
- Guest display name: trimmed, whitespace collapsed, 1–40 chars, letters (Unicode) / digits / space / `-` / `'` / `.`; the name key must be non-empty.
- Guest email: `guest-<random hex>@classroom.invalid`; guest role is always `student`.
- Join endpoint is disabled (404 `DISABLED`) in demo mode.
- Join error body is `{ code, message }` (+ `displayName` for `NAME_TAKEN`). Codes: `INVALID_INPUT` 400, `INVALID_CODE` 404, `NAME_TAKEN` 409, `CLASSROOM_FULL` 403, `RATE_LIMITED` 429, `DISABLED` 404.
- The Better Auth `user` table is created by Better Auth's `runMigrations()` **after** our SQL migrations — never `ALTER TABLE user` in `apps/control/migrations/`.

## Review Focus

- **Same name joined twice at once** (double-click on Join, or the same kid on two computers) → exactly one guest user; the loser gets `NAME_TAKEN`, never a 500. Pinned in Task 2.
- **Name with no Latin letters** (e.g. `李雷`) → join succeeds and the workspace slug falls back to `student…`, not an empty or invalid slug. Pinned in Task 2.
- **Code typed or pasted with spaces/dashes** (`123 456`, `12-34-56`) → the form keeps only digits; the server still requires exactly 6 digits. Pinned in Task 7.
- **Classroom ended while a guest's IDE is open** → their next API call is 401 (existing UI handles it), not a 500 and not still signed in, even with Better Auth's session refresh. Pinned in Task 3.
- **A coach's own browser used to join as a guest** → the coach's session is replaced, but the coach's container is not stopped and their account is untouched. Pinned in Task 4.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/control/migrations/012_classrooms.sql` | create | `classrooms` table |
| `apps/control/src/classrooms.ts` | create | Pure helpers (name/code), classroom + guest SQL helpers, `FailedAttemptLimiter`. Depends only on `bun:sqlite`/`node:crypto`. |
| `apps/control/src/classroom-sweeper.ts` | create | `cleanupClassroom()` + `ClassroomSweeper` interval |
| `apps/control/src/user-deletion.ts` | create | `deleteUserAndWorkspace()` extracted from the admin route |
| `apps/control/src/auth/classroom-plugin.ts` | create | Better Auth plugin: validate → find/create guest → session → cookie |
| `apps/control/src/auth/auth.ts` | modify | `slugify()`, guest additional fields, guest branch in user-create hook, register plugin, `audit` callback |
| `apps/control/src/storage.ts` | modify | Pass `audit` callback; create guest unique index after Better Auth migrations |
| `apps/control/src/auth/middleware.ts` | modify | Reject guest sessions whose classroom is not live |
| `apps/control/src/app/classroom-routes.ts` | create | `handleClassroomJoin` (demo gate, rate limit, retire previous session) and `handleAdminClassroomRoute` |
| `apps/control/src/app.ts` | modify | Route join + `/join`, shared `stopWorkspace`, sweeper lifecycle |
| `apps/control/src/app/types.ts` | modify | `requestIP?` on `BunUpgradeServer` |
| `apps/control/src/app/admin-routes.ts` | modify | Use `deleteUserAndWorkspace`, delegate classroom routes |
| `apps/control/src/app/workspace-routes.ts` | modify | `POST /api/leave`, `guest` on `/api/session` |
| `apps/control/src/app/responses.ts` | modify | `guest` option on `sessionResponse` |
| `apps/control/src/metrics.ts` | modify | `/join` and `/api/leave` in known-route sets |
| `packages/contracts/src/index.ts` | modify | Join request/error schemas, `user.guest` on the session schema |
| `apps/web/src/lib/contracts.ts` | modify | Re-export the new schema/types |
| `apps/web/src/routes/JoinPage.tsx` | create | Join form + name-taken confirm |
| `apps/web/src/routes/LoginPage.tsx`, `apps/web/src/App.tsx` | modify | Link + route |
| `apps/web/src/components/UserMenu.tsx`, `Topbar.tsx`, `apps/web/src/routes/WorkspacePage.tsx` | modify | Guest menu variant |
| `apps/web/src/admin/pages/Classrooms.tsx`, `AdminLayout.tsx`, `AdminApp.tsx` | create/modify | Admin tab |
| Tests | create | `classrooms.test.ts`, `classroom-join.test.ts`, `classroom-dispatch.test.ts`, `classroom-admin.test.ts`, `JoinPage.test.tsx`, `UserMenu.test.tsx`, `e2e/specs/auth/classroom-join.spec.ts` |
| Docs | create/modify | `docs/decisions/043-classroom-join-codes.md`, `docs/using-coderunner.md`, `docs/operating/day-to-day.md`, `AGENTS.md` |

---

### Task 1: Classroom core module and migration

**Files:**
- Create: `apps/control/migrations/012_classrooms.sql`
- Create: `apps/control/src/classrooms.ts`
- Test: `apps/control/src/__tests__/classrooms.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (all exported from `apps/control/src/classrooms.ts`):
  - consts `CLASSROOM_GUEST_CAP = 60`, `CLASSROOM_MIN_MINUTES = 60`, `CLASSROOM_MAX_MINUTES = 720`, `CLASSROOM_DEFAULT_MINUTES = 240`, `GUEST_EMAIL_DOMAIN = "classroom.invalid"`
  - `type ClassroomRow = { id: string; code: string; created_by: string; created_at: string; expires_at: string; ended_at: string | null; cleaned_at: string | null }`
  - `normalizeDisplayName(raw: string): string | null`
  - `guestNameKey(displayName: string): string`
  - `generateClassroomCode(): string`
  - `isClassroomLive(row: ClassroomRow, now?: Date): boolean`
  - `createClassroom(db: Database, input: { createdBy: string; durationMinutes: number; now?: Date; generateCode?: () => string }): ClassroomRow`
  - `getClassroom(db: Database, id: string): ClassroomRow | null`
  - `findLiveClassroomByCode(db: Database, code: string, now?: Date): ClassroomRow | null`
  - `listLiveClassrooms(db: Database, now?: Date): ClassroomRow[]`
  - `endClassroom(db: Database, id: string, now?: Date): void`
  - `listClassroomsNeedingCleanup(db: Database, now?: Date): ClassroomRow[]`
  - `markClassroomCleaned(db: Database, id: string, now?: Date): void`
  - `class FailedAttemptLimiter { constructor(options?: { windowMs?: number; perIpMax?: number; globalMax?: number }); isBlocked(ip: string, now?: number): boolean; recordFailure(ip: string, now?: number): void }`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b classroom-join-codes
```

- [ ] **Step 2: Write the failing tests**

Create `apps/control/src/__tests__/classrooms.test.ts`:

```ts
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
			expect(listClassroomsNeedingCleanup(db, later).map((c) => c.id)).toEqual(
				[classroom.id],
			);

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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classrooms.test.ts`
Expected: FAIL — `Cannot find module '../classrooms'`.

- [ ] **Step 4: Write the migration**

Create `apps/control/migrations/012_classrooms.sql`:

```sql
-- Classroom join codes (decision 043). Guest users point at a classroom via
-- the Better Auth user.classroomId column, which Better Auth itself adds
-- (declared as an additionalField) — the user table does not exist yet when
-- these migrations run.
CREATE TABLE classrooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  cleaned_at TEXT
);

-- Codes are unique only among live classrooms; "live" depends on now(), so
-- uniqueness is enforced at creation time rather than by a constraint.
CREATE INDEX idx_classrooms_code ON classrooms(code);
```

- [ ] **Step 5: Write the module**

Create `apps/control/src/classrooms.ts`:

```ts
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classrooms.test.ts`
Expected: PASS (all tests).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/control/migrations/012_classrooms.sql apps/control/src/classrooms.ts apps/control/src/__tests__/classrooms.test.ts
git commit -m "feat(control): classroom storage, name/code helpers, join rate limiter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Guest users and the Better Auth join plugin

**Files:**
- Create: `apps/control/src/auth/classroom-plugin.ts`
- Modify: `apps/control/src/classrooms.ts` (guest queries)
- Modify: `apps/control/src/auth/auth.ts`
- Modify: `apps/control/src/storage.ts:155-164` (createAuth call + index)
- Modify: `packages/contracts/src/index.ts` (after `authProvidersResponseSchema`)
- Modify: `apps/control/src/__tests__/helpers.ts` (two helpers)
- Test: `apps/control/src/__tests__/classroom-join.test.ts`

**Interfaces:**
- Consumes (Task 1): `normalizeDisplayName`, `guestNameKey`, `findLiveClassroomByCode`, `createClassroom`, `endClassroom`, `CLASSROOM_GUEST_CAP`, `GUEST_EMAIL_DOMAIN`, `ClassroomRow`.
- Produces:
  - `classrooms.ts`: `type GuestRow = { id: string; name: string; slug: string | null; createdAt: string }`, `findGuest(db, classroomId: string, nameKey: string): GuestRow | null`, `countClassroomGuests(db, classroomId: string): number`, `listGuestIds(db, classroomId: string): string[]`, `listClassroomGuests(db, classroomId: string): Array<GuestRow & { lastAccessedAt: string | null }>`, `findGuestClassroom(db, userId: string): ClassroomRow | null`.
  - `auth/auth.ts`: `slugify(value: string): string`; `AuthCallbacks` gains `audit: (event: AuditEventInput) => void`.
  - `auth/classroom-plugin.ts`: `classroomPlugin(options: { db: Database; ensureWorkspace: (userId: string, slug: string) => Promise<void>; audit: (event: AuditEventInput) => void })`.
  - HTTP: `POST /api/auth/classroom/join` → 200 `{ ok: true, userId }` + `coderunner_session` cookie; errors per Global Constraints.
  - contracts: `CLASSROOM_CODE_PATTERN`, `classroomJoinRequestSchema`, `classroomJoinErrorSchema`, types `ClassroomJoinRequest`, `ClassroomJoinError`.
  - test helpers: `classroomJoinRequest(body: unknown, headers?: Record<string, string>): Request`, `sessionCookieFrom(response: Response): string`.

- [ ] **Step 1: Add the test helpers**

Append to `apps/control/src/__tests__/helpers.ts`:

```ts
/** POST to the classroom join endpoint the way the browser does. */
export function classroomJoinRequest(
	body: unknown,
	headers: Record<string, string> = {},
): Request {
	return new Request("http://localhost:4000/api/auth/classroom/join", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// Better Auth rejects cookie-bearing POSTs without a same-origin Origin.
			origin: "http://localhost:4000",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

/** The `coderunner_session=…` pair from a Better Auth response (it also sets a cache cookie). */
export function sessionCookieFrom(response: Response): string {
	const cookie = response.headers
		.getSetCookie()
		.find((value) => value.startsWith("coderunner_session="));
	expect(cookie).toBeTruthy();
	return cookie?.split(";")[0] ?? "";
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/control/src/__tests__/classroom-join.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ControlApp } from "../app";
import { CLASSROOM_GUEST_CAP, createClassroom, endClassroom } from "../classrooms";
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts`
Expected: FAIL — the join requests return 404 (no such Better Auth endpoint) and `SELECT … classroomId` fails with `no such column: classroomId`.

- [ ] **Step 4: Add the contracts**

In `packages/contracts/src/index.ts`, directly after the `authProvidersResponseSchema` definition, add:

```ts
export const CLASSROOM_CODE_PATTERN = /^\d{6}$/u;

export const classroomJoinRequestSchema = z.object({
	code: z.string().regex(CLASSROOM_CODE_PATTERN),
	// Full name rules live in the control plane (normalizeDisplayName); this is
	// only a size guard.
	name: z.string().max(200),
	confirmExisting: z.boolean().optional(),
});

export const classroomJoinErrorSchema = z.object({
	code: z.string(),
	message: z.string(),
	displayName: z.string().optional(),
});

export type ClassroomJoinRequest = z.infer<typeof classroomJoinRequestSchema>;
export type ClassroomJoinError = z.infer<typeof classroomJoinErrorSchema>;
```

(`index.ts` contains a non-UTF-8 byte somewhere, so plain `grep` reports "binary file matches"; use `grep -a` when searching it.)

- [ ] **Step 5: Add the guest queries to `classrooms.ts`**

Append to `apps/control/src/classrooms.ts`:

```ts
// --- Guest users ---------------------------------------------------------
// A guest is a Better Auth user with a non-null classroomId. The columns are
// Better Auth additionalFields (see auth/auth.ts), so these queries only work
// after AppStorage.initialize() has run Better Auth's migrations.

export type GuestRow = {
	id: string;
	name: string;
	slug: string | null;
	createdAt: string;
};

export function findGuest(
	db: Database,
	classroomId: string,
	nameKey: string,
): GuestRow | null {
	return (
		(db
			.query(
				"SELECT id, name, slug, createdAt FROM user WHERE classroomId = ? AND guestNameKey = ?",
			)
			.get(classroomId, nameKey) as GuestRow | null) ?? null
	);
}

export function countClassroomGuests(db: Database, classroomId: string): number {
	const row = db
		.query("SELECT COUNT(*) AS count FROM user WHERE classroomId = ?")
		.get(classroomId) as { count: number };
	return row.count;
}

export function listGuestIds(db: Database, classroomId: string): string[] {
	return (
		db.query("SELECT id FROM user WHERE classroomId = ?").all(classroomId) as {
			id: string;
		}[]
	).map((row) => row.id);
}

export function listClassroomGuests(
	db: Database,
	classroomId: string,
): Array<GuestRow & { lastAccessedAt: string | null }> {
	return db
		.query(
			`SELECT u.id, u.name, u.slug, u.createdAt, w.last_accessed_at AS lastAccessedAt
       FROM user u LEFT JOIN workspaces w ON w.user_id = u.id
       WHERE u.classroomId = ? ORDER BY u.createdAt`,
		)
		.all(classroomId) as Array<GuestRow & { lastAccessedAt: string | null }>;
}

/** The classroom a guest belongs to, or null for a regular (OAuth) user. */
export function findGuestClassroom(
	db: Database,
	userId: string,
): ClassroomRow | null {
	return (
		(db
			.query(
				"SELECT c.* FROM user u JOIN classrooms c ON c.id = u.classroomId WHERE u.id = ?",
			)
			.get(userId) as ClassroomRow | null) ?? null
	);
}
```

- [ ] **Step 6: Write the plugin**

Create `apps/control/src/auth/classroom-plugin.ts`:

```ts
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
	CLASSROOM_GUEST_CAP,
	countClassroomGuests,
	findGuest,
	findLiveClassroomByCode,
	GUEST_EMAIL_DOMAIN,
	guestNameKey,
	normalizeDisplayName,
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

					const nameKey = guestNameKey(displayName);
					let guest = findGuest(db, classroom.id, nameKey);
					const rejoin = guest !== null;
					if (!guest) {
						if (countClassroomGuests(db, classroom.id) >= CLASSROOM_GUEST_CAP) {
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

					const user = await ctx.context.internalAdapter.findUserById(guest.id);
					if (!user) {
						throw new APIError("INTERNAL_SERVER_ERROR", {
							code: "JOIN_FAILED",
							message: "Couldn't find your guest account.",
						});
					}
					await options.ensureWorkspace(guest.id, guest.slug ?? "student");

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
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
```

- [ ] **Step 7: Wire the plugin, guest fields, and hook into `auth/auth.ts`**

Replace `slugFromEmail` with a shared `slugify`:

```ts
export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/gu, "")
			.replace(/[^a-z0-9_-]+/gu, "-")
			.replace(/-+/gu, "-")
			.replace(/^[-_]+|[-_]+$/gu, "")
			.slice(0, 40) || "student"
	);
}

export function slugFromEmail(email: string): string {
	return slugify(email.split("@")[0] ?? "student");
}
```

Add imports:

```ts
import type { AuditEventInput } from "../audit";
import { classroomPlugin } from "./classroom-plugin";
```

Extend `AuthCallbacks`:

```ts
export type AuthCallbacks = {
	/** Called after OAuth callback for new users to create their workspace. */
	ensureWorkspace: (userId: string, slug: string) => Promise<void>;
	/** Records an audit event (classroom guest joins). */
	audit: (event: AuditEventInput) => void;
};
```

In `options`, add after `socialProviders,`:

```ts
		plugins: [
			classroomPlugin({
				db,
				ensureWorkspace: callbacks.ensureWorkspace,
				audit: callbacks.audit,
			}),
		],
```

In `user.additionalFields`, add after `slug`:

```ts
				// Classroom guests (decision 043). Better Auth adds these columns.
				classroomId: {
					type: "string",
					required: false,
					input: false,
				},
				guestNameKey: {
					type: "string",
					required: false,
					input: false,
				},
```

At the top of `databaseHooks.user.create.before`, before the allowlist check:

```ts
					before: async (user) => {
						const classroomId = (user as { classroomId?: string | null })
							.classroomId;
						if (classroomId) {
							// Classroom guests: no allowlist, never admin, slug from name.
							const slug = slugify(user.name);
							log.info("creating classroom guest", { classroomId, slug });
							return { data: { ...user, slug, role: "student" } };
						}
						// Enforce allowlist on new user creation
```

(leave the rest of the hook unchanged).

- [ ] **Step 8: Pass the audit callback and create the unique index in `storage.ts`**

In `AppStorage.initialize()`, change step 4 to:

```ts
		// 4. Create Better Auth instance and run its migrations
		this.auth = createAuth(this.db, this.config, {
			ensureWorkspace: async (userId, slug) => {
				await this.ensureWorkspaceForUser(userId, slug);
			},
			audit: (event) => recordAuditEvent(this, event),
		});
		const { getMigrations } = await import("better-auth/db/migration");
		const { runMigrations } = await getMigrations(this.auth.options);
		await runMigrations();
		// One guest per name per classroom. Lives here, not in a SQL migration,
		// because Better Auth creates the user table and its classroom columns.
		this.db.exec(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_user_classroom_guest ON user(classroomId, guestNameKey) WHERE classroomId IS NOT NULL;",
		);
```

and add `import { recordAuditEvent } from "./audit";` to the imports (check first whether `storage.ts` already imports from `./audit`; if so, extend that import).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts apps/control/src/__tests__/auth.test.ts apps/control/src/__tests__/auth-demo.test.ts`
Expected: PASS. `auth.test.ts` proves the OAuth allowlist path is unchanged.

- [ ] **Step 10: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/control/src/auth apps/control/src/classrooms.ts apps/control/src/storage.ts packages/contracts/src/index.ts apps/control/src/__tests__/helpers.ts apps/control/src/__tests__/classroom-join.test.ts
git commit -m "feat(auth): classroom join plugin with rejoin-by-name guest users

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Guest sessions end with their classroom

**Files:**
- Modify: `apps/control/src/auth/middleware.ts` (`getSessionFromRequest`)
- Test: `apps/control/src/__tests__/classroom-join.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `getClassroom`, `isClassroomLive` (Task 1); `classroomJoinRequest`, `sessionCookieFrom` (Task 2).
- Produces: `getSessionFromRequest` returns `null` for a guest whose classroom is ended, expired, or missing. Every gated route inherits this.

- [ ] **Step 1: Write the failing tests**

Append to `apps/control/src/__tests__/classroom-join.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts -t "guest session lifetime"`
Expected: FAIL — both return 200 where 401 is expected.

- [ ] **Step 3: Implement the liveness check**

In `apps/control/src/auth/middleware.ts` add `import { getClassroom, isClassroomLive } from "../classrooms";`, then in `getSessionFromRequest`, change the user cast and add the check right after it:

```ts
		const user = session.user as {
			id: string;
			email: string;
			name: string;
			image?: string | null;
			role?: string;
			slug?: string;
			classroomId?: string | null;
		};
		// Classroom guests are only signed in while their classroom is live.
		// This is the authoritative check: Better Auth's updateAge refresh can
		// extend a guest's session row, and its cookie cache can outlive "End now".
		if (user.classroomId) {
			const classroom = getClassroom(storage.db, user.classroomId);
			if (!classroom || !isClassroomLive(classroom)) {
				log.debug("getSession: classroom not live", {
					userId: user.id,
					classroomId: user.classroomId,
				});
				return null;
			}
		}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/control/src/auth/middleware.ts apps/control/src/__tests__/classroom-join.test.ts
git commit -m "feat(auth): guest sessions end when their classroom ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Join dispatcher — rate limit, demo gate, retiring the previous session, `/join` shell

**Files:**
- Create: `apps/control/src/app/classroom-routes.ts`
- Modify: `apps/control/src/app/types.ts` (`BunUpgradeServer`)
- Modify: `apps/control/src/app.ts`
- Modify: `apps/control/src/metrics.ts` (`KNOWN_TOP_LEVEL`)
- Modify: `apps/control/src/__tests__/default-deny.test.ts` (`PUBLIC_PATHS`)
- Test: `apps/control/src/__tests__/classroom-dispatch.test.ts`

**Interfaces:**
- Consumes: `FailedAttemptLimiter`, `findGuestClassroom` (Tasks 1–2); `getSessionFromRequest`.
- Produces:
  - `app/classroom-routes.ts`: `type ClassroomJoinContext = { storage: AppStorage; limiter: FailedAttemptLimiter; stopWorkspace: (workspaceId: WorkspaceId) => Promise<void> }`, `clientIp(request: Request, server: BunUpgradeServer | undefined): string`, `handleClassroomJoin(ctx: ClassroomJoinContext, request: Request, server: BunUpgradeServer | undefined): Promise<Response>`.
  - `app.ts`: a local `stopWorkspace(workspaceId: WorkspaceId): Promise<void>` (runs + runtime + halsim/nt4Auto/gamepad), used again in Tasks 5–6.
  - `BunUpgradeServer.requestIP?(request: Request): { address: string } | null`.

- [ ] **Step 1: Write the failing tests**

Create `apps/control/src/__tests__/classroom-dispatch.test.ts`:

```ts
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
			const firstWorkspace = app.storage.findWorkspaceByUserId(firstBody.userId);

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
			expect(app.storage.findWorkspaceByUserId(firstBody.userId)).not.toBeNull();
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
```

Add `{ path: "/join" },` to `PUBLIC_PATHS` in `apps/control/src/__tests__/default-deny.test.ts` (after `{ path: "/login" },`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classroom-dispatch.test.ts apps/control/src/__tests__/default-deny.test.ts`
Expected: FAIL — no 429s, no stops, demo returns Better Auth's response, `/join` is 404.

- [ ] **Step 3: Add `requestIP` to `BunUpgradeServer`**

In `apps/control/src/app/types.ts`:

```ts
export type BunUpgradeServer = {
	upgrade(
		request: Request,
		options: { data: SocketData; headers?: HeadersInit },
	): boolean;
	/** Bun's socket address for the request; absent in tests. */
	requestIP?(request: Request): { address: string } | null;
};
```

- [ ] **Step 4: Write the dispatcher**

Create `apps/control/src/app/classroom-routes.ts`:

```ts
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
```

- [ ] **Step 5: Wire it into `app.ts`**

1. Imports — extend the contracts import and add:

```ts
import type {
	AuthProvidersResponse,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import { handleClassroomJoin } from "./app/classroom-routes";
import { FailedAttemptLimiter } from "./classrooms";
```

2. After `idle.start();` and before `const adminCtx`, add:

```ts
	/** Stop a workspace's run and container and drop its live bridges. Files are kept. */
	async function stopWorkspace(workspaceId: WorkspaceId): Promise<void> {
		runs.stopWorkspace(workspaceId);
		await runtimeProvider.stopWorkspace(workspaceId);
		halsim.disconnect(workspaceId);
		nt4Auto.disconnect(workspaceId);
		gamepad.reset(workspaceId);
	}
	const classroomJoinCtx = {
		storage,
		limiter: new FailedAttemptLimiter(),
		stopWorkspace,
	};
```

3. In `dispatch`, immediately before the `// --- Better Auth API routes ---` block:

```ts
		if (
			url.pathname === "/api/auth/classroom/join" &&
			request.method === "POST"
		) {
			return handleClassroomJoin(classroomJoinCtx, request, server);
		}
```

4. Next to the `/login` shell route:

```ts
		if (
			(url.pathname === "/login" || url.pathname === "/join") &&
			request.method === "GET"
		) {
			return webShellResponse(storage);
		}
```

(replacing the existing `/login`-only block), and add `/join` to the "Public routes" comment below it.

- [ ] **Step 6: Add `/join` to metrics route templating**

In `apps/control/src/metrics.ts`, add `"/join",` to `KNOWN_TOP_LEVEL` after `"/login",`. (`/api/auth/classroom/join` is already templated as `/api/auth/*`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classroom-dispatch.test.ts apps/control/src/__tests__/default-deny.test.ts apps/control/src/__tests__/metrics.test.ts apps/control/src/__tests__/classroom-join.test.ts`
Expected: PASS.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/control/src/app/classroom-routes.ts apps/control/src/app/types.ts apps/control/src/app.ts apps/control/src/metrics.ts apps/control/src/__tests__/classroom-dispatch.test.ts apps/control/src/__tests__/default-deny.test.ts
git commit -m "feat(control): classroom join rate limit, session hand-off, /join route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: User deletion helper, classroom sweeper, admin classroom routes

**Files:**
- Create: `apps/control/src/user-deletion.ts`
- Create: `apps/control/src/classroom-sweeper.ts`
- Modify: `apps/control/src/app/admin-routes.ts:313-383` (user delete) and top of `handleAdminRoute`
- Modify: `apps/control/src/app/classroom-routes.ts` (admin handler)
- Modify: `apps/control/src/app.ts` (sweeper lifecycle)
- Modify: `apps/control/src/__tests__/default-deny.test.ts` (`GATED_PATHS`)
- Test: `apps/control/src/__tests__/classroom-admin.test.ts`

**Interfaces:**
- Consumes: Task 1 storage helpers + `CLASSROOM_*` consts; Task 2 `listGuestIds`, `listClassroomGuests`; `recordAuditEvent`, `AuditActor` from `../audit`; `auditActor` from `./status`.
- Produces:
  - `user-deletion.ts`: `type UserDeletionContext = { storage: AppStorage; runs: RunManager; runtimeProvider: WorkspaceRuntimeProvider }`, `deleteUserAndWorkspace(ctx: UserDeletionContext, userId: string): Promise<void>`.
  - `classroom-sweeper.ts`: `cleanupClassroom(db: Database, classroomId: string, deleteUser: (userId: string) => Promise<void>, now?: Date): Promise<number>`, `class ClassroomSweeper { constructor(options: { storage: AppStorage; deleteUser: (userId: string) => Promise<void>; intervalMs?: number }); start(): void; stop(): void; sweep(now?: Date): Promise<string[]> }`.
  - `classroom-routes.ts`: `type AdminClassroomContext = { storage: AppStorage; deleteUser: (userId: string) => Promise<void> }`, `handleAdminClassroomRoute(ctx, url: URL, request: Request, actor: AuditActor): Promise<Response | null>`.
  - HTTP: `GET /admin/classrooms` → `{ ok: true, classrooms: ClassroomView[] }`; `POST /admin/classrooms` `{ durationMinutes? }` → 201 `{ ok: true, classroom: ClassroomView }`; `POST /admin/classrooms/:id/end` → `{ ok: true, guestCount }`, where `ClassroomView = { id, code, createdAt, expiresAt, joinUrl, guests: { id, displayName, slug, joinedAt, lastAccessedAt }[] }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/control/src/__tests__/classroom-admin.test.ts`:

```ts
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
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
			const minutes = (new Date(classroom.expiresAt).getTime() - before) / 60_000;
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
			const response = await app.fetch(adminRequest(cookie, "/admin/classrooms"));
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
			expect((await app.fetch(adminRequest(guest, "/admin/status"))).status).toBe(
				403,
			);
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
			expect(getClassroom(app.storage.db, expired.id)?.cleaned_at).not.toBeNull();

			expect(await sweeper.sweep()).toEqual([]);
			const audit = app.storage.db
				.query("SELECT metadata_json FROM audit_log WHERE action = ?")
				.all("classroom.cleanup") as { metadata_json: string }[];
			expect(audit.map((row) => JSON.parse(row.metadata_json))).toEqual([
				{ guestCount: 2 },
			]);
		});
	});
});
```

Add to `GATED_PATHS` in `apps/control/src/__tests__/default-deny.test.ts`:

```ts
	{ path: "/admin/classrooms", expect: "deny" },
	{ path: "/admin/classrooms", method: "POST", expect: "deny" },
	{ path: "/admin/classrooms/cls_x/end", method: "POST", expect: "deny" },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classroom-admin.test.ts`
Expected: FAIL — `Cannot find module '../classroom-sweeper'`.

- [ ] **Step 3: Extract the user deletion helper**

Create `apps/control/src/user-deletion.ts` by moving the body of the `DELETE /admin/users/:id` branch:

```ts
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunManager } from "./runs";
import type { WorkspaceRuntimeProvider } from "./runtime";
import type { AppStorage } from "./storage";

export type UserDeletionContext = {
	storage: AppStorage;
	runs: RunManager;
	runtimeProvider: WorkspaceRuntimeProvider;
};

/**
 * Stop and remove a user's container, delete the user with their sessions,
 * accounts and workspace rows, then remove their data directory. Callers own
 * authorization, guards (e.g. last admin), and audit events.
 */
export async function deleteUserAndWorkspace(
	ctx: UserDeletionContext,
	userId: string,
): Promise<void> {
	const { storage, runs, runtimeProvider } = ctx;
	const workspace = storage.findWorkspaceByUserId(userId);
	if (workspace) {
		runs.stopWorkspace(workspace.id);
		await runtimeProvider.stopWorkspace(workspace.id);
		await runtimeProvider.removeWorkspace(workspace.id);
	}

	storage.db.exec("BEGIN");
	try {
		if (workspace) {
			storage.db
				.query("DELETE FROM run_jobs WHERE workspace_id = ?")
				.run(workspace.id);
			storage.db
				.query("DELETE FROM container_leases WHERE workspace_id = ?")
				.run(workspace.id);
			storage.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace.id);
		}
		storage.db.query("DELETE FROM session WHERE userId = ?").run(userId);
		storage.db.query("DELETE FROM account WHERE userId = ?").run(userId);
		storage.db.query("DELETE FROM user WHERE id = ?").run(userId);
		storage.db.exec("COMMIT");
	} catch (error) {
		storage.db.exec("ROLLBACK");
		throw error;
	}

	if (workspace) {
		await rm(dirname(workspace.project_path), {
			recursive: true,
			force: true,
		});
	}
}
```

In `apps/control/src/app/admin-routes.ts`, replace everything in the `userDeleteMatch` branch from `const workspace = storage.findWorkspaceByUserId(userId);` through the closing `}` of the `if (workspace) { await rm(...) }` block with:

```ts
		await deleteUserAndWorkspace(ctx, userId);
```

keeping the not-found and last-admin guards before it and the `recordAuditEvent` + `jsonResponse` after it. Add `import { deleteUserAndWorkspace } from "../user-deletion";`. If `rm` or `dirname` are now unused in `admin-routes.ts`, remove them from its imports (`bun run typecheck` / Biome will flag them).

- [ ] **Step 4: Write the sweeper**

Create `apps/control/src/classroom-sweeper.ts`:

```ts
import type { Database } from "bun:sqlite";
import { recordAuditEvent } from "./audit";
import {
	listClassroomsNeedingCleanup,
	listGuestIds,
	markClassroomCleaned,
} from "./classrooms";
import { getLogger } from "./logging";
import type { AppStorage } from "./storage";

const log = getLogger("classroom");
const SYSTEM_ACTOR = { userId: "<system>", email: "<system>" };

/** Delete every guest of a classroom and mark it cleaned. Returns the guest count. */
export async function cleanupClassroom(
	db: Database,
	classroomId: string,
	deleteUser: (userId: string) => Promise<void>,
	now = new Date(),
): Promise<number> {
	const guestIds = listGuestIds(db, classroomId);
	for (const userId of guestIds) {
		await deleteUser(userId);
	}
	markClassroomCleaned(db, classroomId, now);
	return guestIds.length;
}

export type ClassroomSweeperOptions = {
	storage: AppStorage;
	deleteUser: (userId: string) => Promise<void>;
	intervalMs?: number;
};

/** Deletes the guests of ended or expired classrooms, once per classroom. */
export class ClassroomSweeper {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly storage: AppStorage;
	private readonly deleteUser: (userId: string) => Promise<void>;
	private readonly intervalMs: number;

	constructor(options: ClassroomSweeperOptions) {
		this.storage = options.storage;
		this.deleteUser = options.deleteUser;
		this.intervalMs = options.intervalMs ?? 60_000;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.sweep(), this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async sweep(now = new Date()): Promise<string[]> {
		const cleaned: string[] = [];
		for (const classroom of listClassroomsNeedingCleanup(
			this.storage.db,
			now,
		)) {
			try {
				const guestCount = await cleanupClassroom(
					this.storage.db,
					classroom.id,
					this.deleteUser,
					now,
				);
				recordAuditEvent(this.storage, {
					actor: SYSTEM_ACTOR,
					action: "classroom.cleanup",
					target: { kind: "classroom", id: classroom.id },
					metadata: { guestCount },
				});
				log.info("classroom cleaned up", {
					classroomId: classroom.id,
					guestCount,
				});
				cleaned.push(classroom.id);
			} catch (err) {
				log.warn("classroom cleanup failed", {
					classroomId: classroom.id,
					err: err instanceof Error ? err : new Error(String(err)),
				});
			}
		}
		return cleaned;
	}
}
```

- [ ] **Step 5: Add the admin handler to `classroom-routes.ts`**

Append to `apps/control/src/app/classroom-routes.ts` (and merge these into its imports: `type AuditActor, recordAuditEvent` from `"../audit"`; `cleanupClassroom` from `"../classroom-sweeper"`; from `"../classrooms"` also `CLASSROOM_DEFAULT_MINUTES, CLASSROOM_MAX_MINUTES, CLASSROOM_MIN_MINUTES, type ClassroomRow, createClassroom, endClassroom, getClassroom, listClassroomGuests, listLiveClassrooms`):

```ts
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
```

In `apps/control/src/app/admin-routes.ts`, right after the `log.debug("admin route", …)` call in `handleAdminRoute`, add:

```ts
	const classroomResponse = await handleAdminClassroomRoute(
		{
			storage,
			deleteUser: (userId) => deleteUserAndWorkspace(ctx, userId),
		},
		url,
		request,
		auditActor(adminResult),
	);
	if (classroomResponse) {
		return classroomResponse;
	}
```

with `import { handleAdminClassroomRoute } from "./classroom-routes";`.

- [ ] **Step 6: Run the sweeper in `app.ts`**

Add imports `import { ClassroomSweeper } from "./classroom-sweeper";` and `import { deleteUserAndWorkspace } from "./user-deletion";`. After `const adminCtx = { storage, runs, runtimeProvider };`:

```ts
	const classroomSweeper = new ClassroomSweeper({
		storage,
		deleteUser: (userId) => deleteUserAndWorkspace(adminCtx, userId),
	});
	classroomSweeper.start();
```

and in `close()`, after `idle.stop();`, add `classroomSweeper.stop();`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classroom-admin.test.ts apps/control/src/__tests__/default-deny.test.ts apps/control/src/__tests__/idle-and-admin.test.ts apps/control/src/__tests__/audit.test.ts`
Expected: PASS — the last two prove `DELETE /admin/users/:id` behaves exactly as before.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/control/src/user-deletion.ts apps/control/src/classroom-sweeper.ts apps/control/src/app/classroom-routes.ts apps/control/src/app/admin-routes.ts apps/control/src/app.ts apps/control/src/__tests__/classroom-admin.test.ts apps/control/src/__tests__/default-deny.test.ts
git commit -m "feat(control): admin classroom routes and expiry sweeper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Leave endpoint and guest info on the session response

**Files:**
- Modify: `packages/contracts/src/index.ts` (`sessionResponseSchema`)
- Modify: `apps/control/src/app/responses.ts` (`sessionResponse`)
- Modify: `apps/control/src/app/workspace-routes.ts` (context, `/api/session`, `/api/leave`)
- Modify: `apps/control/src/app.ts` (`workspaceCtx`)
- Modify: `apps/control/src/metrics.ts` (`KNOWN_WORKSPACE_SUFFIXES`)
- Modify: `apps/control/src/__tests__/default-deny.test.ts` (`GATED_PATHS`)
- Test: `apps/control/src/__tests__/classroom-join.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `stopWorkspace` from Task 4's `app.ts`; `findGuestClassroom` (Task 2).
- Produces:
  - `SessionResponse.user.guest?: { classroomEndsAt: string }`.
  - `WorkspaceRouteContext.stopWorkspace: (workspaceId: WorkspaceId) => Promise<void>`.
  - HTTP `POST /u/:slug/api/leave` → `{ ok: true }` (owner session required).

- [ ] **Step 1: Write the failing tests**

Append to `apps/control/src/__tests__/classroom-join.test.ts` (add `login`, `cookieFrom` to the helpers import and `import { sessionResponseSchema } from "@frc-coderunner/contracts";` and `import type { WorkspaceId } from "@frc-coderunner/contracts";`):

```ts
describe("guest workspace routes", () => {
	test("/api/session reports when the guest's classroom ends", async () => {
		await withApp(async (app) => {
			const classroom = startClassroom(app);
			const joined = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex D" }),
			);
			const response = await app.fetch(
				new Request("http://localhost/u/alex-d/api/session", {
					headers: { cookie: sessionCookieFrom(joined) },
				}),
			);
			const body = sessionResponseSchema.parse(await response.json());
			expect(body.user.guest).toEqual({
				classroomEndsAt: classroom.expires_at,
			});
		});
	});

	test("/api/session has no guest field for OAuth users", async () => {
		await withApp(async (app) => {
			const cookie = cookieFrom(await login(app, "alice"));
			const response = await app.fetch(
				new Request("http://localhost/u/alice/api/session", {
					headers: { cookie },
				}),
			);
			const body = sessionResponseSchema.parse(await response.json());
			expect(body.user.guest).toBeUndefined();
		});
	});

	test("POST /api/leave stops the container and keeps the workspace", async () => {
		await withApp(async (app) => {
			const stopped: WorkspaceId[] = [];
			app.runtime.stopWorkspace = async (workspaceId) => {
				stopped.push(workspaceId);
			};
			const classroom = startClassroom(app);
			const joined = await app.fetch(
				classroomJoinRequest({ code: classroom.code, name: "Alex D" }),
			);
			const { userId } = (await joined.clone().json()) as { userId: string };
			const workspace = app.storage.findWorkspaceByUserId(userId)!;

			const response = await app.fetch(
				new Request("http://localhost/u/alex-d/api/leave", {
					method: "POST",
					headers: { cookie: sessionCookieFrom(joined) },
				}),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });
			expect(stopped).toEqual([workspace.id]);
			expect(app.storage.findWorkspaceByUserId(userId)).not.toBeNull();
		});
	});
});
```

Add to `GATED_PATHS` in `default-deny.test.ts`:

```ts
	{ path: "/u/alice/api/leave", method: "POST", expect: "deny" },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts -t "guest workspace routes"`
Expected: FAIL — `guest` is undefined and `/api/leave` is 404.

- [ ] **Step 3: Extend the session contract**

In `packages/contracts/src/index.ts`, in `sessionResponseSchema.user`, after `role: z.enum(["student", "admin"]),` add:

```ts
		/** Present for classroom guests (decision 043). */
		guest: z.object({ classroomEndsAt: z.string() }).optional(),
```

- [ ] **Step 4: Fill it in `responses.ts`**

Change `sessionResponse` in `apps/control/src/app/responses.ts`:

```ts
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
```

(rest unchanged).

- [ ] **Step 5: Add the routes in `workspace-routes.ts`**

1. Add to imports: `import type { WorkspaceId } from "@frc-coderunner/contracts";` (merge with the existing contracts import) and `import { findGuestClassroom } from "../classrooms";`.
2. Add to `WorkspaceRouteContext`:

```ts
	/** Stops a workspace's run and container; files are kept. */
	stopWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
```

3. In the `/api/session` branch, replace the `return jsonResponse(sessionResponse(...))` with:

```ts
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
```

4. Before the `/api/heartbeat` branch, add:

```ts
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
```

5. In `apps/control/src/app.ts`, add `stopWorkspace,` to the `workspaceCtx` object.
6. In `apps/control/src/metrics.ts`, add `"/api/leave",` to `KNOWN_WORKSPACE_SUFFIXES` after `"/api/heartbeat",`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test apps/control/src/__tests__/classroom-join.test.ts apps/control/src/__tests__/default-deny.test.ts apps/control/src/__tests__/auth-demo.test.ts && bun test packages/contracts`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add packages/contracts/src/index.ts apps/control/src/app apps/control/src/app.ts apps/control/src/metrics.ts apps/control/src/__tests__/classroom-join.test.ts apps/control/src/__tests__/default-deny.test.ts
git commit -m "feat(control): guest leave endpoint and classroom end time on session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/join` page and login link

**Files:**
- Create: `apps/web/src/routes/JoinPage.tsx`
- Modify: `apps/web/src/App.tsx` (route)
- Modify: `apps/web/src/routes/LoginPage.tsx` (link)
- Modify: `apps/web/src/lib/contracts.ts` (re-exports)
- Test: `apps/web/src/routes/JoinPage.test.tsx`

**Interfaces:**
- Consumes: `classroomJoinErrorSchema`, `ClassroomJoinError` (Task 2) via `@/lib/contracts`; `POST /api/auth/classroom/join`.
- Produces: `JoinPage({ onJoined }: { onJoined?: () => void })` — default `onJoined` does `window.location.assign("/")`. Inputs labelled "Classroom code" and "Your name"; submit button "Join"; confirm buttons "Yes, that's me" / "No, change my name".

- [ ] **Step 1: Re-export the contracts for the web app**

In `apps/web/src/lib/contracts.ts` add `ClassroomJoinError,` to the type export list and `classroomJoinErrorSchema,` to the value export list (keep both lists alphabetical).

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/routes/JoinPage.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JoinPage } from "./JoinPage";

function renderJoin(url = "/join") {
	const onJoined = vi.fn();
	render(
		<MemoryRouter initialEntries={[url]}>
			<JoinPage onJoined={onJoined} />
		</MemoryRouter>,
	);
	return onJoined;
}

function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
	const fetchMock = vi.fn();
	for (const response of responses) {
		fetchMock.mockResolvedValueOnce({
			ok: response.status >= 200 && response.status < 300,
			status: response.status,
			json: () => Promise.resolve(response.body),
		});
	}
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, call: number) {
	const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
	return JSON.parse(String(init.body));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("JoinPage", () => {
	test("prefills the code from ?code= keeping only digits", () => {
		renderJoin("/join?code=12 34-56");
		expect(screen.getByLabelText("Classroom code")).toHaveValue("123456");
	});

	test("typing a code keeps only digits, max six", async () => {
		const user = userEvent.setup();
		renderJoin();
		await user.type(screen.getByLabelText("Classroom code"), "12a3 45-678");
		expect(screen.getByLabelText("Classroom code")).toHaveValue("123456");
	});

	test("a successful join posts the code and name, then calls onJoined", async () => {
		const user = userEvent.setup();
		const fetchMock = stubFetch({ status: 200, body: { ok: true, userId: "u1" } });
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "Alex D");
		await user.click(screen.getByRole("button", { name: "Join" }));
		await waitFor(() => expect(onJoined).toHaveBeenCalled());
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/auth/classroom/join");
		expect(sentBody(fetchMock, 0)).toEqual({ code: "123456", name: "Alex D" });
	});

	test("a taken name asks for confirmation and resubmits with confirmExisting", async () => {
		const user = userEvent.setup();
		const fetchMock = stubFetch(
			{
				status: 409,
				body: {
					code: "NAME_TAKEN",
					message: "Alex D already joined this classroom.",
					displayName: "Alex D",
				},
			},
			{ status: 200, body: { ok: true, userId: "u1" } },
		);
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "alex d");
		await user.click(screen.getByRole("button", { name: "Join" }));
		expect(
			await screen.findByText(/already joined this classroom/),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Yes, that's me" }));
		await waitFor(() => expect(onJoined).toHaveBeenCalled());
		expect(sentBody(fetchMock, 1)).toEqual({
			code: "123456",
			name: "alex d",
			confirmExisting: true,
		});
	});

	test("'No, change my name' returns to the form without joining", async () => {
		const user = userEvent.setup();
		stubFetch({
			status: 409,
			body: { code: "NAME_TAKEN", message: "taken", displayName: "Alex D" },
		});
		const onJoined = renderJoin("/join?code=123456");
		await user.type(screen.getByLabelText("Your name"), "Alex D");
		await user.click(screen.getByRole("button", { name: "Join" }));
		await user.click(
			await screen.findByRole("button", { name: "No, change my name" }),
		);
		expect(screen.getByLabelText("Your name")).toHaveValue("Alex D");
		expect(onJoined).not.toHaveBeenCalled();
	});

	test("shows the server's message for a bad code", async () => {
		const user = userEvent.setup();
		stubFetch({
			status: 404,
			body: {
				code: "INVALID_CODE",
				message: "That code isn't valid or has expired.",
			},
		});
		renderJoin("/join?code=000000");
		await user.type(screen.getByLabelText("Your name"), "Alex");
		await user.click(screen.getByRole("button", { name: "Join" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"That code isn't valid or has expired.",
		);
	});

	test("Join stays disabled until there are six digits and a name", async () => {
		const user = userEvent.setup();
		renderJoin();
		const join = screen.getByRole("button", { name: "Join" });
		expect(join).toBeDisabled();
		await user.type(screen.getByLabelText("Classroom code"), "12345");
		await user.type(screen.getByLabelText("Your name"), "Alex");
		expect(join).toBeDisabled();
		await user.type(screen.getByLabelText("Classroom code"), "6");
		expect(join).toBeEnabled();
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test:web -- src/routes/JoinPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./JoinPage"`.

- [ ] **Step 4: Write the page**

Create `apps/web/src/routes/JoinPage.tsx`:

```tsx
import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { classroomJoinErrorSchema } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const inputClass =
	"h-10 w-full rounded-md border border-border bg-card px-3 text-[13px] text-foreground outline-none focus:border-foreground/40";

function digitsOnly(value: string): string {
	return value.replace(/\D/gu, "").slice(0, 6);
}

function goToWorkspace() {
	// "/" redirects a signed-in user to their workspace.
	window.location.assign("/");
}

export function JoinPage({ onJoined = goToWorkspace }: { onJoined?: () => void }) {
	const [searchParams] = useSearchParams();
	const [code, setCode] = useState(() =>
		digitsOnly(searchParams.get("code") ?? ""),
	);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [takenName, setTakenName] = useState<string | null>(null);

	async function join(confirmExisting: boolean) {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/classroom/join", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					code,
					name,
					...(confirmExisting ? { confirmExisting: true } : {}),
				}),
			});
			if (response.ok) {
				onJoined();
				return;
			}
			const parsed = classroomJoinErrorSchema.safeParse(
				await response.json().catch(() => null),
			);
			if (parsed.success && parsed.data.code === "NAME_TAKEN") {
				setTakenName(parsed.data.displayName ?? name.trim());
				return;
			}
			setTakenName(null);
			setError(
				parsed.success
					? parsed.data.message
					: "Couldn't join right now. Please try again.",
			);
		} catch {
			setError("Couldn't reach CodeRunner. Check your connection and try again.");
		} finally {
			setBusy(false);
		}
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		void join(false);
	}

	const canSubmit = code.length === 6 && name.trim() !== "" && !busy;

	return (
		<div className="flex h-screen w-full items-center justify-center bg-background px-8">
			<div className="w-full max-w-[320px]">
				<p className="mb-6 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
					Join a classroom
				</p>

				{error && (
					<div
						role="alert"
						className="mb-5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-300"
					>
						{error}
					</div>
				)}

				{takenName ? (
					<div className="flex flex-col gap-3">
						<p className="text-[13px] text-foreground">
							<strong>{takenName}</strong> already joined this classroom. Is
							that you?
						</p>
						<Button type="button" disabled={busy} onClick={() => void join(true)}>
							Yes, that&apos;s me
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => setTakenName(null)}
						>
							No, change my name
						</Button>
					</div>
				) : (
					<form onSubmit={onSubmit} className="flex flex-col gap-3">
						<label
							htmlFor="classroom-code"
							className="text-[12px] text-muted-foreground"
						>
							Classroom code
						</label>
						<input
							id="classroom-code"
							inputMode="numeric"
							autoComplete="off"
							placeholder="123456"
							value={code}
							onChange={(event) => setCode(digitsOnly(event.target.value))}
							className={cn(inputClass, "font-mono tracking-[0.3em]")}
						/>
						<label
							htmlFor="guest-name"
							className="text-[12px] text-muted-foreground"
						>
							Your name
						</label>
						<input
							id="guest-name"
							autoComplete="off"
							maxLength={40}
							placeholder="First name + last initial (e.g. Alex D)"
							value={name}
							onChange={(event) => setName(event.target.value)}
							className={inputClass}
						/>
						<Button type="submit" disabled={!canSubmit}>
							Join
						</Button>
					</form>
				)}

				<p className="mt-6 text-[10.5px] leading-relaxed text-muted-foreground">
					Have an account?{" "}
					<a href="/login" className="text-foreground/60 underline">
						Sign in instead
					</a>
				</p>
			</div>
		</div>
	);
}
```

- [ ] **Step 5: Route it and link it**

In `apps/web/src/App.tsx`, import `JoinPage` from `@/routes/JoinPage` and add after the `/login` route:

```tsx
	{
		path: "/join",
		element: <JoinPage />,
	},
```

In `apps/web/src/routes/LoginPage.tsx`, replace the "Fine print" paragraph with:

```tsx
					{/* Classroom guests */}
					<a
						href="/join"
						className="mt-3 flex h-11 w-full items-center justify-center rounded-md border border-border text-[13px] font-semibold tracking-wide text-foreground transition-all hover:bg-white/[0.06]"
					>
						Join a classroom
					</a>

					{/* Fine print */}
					<p className="mt-6 text-[10.5px] leading-relaxed text-muted-foreground">
						Not on the roster?{" "}
						<span className="text-foreground/60">
							Ask your coach for a classroom code.
						</span>
					</p>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test:web -- src/routes/JoinPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/web/src/routes/JoinPage.tsx apps/web/src/routes/JoinPage.test.tsx apps/web/src/App.tsx apps/web/src/routes/LoginPage.tsx apps/web/src/lib/contracts.ts
git commit -m "feat(web): join-a-classroom page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Guest user menu with Leave

**Files:**
- Modify: `apps/web/src/components/UserMenu.tsx`
- Modify: `apps/web/src/components/Topbar.tsx`
- Modify: `apps/web/src/routes/WorkspacePage.tsx:196-245`
- Test: `apps/web/src/components/UserMenu.test.tsx`

**Interfaces:**
- Consumes: `SessionResponse.user.guest` (Task 6); `POST /u/:slug/api/leave` (Task 6).
- Produces: `UserMenu` and `Topbar` accept `guest?: { endsAt: string; workspaceSlug: string }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/UserMenu.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/auth-client", () => ({
	authClient: { signOut: vi.fn(() => Promise.resolve()) },
}));

import { authClient } from "@/lib/auth-client";
import { UserMenu } from "./UserMenu";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.mocked(authClient.signOut).mockClear();
});

const guest = { endsAt: "2026-09-30T19:45:00.000Z", workspaceSlug: "alex-d" };

describe("UserMenu", () => {
	test("guests see Leave and the classroom end time instead of their email", async () => {
		const user = userEvent.setup();
		render(
			<UserMenu
				displayName="Alex D"
				email="guest-abc@classroom.invalid"
				avatarUrl={null}
				isAdmin={false}
				guest={guest}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		expect(await screen.findByText(/Guest · ends/)).toBeInTheDocument();
		expect(
			screen.queryByText("guest-abc@classroom.invalid"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Leave" })).toBeInTheDocument();
		expect(screen.queryByRole("menuitem", { name: "Logout" })).toBeNull();
	});

	test("Leave stops the workspace, then signs out", async () => {
		const user = userEvent.setup();
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		});
		vi.stubGlobal("fetch", fetchMock);
		render(
			<UserMenu
				displayName="Alex D"
				email="guest-abc@classroom.invalid"
				avatarUrl={null}
				isAdmin={false}
				guest={guest}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		await user.click(await screen.findByRole("menuitem", { name: "Leave" }));
		await waitFor(() => expect(authClient.signOut).toHaveBeenCalled());
		expect(fetchMock).toHaveBeenCalledWith(
			"/u/alex-d/api/leave",
			expect.objectContaining({ method: "POST" }),
		);
	});

	test("signed-in users still see their email and Logout", async () => {
		const user = userEvent.setup();
		render(
			<UserMenu
				displayName="Alice"
				email="alice@example.com"
				avatarUrl={null}
				isAdmin={false}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "User menu" }));
		expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
		expect(screen.getByRole("menuitem", { name: "Logout" })).toBeInTheDocument();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test:web -- src/components/UserMenu.test.tsx`
Expected: FAIL — the first two tests fail (no "Guest · ends", no "Leave").

- [ ] **Step 3: Implement the guest variant**

In `apps/web/src/components/UserMenu.tsx`:

1. Extend the props:

```tsx
interface UserMenuProps {
	displayName: string;
	email: string;
	avatarUrl: string | null;
	isAdmin: boolean;
	layoutMenu?: ReactNode;
	/** Classroom guests (decision 043): show the end time and a Leave action. */
	guest?: { endsAt: string; workspaceSlug: string };
}
```

2. Below `signOut()`, add:

```tsx
function formatEndsAt(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

async function leaveClassroom(workspaceSlug: string) {
	try {
		await fetch(`/u/${workspaceSlug}/api/leave`, {
			method: "POST",
			credentials: "same-origin",
		});
	} catch {
		// Signing out still hands the computer to the next student; the idle
		// reaper stops the container later.
	}
	await authClient.signOut();
	window.location.assign("/join");
}
```

3. Destructure `guest` in `UserMenu({ … , guest })`.
4. Replace the email line's content `{email}` with `{guest ? `Guest · ends ${formatEndsAt(guest.endsAt)}` : email}`.
5. Replace the Logout `DropdownMenuItem` with:

```tsx
					<DropdownMenuItem
						onClick={() =>
							void (guest ? leaveClassroom(guest.workspaceSlug) : signOut())
						}
						className="gap-2.5 px-2.5 py-2 text-[12.5px]"
					>
						<LogOut className="size-[15px] text-muted-foreground" />
						{guest ? "Leave" : "Logout"}
					</DropdownMenuItem>
```

In `apps/web/src/components/Topbar.tsx`, add to `TopbarProps`:

```tsx
	/** Forwarded to the user menu for classroom guests. */
	guest?: { endsAt: string; workspaceSlug: string };
```

destructure `guest` in `Topbar(...)`, and pass `guest={guest}` to `<UserMenu … />`.

In `apps/web/src/routes/WorkspacePage.tsx`, after the `isAdmin` constant add:

```tsx
	const guest =
		sessionState.status === "ready" && sessionState.session.user.guest
			? {
					endsAt: sessionState.session.user.guest.classroomEndsAt,
					workspaceSlug: sessionState.session.workspace.slug,
				}
			: undefined;
```

and pass `guest={guest}` to `<Topbar … />`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test:web`
Expected: PASS (whole web suite, to catch Topbar/WorkspacePage regressions).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
bun run check:fix && bun run typecheck
git add apps/web/src/components/UserMenu.tsx apps/web/src/components/UserMenu.test.tsx apps/web/src/components/Topbar.tsx apps/web/src/routes/WorkspacePage.tsx
git commit -m "feat(web): guest user menu with Leave

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Admin Classrooms tab

**Files:**
- Create: `apps/web/src/admin/pages/Classrooms.tsx`
- Modify: `apps/web/src/admin/AdminLayout.tsx` (`Tab` union + `tabs`)
- Modify: `apps/web/src/admin/AdminApp.tsx`

**Interfaces:**
- Consumes: `GET /admin/classrooms`, `POST /admin/classrooms`, `POST /admin/classrooms/:id/end` (Task 5); `useAdminPoll`.
- Produces: `Classrooms()` admin page component; tab id `"classrooms"`.

The existing admin pages have no unit tests; this task is verified by typecheck plus the manual check in Step 4, and its API is covered by Task 5.

- [ ] **Step 1: Write the page**

Create `apps/web/src/admin/pages/Classrooms.tsx`:

```tsx
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminPoll } from "../hooks/useAdminPoll";

type ClassroomGuest = {
	id: string;
	displayName: string;
	slug: string | null;
	joinedAt: string;
	lastAccessedAt: string | null;
};

type Classroom = {
	id: string;
	code: string;
	createdAt: string;
	expiresAt: string;
	joinUrl: string;
	guests: ClassroomGuest[];
};

type ClassroomsData = { ok: true; classrooms: Classroom[] };

const DURATIONS = [
	{ minutes: 60, label: "1 hour" },
	{ minutes: 120, label: "2 hours" },
	{ minutes: 240, label: "4 hours" },
	{ minutes: 480, label: "8 hours" },
];

async function fetchClassrooms(): Promise<ClassroomsData> {
	const res = await fetch("/admin/classrooms", { credentials: "same-origin" });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

function formatTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function Classrooms() {
	const { data, loading, error, refetch } = useAdminPoll(
		useCallback(fetchClassrooms, []),
		5000,
	);
	const [duration, setDuration] = useState(240);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	async function start() {
		setBusy(true);
		setActionError(null);
		try {
			const res = await fetch("/admin/classrooms", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ durationMinutes: duration }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				setActionError(body?.error ?? `Start failed (${res.status}).`);
			}
			refetch();
		} finally {
			setBusy(false);
		}
	}

	async function end(classroom: Classroom) {
		const confirmed = window.confirm(
			`End classroom ${classroom.code}? This signs out and deletes its ${classroom.guests.length} guest(s) and their projects.`,
		);
		if (!confirmed) return;
		setBusy(true);
		setActionError(null);
		try {
			const res = await fetch(`/admin/classrooms/${classroom.id}/end`, {
				method: "POST",
				credentials: "same-origin",
			});
			if (!res.ok) setActionError(`End failed (${res.status}).`);
			refetch();
		} finally {
			setBusy(false);
		}
	}

	if (loading && !data)
		return <p className="text-muted-foreground p-4">Loading…</p>;
	if (error) return <p className="text-destructive p-4">Error: {error}</p>;

	return (
		<div className="space-y-6">
			<h2 className="text-xl font-semibold">Classrooms</h2>

			{actionError && (
				<p className="text-destructive text-sm" role="alert">
					{actionError}
				</p>
			)}

			<Card>
				<CardHeader>
					<CardTitle className="text-sm">Start a classroom</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex gap-2">
						<select
							value={duration}
							onChange={(e) => setDuration(Number(e.target.value))}
							className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
						>
							{DURATIONS.map((option) => (
								<option key={option.minutes} value={option.minutes}>
									{option.label}
								</option>
							))}
						</select>
						<Button size="sm" onClick={start} disabled={busy}>
							Start classroom
						</Button>
					</div>
					<p className="text-muted-foreground mt-2 text-xs">
						Students go to the join link, enter the code and their name. When
						the classroom ends, its guests and their projects are deleted.
					</p>
				</CardContent>
			</Card>

			{data?.classrooms.length === 0 && (
				<p className="text-muted-foreground text-sm">No active classrooms.</p>
			)}

			{data?.classrooms.map((classroom) => (
				<Card key={classroom.id}>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="font-mono text-4xl tracking-[0.3em]">
								{classroom.code}
							</CardTitle>
							<Button
								variant="outline"
								size="sm"
								onClick={() => end(classroom)}
								disabled={busy}
							>
								End now
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex items-center gap-2">
							<span className="font-mono text-sm">{classroom.joinUrl}</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									void navigator.clipboard
										.writeText(classroom.joinUrl)
										.catch(() => undefined)
								}
							>
								Copy
							</Button>
						</div>
						<p className="text-muted-foreground text-sm">
							Ends at {formatTime(classroom.expiresAt)} ·{" "}
							{classroom.guests.length} guest(s)
						</p>
						{classroom.guests.length > 0 && (
							<ul className="space-y-1">
								{classroom.guests.map((guest) => (
									<li
										key={guest.id}
										className="flex items-center justify-between rounded px-2 py-1 hover:bg-zinc-800"
									>
										<span className="text-sm">{guest.displayName}</span>
										<span className="text-muted-foreground text-xs">
											joined {formatTime(guest.joinedAt)}
											{guest.lastAccessedAt
												? ` · active ${formatTime(guest.lastAccessedAt)}`
												: ""}
										</span>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}
```

- [ ] **Step 2: Add the tab**

In `apps/web/src/admin/AdminLayout.tsx`, add `| "classrooms"` to the `Tab` union and `{ id: "classrooms", label: "Classrooms" },` to `tabs` right after the `users` entry.

In `apps/web/src/admin/AdminApp.tsx`, add `import { Classrooms } from "./pages/Classrooms";` and `{tab === "classrooms" && <Classrooms />}` after the `users` line.

- [ ] **Step 3: Typecheck and run the web suite**

Run: `bun run check:fix && bun run typecheck && bun run test:web`
Expected: PASS.

- [ ] **Step 4: Manual check**

Run `CODERUNNER_DEMO_MODE=1 bun run dev:control` in one terminal and `bun run dev:web` in another. Demo mode is an admin, so open `/admin/` → **Classrooms**, start a 1-hour classroom, confirm the code, join URL, and "Ends at" render, then click **End now** and confirm it disappears. (The join endpoint itself is disabled in demo mode; it is exercised by Task 10's E2E.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/admin
git commit -m "feat(admin): Classrooms tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end join → leave → rejoin

**Files:**
- Create: `e2e/specs/auth/classroom-join.spec.ts`

**Interfaces:**
- Consumes: everything above; `createClassroom` from `apps/control/src/classrooms`; the E2E `app` fixture.

- [ ] **Step 1: Write the spec**

Create `e2e/specs/auth/classroom-join.spec.ts`:

```ts
/**
 * Classroom join codes (decision 043): a student joins with a code and name,
 * leaves, and rejoins the same workspace by confirming their name.
 */
import { createClassroom } from "../../../apps/control/src/classrooms";
import { expect, test } from "../../fixtures/app";

test("student joins with a classroom code, leaves, and rejoins the same workspace", async ({
	page,
	app,
}) => {
	const classroom = createClassroom(app.storage.db, {
		createdBy: "e2e-admin",
		durationMinutes: 240,
	});

	await page.goto(`/join?code=${classroom.code}`);
	await expect(page.getByLabel("Classroom code")).toHaveValue(classroom.code);
	await page.getByLabel("Your name").fill("Alex D");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page).toHaveURL(/\/u\/alex-d\/$/);

	// An empty project auto-opens Switch Project; close it to reach the menu.
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "User menu" }).click();
	await expect(page.getByText(/Guest · ends/)).toBeVisible();
	await page.getByRole("menuitem", { name: "Leave" }).click();
	await expect(page).toHaveURL(/\/join$/);

	await page.getByLabel("Classroom code").fill(classroom.code);
	await page.getByLabel("Your name").fill("alex d");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page.getByText(/already joined this classroom/)).toBeVisible();
	await page.getByRole("button", { name: "Yes, that's me" }).click();
	await expect(page).toHaveURL(/\/u\/alex-d\/$/);

	const guests = app.storage.db
		.query("SELECT COUNT(*) AS count FROM user WHERE classroomId = ?")
		.get(classroom.id) as { count: number };
	expect(guests.count).toBe(1);
});

test("a wrong code shows an error and stays on /join", async ({ page }) => {
	await page.goto("/join?code=000000");
	await page.getByLabel("Your name").fill("Alex");
	await page.getByRole("button", { name: "Join" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"That code isn't valid or has expired.",
	);
	await expect(page).toHaveURL(/\/join/);
});
```

- [ ] **Step 2: Build the web shell and run the spec**

Run: `bun run e2e -- e2e/specs/auth/classroom-join.spec.ts`
Expected: PASS. (If the E2E harness serves a stale web bundle, rebuild with the command the repo's `e2e` script uses — see `docs/development/testing.md`.)

- [ ] **Step 3: Run the full mocked E2E and security tiers**

Run: `bun run e2e && bun run e2e:security`
Expected: PASS — no regressions in login, roles, or default-deny.

- [ ] **Step 4: Commit**

```bash
bun run check:fix
git add e2e/specs/auth/classroom-join.spec.ts
git commit -m "test(e2e): classroom join, leave, and rejoin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, decision log, and final verification

**Files:**
- Create: `docs/decisions/043-classroom-join-codes.md`
- Modify: `docs/using-coderunner.md` (new section after "Get started")
- Modify: `docs/operating/day-to-day.md` (new section)
- Modify: `AGENTS.md` (status paragraph after "Project Preview (post-V2)")

- [ ] **Step 1: Write the decision log**

Create `docs/decisions/043-classroom-join-codes.md`:

```markdown
# 043 — Classroom join codes

Status: **Accepted** — 2026-09-30

## Context

At team meetings new members rotate through a CodeRunner station every ~20
minutes on school computers. OAuth sign-in on those machines is impractical,
and adding each visitor to the allowlist is not feasible. We still need
something between "anyone on the internet" and "roster only" so bots cannot
create workspaces and hold container slots.

## Decision

An admin starts a **classroom** (default 4 h, 1–12 h) from the admin panel
and gets a random 6-digit code plus a join URL. At `/join` a student enters
the code and their name and becomes a **guest**: a Better Auth user with a
non-null `classroomId`, role `student`, a `guest-…@classroom.invalid`
email, and a normal workspace. Entering the same name again (with a
confirmation step) returns the student to the same workspace.
Impersonation by name is accepted: the threat model is resource abuse, not
student-to-student privacy.

- **Custom Better Auth plugin** (`auth/classroom-plugin.ts`) creates the
  guest and session with Better Auth's own internal APIs and cookie
  handling, so every existing guard works unchanged.
- **Dispatcher** (`app/classroom-routes.ts`) in front of it: disabled in
  demo mode; rate limits *failed* attempts (10 per IP / 100 global per
  10 min) because a whole school shares one IP; retires the browser's
  previous session and stops a previous guest's container.
- **Lifetime:** guest sessions expire with the classroom, and
  `getSessionFromRequest` rejects guests of non-live classrooms. That check
  is needed because Better Auth's `updateAge` refresh would stretch a
  4-hour session to 14 days, and its 5-minute cookie cache would outlive
  "End now".
- **Cleanup:** a 60 s `ClassroomSweeper` (and "End now") deletes guests,
  workspaces and project files via `deleteUserAndWorkspace`, shared with
  the admin user-delete route.
- **Capacity:** guests get a **Leave** button that stops their container
  immediately. With 20-minute rotations and a 30-minute idle reaper,
  containers would otherwise still be running when the next group signs in.

## Alternatives rejected

- **Better Auth `anonymous` plugin.** Always creates a new user (no
  rejoin-by-name), has no way to carry the code/name through its endpoint
  without splitting logic across three hooks, uses the global 14-day
  session, and deletes the anonymous user when someone later signs in with
  OAuth in the same browser. That would orphan our workspace rows,
  container and files. It would save about 30 lines.
- **Signing session cookies ourselves** (as `e2e/fixtures/auth.ts` does).
  Duplicates Better Auth's cookie format and breaks silently on upgrade.
- **Station links** (one pre-signed account per computer). Simpler, but
  gives students no identity of their own, so they can't come back to
  their work.

## Constraints

- Guest columns are Better Auth `additionalFields`; the unique
  `(classroomId, guestNameKey)` index is created in
  `AppStorage.initialize()` after Better Auth's migrations, because the
  `user` table does not exist when our SQL migrations run.
- The per-IP bucket trusts the rightmost `X-Forwarded-For` hop (our
  Caddy). Without a proxy it is spoofable; the global bucket bounds
  guessing to ≈0.24 % per live code over 4 h.
- A determined attacker can trip the global bucket and block new joins
  for ~10 minutes. Already-joined guests are unaffected.
```

- [ ] **Step 2: Update the user guide**

In `docs/using-coderunner.md`, insert after the "Get started" warning block:

```markdown
## Joining a classroom

If your coach gives you a classroom code, you don't need an account:

1. Go to the join link your coach shares (or click **Join a classroom** on
   the sign-in page).
2. Enter the 6-digit code and your first name plus last initial (for
   example `Alex D`), then click **Join**.
3. When you're done, open the menu in the top right and click **Leave** so
   the next student can use the computer.

To come back to your work later in the session, join again with the same
code and name and confirm **Yes, that's me**. Your project is deleted when
the classroom ends. If you want to keep it, ask your coach about getting a
full account.
```

- [ ] **Step 3: Update the operator guide**

In `docs/operating/day-to-day.md`, add a section:

```markdown
## Running a classroom session

For meetings where visitors rotate through a station, start a classroom
instead of adding people to the allowlist:

1. Open **Admin → Classrooms**, pick a duration (default 4 hours), and click
   **Start classroom**.
2. Show the code and join link (`https://<your-host>/join?code=…`) at the
   station. Students join with the code and their name.
3. Ask students to click **Leave** in the user menu when they finish. That
   stops their container right away. If a student forgets, the next student
   joining on the same computer stops it for them, and the idle reaper
   (`IDLE_STOP_MINUTES`, default 30) is the backstop.
4. Click **End now** when you're done, or let the classroom expire. Its
   guests, workspaces, and projects are deleted automatically.

Each classroom allows up to 60 guests. Only running containers count
against `MAX_ACTIVE_CONTAINERS` (see [Capacity](./capacity.md)), so size it
for the number of computers in use at once, not the number of visitors.
Bad codes are rate-limited (10 failures per IP and 100 overall per
10 minutes); successful joins are never limited.
```

- [ ] **Step 4: Update `AGENTS.md`**

After the "Project Preview (post-V2)" paragraph, add:

```markdown
**Classroom join codes (post-V2):** admins start a short-lived classroom
(Admin → Classrooms) with a 6-digit code; students join at `/join` with the
code and their name and become guest users (`user.classroomId` set, role
`student`, no allowlist). A custom Better Auth plugin
(`auth/classroom-plugin.ts`) mints the session; `app/classroom-routes.ts`
rate-limits failed attempts and retires the browser's previous guest
session. Guest sessions die with the classroom (checked in
`getSessionFromRequest`), guests have a **Leave** button that stops their
container, and `ClassroomSweeper` deletes guests of ended/expired
classrooms. See `docs/decisions/043-classroom-join-codes.md`.
```

Also change "active 011–041" in the Key References line to "active 011–043".

- [ ] **Step 5: Full verification**

Run each and confirm it passes:

```bash
bun run check:fix
bun run verify
bun run test
bun run test:web
bun run e2e
bun run e2e:security
bun run docs:build
```

Expected: all green. `docs:build` confirms the new doc sections render (decision logs are excluded from the site).

- [ ] **Step 6: Refresh the knowledge graph and commit**

```bash
graphify update .
git add docs/decisions/043-classroom-join-codes.md docs/using-coderunner.md docs/operating/day-to-day.md AGENTS.md graphify-out
git commit -m "docs: classroom join codes (decision 043)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
