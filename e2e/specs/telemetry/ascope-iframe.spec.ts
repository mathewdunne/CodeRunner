/**
 * T34.1 — /scope route returns the AS Lite bundle HTML for any visitor (no
 * workspace ownership required). The bundled assets ship from the
 * AdvantageScope dist that the fixture provides.
 */
import { expect, test } from "../../fixtures/app";

test("GET /scope returns AS Lite HTML shell", async ({ app }) => {
	const resp = await app.fetch(
		new Request(`${app.storage.config.baseUrl}/scope/`),
	);
	expect(resp.status).toBe(200);
	const body = await resp.text();
	expect(body).toContain("AS Lite");
});
