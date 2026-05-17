/**
 * T35.1 — Two workspaces' NT4 traffic remains isolated (decision 013).
 *
 * Each workspace gets its own fake NT4 server that announces a unique topic on
 * connect. The test connects to each workspace's NT4 proxy endpoint and verifies
 * that only the correct workspace's topics are delivered.
 */

import { expect, test } from "../../fixtures/app";
import { cookieHeader, loginAs } from "../../fixtures/auth";
import { startFakeNt4 } from "../../fixtures/fake-nt4";

test("NT4 traffic isolated per workspace", async ({
	app,
	page,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	// Stand up two independent fake NT4 servers with different topic announcements
	const fakeNt4A = await startFakeNt4({
		announceTopics: [{ name: "/Robot/A", type: "string", id: 1 }],
	});
	const fakeNt4B = await startFakeNt4({
		announceTopics: [{ name: "/Robot/B", type: "string", id: 2 }],
	});

	try {
		// Create two users
		const alice = await loginAs(page, app, { name: "NtAlice" });
		const bob = await loginAs(page, app, { name: "NtBob" });

		const aliceWs = app.storage.findWorkspaceBySlug(alice.user.slug as never)!;
		const bobWs = app.storage.findWorkspaceBySlug(bob.user.slug as never)!;

		// Seed runtimes: Alice's NT4 points to fakeNt4A, Bob's to fakeNt4B
		runtime.setRuntime({
			workspaceId: aliceWs.id,
			state: "running",
			image: "coderunner-workspace",
			runtimeName: `frc-${aliceWs.id.slice(0, 8)}`,
			ports: { nt4: 8080, vscode: 8081, halsim: 8082 },
			endpoints: {
				vscode: {
					httpBaseUrl: fakeVscode.httpBaseUrl,
					wsBaseUrl: fakeVscode.wsBaseUrl,
					basePath: "/",
				},
				nt4: {
					httpUrl: fakeNt4A.httpUrl,
					wsUrl: fakeNt4A.wsUrl,
				},
				halsim: { wsUrl: fakeHalsim.wsUrl },
			},
			lastUsedAt: new Date().toISOString(),
			error: null,
		});

		runtime.setRuntime({
			workspaceId: bobWs.id,
			state: "running",
			image: "coderunner-workspace",
			runtimeName: `frc-${bobWs.id.slice(0, 8)}`,
			ports: { nt4: 9080, vscode: 9081, halsim: 9082 },
			endpoints: {
				vscode: {
					httpBaseUrl: fakeVscode.httpBaseUrl,
					wsBaseUrl: fakeVscode.wsBaseUrl,
					basePath: "/",
				},
				nt4: {
					httpUrl: fakeNt4B.httpUrl,
					wsUrl: fakeNt4B.wsUrl,
				},
				halsim: { wsUrl: fakeHalsim.wsUrl },
			},
			lastUsedAt: new Date().toISOString(),
			error: null,
		});

		const baseUrl = app.storage.config.baseUrl;

		// Connect Alice to her NT4 proxy
		const aliceNt4Url = `${baseUrl.replace(/^http/, "ws")}/u/${alice.user.slug}/sim/nt4`;
		const aliceSocket = new WebSocket(aliceNt4Url, {
			headers: { cookie: cookieHeader(alice) },
		} as never);

		// Connect Bob to his NT4 proxy
		const bobNt4Url = `${baseUrl.replace(/^http/, "ws")}/u/${bob.user.slug}/sim/nt4`;
		const bobSocket = new WebSocket(bobNt4Url, {
			headers: { cookie: cookieHeader(bob) },
		} as never);

		// Collect messages from each socket
		const aliceMessages: unknown[] = [];
		const bobMessages: unknown[] = [];

		const aliceReady = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Alice got no NT4 messages")),
				5000,
			);
			aliceSocket.addEventListener(
				"message",
				(event) => {
					aliceMessages.push(JSON.parse(event.data as string));
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});

		const bobReady = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Bob got no NT4 messages")),
				5000,
			);
			bobSocket.addEventListener(
				"message",
				(event) => {
					bobMessages.push(JSON.parse(event.data as string));
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});

		// Wait for both to receive their first message
		await Promise.all([aliceReady, bobReady]);

		// Alice should only see /Robot/A topics
		expect(aliceMessages).toEqual([
			{
				method: "announce",
				params: { name: "/Robot/A", type: "string", id: 1 },
			},
		]);

		// Bob should only see /Robot/B topics
		expect(bobMessages).toEqual([
			{
				method: "announce",
				params: { name: "/Robot/B", type: "string", id: 2 },
			},
		]);

		// Cross-check: Alice never gets Bob's topic and vice versa
		const allAlice = aliceMessages.map((m) => JSON.stringify(m));
		const allBob = bobMessages.map((m) => JSON.stringify(m));
		expect(allAlice.some((m) => m.includes("/Robot/B"))).toBe(false);
		expect(allBob.some((m) => m.includes("/Robot/A"))).toBe(false);

		// Verify both fake NT4 servers saw exactly one connection each
		expect(fakeNt4A.connections()).toBe(1);
		expect(fakeNt4B.connections()).toBe(1);

		aliceSocket.close();
		bobSocket.close();
	} finally {
		await fakeNt4A.stop();
		await fakeNt4B.stop();
	}
});

test("NT4 proxy rejects cross-workspace access", async ({
	app,
	page,
	runtime,
	fakeVscode,
	fakeHalsim,
}) => {
	const fakeNt4 = await startFakeNt4({
		announceTopics: [{ name: "/Robot/Secret", type: "string", id: 99 }],
	});

	try {
		const alice = await loginAs(page, app, { name: "NtCross1" });
		const bob = await loginAs(page, app, { name: "NtCross2" });

		const bobWs = app.storage.findWorkspaceBySlug(bob.user.slug as never)!;

		// Only Bob has a running NT4 endpoint
		runtime.setRuntime({
			workspaceId: bobWs.id,
			state: "running",
			image: "coderunner-workspace",
			runtimeName: `frc-${bobWs.id.slice(0, 8)}`,
			ports: { nt4: 8080, vscode: 8081, halsim: 8082 },
			endpoints: {
				vscode: {
					httpBaseUrl: fakeVscode.httpBaseUrl,
					wsBaseUrl: fakeVscode.wsBaseUrl,
					basePath: "/",
				},
				nt4: {
					httpUrl: fakeNt4.httpUrl,
					wsUrl: fakeNt4.wsUrl,
				},
				halsim: { wsUrl: fakeHalsim.wsUrl },
			},
			lastUsedAt: new Date().toISOString(),
			error: null,
		});

		const baseUrl = app.storage.config.baseUrl;

		// Alice tries to access Bob's NT4 endpoint → should get 403
		const resp = await app.fetch(
			new Request(`${baseUrl}/u/${bob.user.slug}/sim/nt4`, {
				headers: {
					cookie: cookieHeader(alice),
					upgrade: "websocket",
					connection: "Upgrade",
					"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version": "13",
				},
			}),
		);
		expect(resp.status).toBe(403);

		// Bob's fake NT4 should have zero connections (request was rejected)
		expect(fakeNt4.connections()).toBe(0);
	} finally {
		await fakeNt4.stop();
	}
});
