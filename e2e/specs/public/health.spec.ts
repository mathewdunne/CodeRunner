/**
 * T37.1 — healthz returns 200 unauthenticated and locks the contract.
 */
import { expect, test } from "../../fixtures/app";

test("GET /healthz works without auth", async ({ app }) => {
	const response = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/healthz`),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { ok: boolean; service: string };
	expect(body.ok).toBe(true);
	expect(body.service).toBe("control");
});
