import { afterEach, describe, expect, test } from "bun:test";
import { onRequest } from "../deploy/cloudflare/functions/[[path]]";

const originalFetch = globalThis.fetch;

function testEnv(assetRequests: Request[] = []) {
	return {
		BACKEND_ORIGIN: "https://origin.example.test",
		ASSETS: {
			fetch: async (request: Request) => {
				assetRequests.push(request);
				return new Response("asset");
			},
		},
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Cloudflare Pages catch-all function", () => {
	test("exports the Pages Functions entrypoint", () => {
		expect(typeof onRequest).toBe("function");
	});

	test("serves shell routes from the Pages ASSETS binding", async () => {
		const assetRequests: Request[] = [];
		const response = await onRequest({
			request: new Request("https://coderunner.example.test/u/alice"),
			env: testEnv(assetRequests),
		});

		expect(await response.text()).toBe("asset");
		expect(assetRequests).toHaveLength(1);
		expect(assetRequests[0]?.url).toBe(
			"https://coderunner.example.test/u/alice",
		);
	});

	test("proxies backend paths to BACKEND_ORIGIN with the browser host", async () => {
		const proxiedRequests: Request[] = [];
		globalThis.fetch = (async (input: Request | string | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			proxiedRequests.push(request);
			return new Response("origin");
		}) as typeof fetch;

		const response = await onRequest({
			request: new Request("https://coderunner.example.test/healthz?ready=1"),
			env: testEnv(),
		});

		expect(await response.text()).toBe("origin");
		expect(proxiedRequests).toHaveLength(1);
		expect(proxiedRequests[0]?.url).toBe(
			"https://origin.example.test/healthz?ready=1",
		);
		expect(proxiedRequests[0]?.headers.get("X-Forwarded-Host")).toBe(
			"coderunner.example.test",
		);
	});

	test("proxies workspace WebSocket paths to BACKEND_ORIGIN", async () => {
		const proxiedRequests: Request[] = [];
		globalThis.fetch = (async (input: Request | string | URL) => {
			const request = input instanceof Request ? input : new Request(input);
			proxiedRequests.push(request);
			return new Response("origin");
		}) as typeof fetch;

		await onRequest({
			request: new Request("https://coderunner.example.test/u/alice/ws/run", {
				headers: { Upgrade: "websocket" },
			}),
			env: testEnv(),
		});

		expect(proxiedRequests).toHaveLength(1);
		expect(proxiedRequests[0]?.url).toBe(
			"https://origin.example.test/u/alice/ws/run",
		);
	});

	test("returns a service-unavailable JSON response when the origin is down", async () => {
		globalThis.fetch = (async () => {
			throw new Error("origin down");
		}) as unknown as typeof fetch;

		const response = await onRequest({
			request: new Request(
				"https://coderunner.example.test/api/auth/providers",
			),
			env: testEnv(),
		});

		expect(response.status).toBe(503);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(await response.json()).toEqual({ error: "service_unavailable" });
	});
});
