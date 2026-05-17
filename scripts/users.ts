#!/usr/bin/env bun
/**
 * User management CLI — promote/demote users.
 *
 * Usage:
 *   bun scripts/users.ts promote <email>
 *   bun scripts/users.ts demote <email>
 *   bun scripts/users.ts list
 *
 * Requires a running database at FRC_DB_PATH (default: data/app.db).
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";

const dbPath =
	Bun.env.FRC_DB_PATH ?? resolve(Bun.env.FRC_DATA_DIR ?? "data", "app.db");

function getDb(): Database {
	try {
		return new Database(dbPath);
	} catch (_err) {
		console.error(`Cannot open database at ${dbPath}. Is the path correct?`);
		process.exit(1);
	}
}

type UserRow = {
	id: string;
	name: string;
	email: string;
	role: string | null;
	slug: string | null;
};

function setRole(db: Database, email: string, role: string): void {
	const user = db
		.query("SELECT id, name, email, role FROM user WHERE email = ?")
		.get(email.toLowerCase()) as UserRow | null;
	if (!user) {
		console.error(`No user found with email: ${email}`);
		process.exit(1);
	}

	db.query("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?").run(
		role,
		new Date().toISOString(),
		user.id,
	);
	console.log(`${user.name} (${user.email}): role set to "${role}"`);
}

const [command, email] = process.argv.slice(2);

const db = getDb();
try {
	switch (command) {
		case "promote": {
			if (!email) {
				console.error("Usage: bun scripts/users.ts promote <email>");
				process.exit(1);
			}
			setRole(db, email, "admin");
			break;
		}

		case "demote": {
			if (!email) {
				console.error("Usage: bun scripts/users.ts demote <email>");
				process.exit(1);
			}
			setRole(db, email, "student");
			break;
		}

		case "list": {
			const users = db
				.query("SELECT id, name, email, role, slug FROM user ORDER BY name")
				.all() as UserRow[];
			if (users.length === 0) {
				console.log("No users in the database.");
			} else {
				console.log(
					`${"Email".padEnd(35)} ${"Name".padEnd(20)} ${"Role".padEnd(8)} Slug`,
				);
				console.log("-".repeat(80));
				for (const u of users) {
					console.log(
						`${u.email.padEnd(35)} ${u.name.padEnd(20)} ${(u.role ?? "student").padEnd(8)} ${u.slug ?? ""}`,
					);
				}
				console.log(`\n${users.length} user(s) total.`);
			}
			break;
		}

		default:
			console.error(
				"Usage: bun scripts/users.ts <promote|demote|list> [email]",
			);
			process.exit(1);
	}
} finally {
	db.close();
}
