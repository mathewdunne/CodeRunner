/**
 * T36.1 — GET /api/openapi.json works without auth and is workspace-agnostic.
 * Anchor: decision 015.
 */
import { expect, test } from "../../fixtures/app";

test("GET /api/openapi.json — 200, JSON contains paths, no workspace/email leak", async ({
	app,
}) => {
	const response = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/api/openapi.json`),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as Record<string, unknown>;
	expect(body).toHaveProperty("paths");

	const asString = JSON.stringify(body);
	// No workspace IDs or test emails should appear in the public spec
	expect(asString).not.toMatch(/ws_[a-f0-9]{32}/);
	expect(asString).not.toMatch(/@test\.local/);
});
