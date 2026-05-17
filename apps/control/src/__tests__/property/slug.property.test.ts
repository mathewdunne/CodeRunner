/**
 * Property tests for `slugFromEmail` and the storage workspace-slug collision suffix.
 *
 * P4 — output always matches /^[a-z0-9][a-z0-9_-]{0,39}$/ (or is the "student" fallback).
 * P5 — output is never empty.
 * P6 — for any set of N emails sharing a slug prefix, all generated workspace slugs are unique
 *      and ≤40 chars. (Drives the slug-collision suffix path in storage.)
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { ControlApp } from "../../app";
import { slugFromEmail } from "../../auth/auth";
import { withApp } from "../helpers";

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS ?? 100);

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const emailArb: fc.Arbitrary<string> = fc
	.tuple(
		fc.stringMatching(/^[A-Za-z0-9._+-]{1,30}$/u),
		fc.constantFrom("allowed.test", "example.com", "frcteam.org"),
	)
	.map(([local, domain]) => `${local}@${domain}`);

describe("slugFromEmail — properties", () => {
	test("P4 output is either valid-slug or the literal 'student' fallback", () => {
		fc.assert(
			fc.property(fc.string(), (raw) => {
				const slug = slugFromEmail(`${raw}@example.com`);
				expect(SLUG_RE.test(slug) || slug === "student").toBe(true);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("P5 output is never empty", () => {
		fc.assert(
			fc.property(fc.string(), (raw) => {
				const slug = slugFromEmail(raw);
				expect(slug.length).toBeGreaterThan(0);
			}),
			{ numRuns: NUM_RUNS },
		);
	});

	test("normalizes diacritics and unicode", () => {
		expect(slugFromEmail("Élise@example.com")).toBe("elise");
		expect(slugFromEmail("José@example.com")).toBe("jose");
	});

	test("strips leading/trailing dashes and collapses repeats", () => {
		expect(slugFromEmail("--alice--@example.com")).toBe("alice");
		expect(slugFromEmail("a..b..c@example.com")).toBe("a-b-c");
	});

	test("falls back to 'student' for all-non-alphanumeric locals", () => {
		expect(slugFromEmail("...@example.com")).toBe("student");
		expect(slugFromEmail("___@example.com")).toBe("student");
	});

	test("output is ≤40 chars even for long locals", () => {
		fc.assert(
			fc.property(emailArb, (email) => {
				expect(slugFromEmail(email).length).toBeLessThanOrEqual(40);
			}),
			{ numRuns: NUM_RUNS },
		);
	});
});

describe("workspace slug collision suffix — property", () => {
	test("P6 N users with colliding slug get N unique workspace slugs", async () => {
		await withApp(async (app: ControlApp) => {
			const slugs: string[] = [];
			for (let i = 0; i < 5; i += 1) {
				const userId = `user_${i.toString().padStart(20, "0")}`;
				const now = new Date().toISOString();
				app.storage.db
					.query(
						"INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						userId,
						"Alice",
						`alice${i}@example.com`,
						0,
						null,
						now,
						now,
						"student",
						"alice",
					);
				const ws = await app.storage.ensureWorkspaceForUser(userId, "alice");
				slugs.push(ws.slug);
			}
			// All slugs unique
			expect(new Set(slugs).size).toBe(slugs.length);
			// First should be "alice"; later ones a unique numeric suffix
			expect(slugs[0]).toBe("alice");
			for (const slug of slugs) {
				expect(slug.length).toBeLessThanOrEqual(40);
				expect(SLUG_RE.test(slug)).toBe(true);
			}
		});
	});
});
