/**
 * T8.1 — editor proxy returns the fake vscode sentinel string when the workspace
 * runtime is running.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("editor proxy returns fake-vscode sentinel string", async ({
	page,
	app,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "Alice" });
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	const resp = await app.fetch(
		new Request(
			`${app.storage.config.baseUrl}/u/${session.user.slug}/vscode/`,
			{
				headers: { cookie: cookieHeader(session) },
			},
		),
	);
	expect(resp.status).toBe(200);
	const body = await resp.text();
	expect(body).toContain("data-fake-vscode-ready");
});
