interface Env {
	BACKEND_ORIGIN: string;
	ASSETS: { fetch(request: Request): Promise<Response> };
}

interface PagesFunctionContext {
	request: Request;
	env: Env;
}

// Top-level paths that go directly to the origin.
const TOP_LEVEL_PROXIED = [
	"/api/",
	"/admin/",
	"/healthz",
	"/metrics",
	"/scope/",
];

// Backend subpaths under /u/<slug>/ that go to the origin.
// The workspace SPA shell (/u/:slug and /u/:slug/) is intentionally excluded
// so it is served from ASSETS — this ensures the offline screen loads even
// when the VM is down.
const WORKSPACE_BACKEND_RE = /^\/u\/[^/]+\/(api|ws|vscode|sim|assets)(\/|$)/;

function isProxiedPath(pathname: string): boolean {
	if (WORKSPACE_BACKEND_RE.test(pathname)) return true;
	return TOP_LEVEL_PROXIED.some(
		(prefix) =>
			pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix),
	);
}

export async function onRequest({
	request,
	env,
}: PagesFunctionContext): Promise<Response> {
	const url = new URL(request.url);

	if (!isProxiedPath(url.pathname)) {
		return env.ASSETS.fetch(request);
	}

	const isWebSocket =
		request.headers.get("Upgrade")?.toLowerCase() === "websocket";

	// Surface a missing/invalid BACKEND_ORIGIN as the same 503 the offline
	// screen recognizes, instead of letting `new URL` throw and trigger CF's
	// bare 500.
	if (!env.BACKEND_ORIGIN) {
		return serviceUnavailable(isWebSocket);
	}

	let backendUrl: URL;
	try {
		backendUrl = new URL(url.pathname + url.search, env.BACKEND_ORIGIN);
	} catch {
		return serviceUnavailable(isWebSocket);
	}

	const headers = new Headers(request.headers);
	// Tell the control plane what hostname the browser used so better-auth
	// constructs correct OAuth callback URLs and cookie domains.
	headers.set("X-Forwarded-Host", url.host);

	try {
		const backendRequest = new Request(backendUrl, {
			method: request.method,
			headers,
			body: request.body,
			redirect: "manual",
		});
		return await fetch(backendRequest);
	} catch {
		return serviceUnavailable(isWebSocket);
	}
}

function serviceUnavailable(isWebSocket: boolean): Response {
	if (isWebSocket) {
		// Browser WebSocket API maps a non-101 response to onclose/onerror,
		// which triggers the existing reconnect backoff in the hooks.
		return new Response("Service Unavailable", { status: 503 });
	}
	return new Response(JSON.stringify({ error: "service_unavailable" }), {
		status: 503,
		headers: { "Content-Type": "application/json" },
	});
}
