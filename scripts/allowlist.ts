#!/usr/bin/env bun
/**
 * Manage the email/domain allowlist.
 *
 * Usage:
 *   bun scripts/allowlist.ts list
 *   bun scripts/allowlist.ts add <email-or-domain>
 *   bun scripts/allowlist.ts remove <email-or-domain>
 *
 * Examples:
 *   bun scripts/allowlist.ts add coach@frcteam.org
 *   bun scripts/allowlist.ts add frcteam.org
 *   bun scripts/allowlist.ts remove old-member@frcteam.org
 *   bun scripts/allowlist.ts list
 */

import { resolve } from "node:path";
import {
	addAllowlistEntry,
	loadAllowlist,
	removeAllowlistEntry,
	setAllowlistPath,
} from "../apps/control/src/auth/allowlist";

const dataDir = Bun.env.FRC_DATA_DIR ?? "data";
setAllowlistPath(dataDir);

const [command, value] = process.argv.slice(2);

function isLikelyDomain(v: string): boolean {
	return !v.includes("@") && v.includes(".");
}

async function main(): Promise<void> {
	await loadAllowlist();

	switch (command) {
		case "list": {
			const data = await loadAllowlist();
			if (data.emails.length === 0 && data.domains.length === 0) {
				console.log(
					"Allowlist is empty — OAuth sign-in is blocked until an email or domain is added.",
				);
				return;
			}
			if (data.emails.length > 0) {
				console.log("Emails:");
				for (const e of data.emails) console.log(`  ${e}`);
			}
			if (data.domains.length > 0) {
				console.log("Domains:");
				for (const d of data.domains) console.log(`  ${d}`);
			}
			return;
		}

		case "add": {
			if (!value) {
				console.error("Usage: bun scripts/allowlist.ts add <email-or-domain>");
				process.exit(1);
			}
			const kind = isLikelyDomain(value) ? "domain" : "email";
			const result = await addAllowlistEntry(kind, value);
			console.log(`Added ${kind}: ${value.toLowerCase()}`);
			console.log(
				`Allowlist now has ${result.emails.length} email(s) and ${result.domains.length} domain(s).`,
			);
			console.log(`File: ${resolve(dataDir, "allowlist.json")}`);
			return;
		}

		case "remove": {
			if (!value) {
				console.error(
					"Usage: bun scripts/allowlist.ts remove <email-or-domain>",
				);
				process.exit(1);
			}
			const kind = isLikelyDomain(value) ? "domain" : "email";
			const result = await removeAllowlistEntry(kind, value);
			console.log(`Removed ${kind}: ${value.toLowerCase()}`);
			console.log(
				`Allowlist now has ${result.emails.length} email(s) and ${result.domains.length} domain(s).`,
			);
			return;
		}

		default:
			console.error(
				"Usage: bun scripts/allowlist.ts <list|add|remove> [email-or-domain]",
			);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
