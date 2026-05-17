/**
 * Playwright globalSetup — runs once before any tests.
 *
 * Responsibilities:
 *  1. Ensure E2E_TEST=1 is set so the control plane installs the Better Auth
 *     `testUtils` plugin (gated in apps/control/src/auth/auth.ts).
 *  2. Build the web bundle (apps/web/dist/) so the control plane can serve it
 *     in-process — a stale bundle is the failure mode that defeats the suite's
 *     whole point.
 *
 * The build is skipped if `PLAYWRIGHT_SKIP_WEB_BUILD=1` is set, to support
 * the inner-loop dev cycle where the user has already built once.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
	if (process.env.E2E_TEST !== "1") {
		throw new Error(
			"E2E_TEST=1 must be set before running Playwright. The npm scripts (`bun run e2e`) do this for you.",
		);
	}

	if (process.env.PLAYWRIGHT_SKIP_WEB_BUILD === "1") {
		return;
	}

	const root = resolve(__dirname, "..");
	const distIndex = resolve(root, "apps/web/dist/index.html");

	// Always rebuild — a stale dist that exists is worse than no dist.
	const result = spawnSync("bun", ["run", "build:web"], {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(`bun run build:web failed with status ${result.status}`);
	}
	if (!existsSync(distIndex)) {
		throw new Error(
			`Expected web bundle at ${distIndex} but it doesn't exist.`,
		);
	}
}
