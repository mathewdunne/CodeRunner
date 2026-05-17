import { describe, expect, test } from "bun:test";
import { statusClass, templateRoute } from "../metrics";

describe("templateRoute", () => {
	test("returns known top-level paths verbatim", () => {
		for (const path of [
			"/",
			"/login",
			"/healthz",
			"/admin",
			"/admin/",
			"/favicon.ico",
			"/coderunner-icon.png",
			"/api/openapi.json",
			"/api/auth/providers",
			"/scope",
			"/metrics",
		]) {
			expect(templateRoute(path)).toBe(path);
		}
	});

	test("collapses prefix-shared paths", () => {
		expect(templateRoute("/api/auth/session/refresh")).toBe("/api/auth/*");
		expect(templateRoute("/scope/bundled/Crescendo/field.json")).toBe(
			"/scope/*",
		);
		expect(templateRoute("/assets/index-abc123.js")).toBe("/assets/*");
		expect(templateRoute("/admin/api/workspaces")).toBe("/admin/*");
	});

	test("strips workspace slug to :slug", () => {
		expect(templateRoute("/u/jane/")).toBe("/u/:slug/");
		expect(templateRoute("/u/student-42/api/sim/status")).toBe(
			"/u/:slug/api/sim/status",
		);
		expect(templateRoute("/u/x/sim/alive")).toBe("/u/:slug/sim/alive");
		expect(templateRoute("/u/x/ws/run")).toBe("/u/:slug/ws/run");
	});

	test("collapses vscode and assets subtrees inside workspace", () => {
		expect(templateRoute("/u/jane/vscode")).toBe("/u/:slug/vscode/*");
		expect(templateRoute("/u/jane/vscode/static/out/vs/loader.js")).toBe(
			"/u/:slug/vscode/*",
		);
		expect(templateRoute("/u/jane/assets/index-abc.css")).toBe(
			"/u/:slug/assets/*",
		);
	});

	test("unknown workspace suffix falls back to /u/:slug/*", () => {
		expect(templateRoute("/u/jane/something-new")).toBe("/u/:slug/*");
	});

	test("unrecognized paths bucket into 'other'", () => {
		expect(templateRoute("/totally-unknown-path")).toBe("other");
	});

	test("templating output cardinality is bounded for varied slugs", () => {
		const samples = [
			"/u/alice/api/sim/status",
			"/u/bob/api/sim/status",
			"/u/charlie-123/api/sim/status",
			"/u/dave/api/sim/status",
		];
		const unique = new Set(samples.map(templateRoute));
		expect(unique.size).toBe(1);
		expect([...unique][0]).toBe("/u/:slug/api/sim/status");
	});
});

describe("statusClass", () => {
	test("buckets by hundreds digit", () => {
		expect(statusClass(200)).toBe("2xx");
		expect(statusClass(204)).toBe("2xx");
		expect(statusClass(301)).toBe("3xx");
		expect(statusClass(404)).toBe("4xx");
		expect(statusClass(503)).toBe("5xx");
	});

	test("out-of-range values become 'other'", () => {
		expect(statusClass(0)).toBe("other");
		expect(statusClass(99)).toBe("other");
		expect(statusClass(600)).toBe("other");
	});
});
