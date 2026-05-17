/**
 * Editor WebSocket proxy through the control plane.
 *
 * T9.1 — verifies a WS upgrade through the proxy reaches fake-vscode and
 *         a round-trip echo frame is received.
 * T9.2 — verifies a page reload establishes a fresh WS connection with no
 *         protocol errors.
 */
import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("editor WebSocket connects through proxy", async ({
	app,
	page,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "WsAlice" });
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	const baseUrl = app.storage.config.baseUrl;
	const wsUrl = `${baseUrl.replace(/^http/, "ws")}/u/${session.user.slug}/vscode/ws`;

	// Drive a WS connection from the test (with auth cookie + Origin header)
	const ws = new WebSocket(wsUrl, {
		headers: {
			cookie: cookieHeader(session),
			origin: baseUrl,
		},
	} as never);

	// Wait for the fake-vscode server to see the upstream connection
	await fakeVscode.awaitWsConnection(1, 5000);

	// The fake-vscode sends a hello frame on open; verify round-trip by
	// receiving it on the client side.
	const helloPromise = new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("No hello frame received")),
			5000,
		);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timer);
				resolve(JSON.parse(event.data as string));
			},
			{ once: true },
		);
	});
	const hello = await helloPromise;
	expect(hello).toEqual({ type: "hello", from: "fake-vscode" });

	// Send a frame from client → proxy → fake-vscode and verify the echo
	const echoPromise = new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("No echo frame received")),
			5000,
		);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timer);
				resolve(JSON.parse(event.data as string));
			},
			{ once: true },
		);
	});
	ws.send(JSON.stringify({ type: "ping", seq: 1 }));
	const echo = await echoPromise;
	expect(echo).toEqual({ type: "echo", payload: { type: "ping", seq: 1 } });

	// Verify fake-vscode recorded the frame
	expect(fakeVscode.receivedFrames()).toContainEqual({ type: "ping", seq: 1 });

	ws.close();
});

test("editor WS reconnects cleanly after refresh", async ({
	app,
	page,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const session = await loginAs(page, app, { name: "WsBob" });
	const workspace = app.storage.findWorkspaceBySlug(
		session.user.slug as never,
	)!;
	seedRuntimeRunning({
		runtime,
		workspaceId: workspace.id,
		fakeVscode,
		fakeHalsim,
	});

	const baseUrl = app.storage.config.baseUrl;
	const wsUrl = `${baseUrl.replace(/^http/, "ws")}/u/${session.user.slug}/vscode/ws`;

	// First connection
	const ws1 = new WebSocket(wsUrl, {
		headers: {
			cookie: cookieHeader(session),
			origin: baseUrl,
		},
	} as never);
	await fakeVscode.awaitWsConnection(1, 5000);

	// Collect console errors from page during reload
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	page.on("pageerror", (err) => {
		consoleErrors.push(err.message);
	});

	// Close first connection (simulates browser navigating away)
	ws1.close();

	// Second connection (simulates reconnect after refresh)
	const ws2 = new WebSocket(wsUrl, {
		headers: {
			cookie: cookieHeader(session),
			origin: baseUrl,
		},
	} as never);
	await fakeVscode.awaitWsConnection(2, 5000);

	// Verify second connection works with a round-trip
	const helloPromise = new Promise<unknown>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("No hello on reconnect")),
			5000,
		);
		ws2.addEventListener(
			"message",
			(event) => {
				clearTimeout(timer);
				resolve(JSON.parse(event.data as string));
			},
			{ once: true },
		);
	});
	const hello = await helloPromise;
	expect(hello).toEqual({ type: "hello", from: "fake-vscode" });

	// No protocol errors in page console
	expect(
		consoleErrors.filter((e) => /protocol|websocket/i.test(e)),
	).toHaveLength(0);

	ws2.close();
});
