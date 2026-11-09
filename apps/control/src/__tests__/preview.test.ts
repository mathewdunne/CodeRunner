import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PreviewDocumentsResponse } from "@frc-coderunner/contracts";
import type { ControlApp } from "../app";
import {
	mintPreviewToken,
	PREVIEW_TOKEN_TTL_SECONDS,
	verifyPreviewToken,
} from "../app/preview-token";
import {
	cookieFrom,
	createFakeDocker,
	login,
	withApp,
	workspaceProjectPath,
} from "./helpers";

const REPORT = "build/reports/tests/test";

async function write(
	projectPath: string,
	relativePath: string,
	contents: string,
): Promise<void> {
	const target = join(projectPath, relativePath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, contents, "utf8");
}

async function seedProject(projectPath: string): Promise<void> {
	await write(projectPath, "README.md", "# Robot\n\nHello.\n");
	await write(projectPath, "LICENSE.md", "# Licence\n");
	await write(projectPath, "docs/guide.md", "# Guide\n");
	await write(projectPath, "docs/notes/index.html", "<p>notes</p>");
	await write(projectPath, `${REPORT}/index.html`, "<p>report</p>");
	await write(projectPath, `${REPORT}/css/base.css`, "body{color:red}");
	await write(projectPath, `${REPORT}/js/report.js`, "console.log(1)");
	await write(projectPath, `${REPORT}/secrets.properties`, "token=hunter2");
	await write(projectPath, "src/main/java/Robot.java", "class Robot {}");
	// Excluded trees.
	await write(projectPath, ".git/HEAD", "ref: refs/heads/main");
	await write(projectPath, ".git/notes.md", "# secret\n");
	await write(projectPath, ".gradle/cache/out.html", "<p>x</p>");
	await write(projectPath, "node_modules/pkg/readme.md", "# dep\n");
	// A hidden directory that is NOT excluded.
	await write(projectPath, ".docs/notes.md", "# hidden\n");
}

async function documentsFor(
	app: ControlApp,
	slug: string,
	cookie: string,
): Promise<PreviewDocumentsResponse> {
	const resp = await app.fetch(
		new Request(`http://localhost/u/${slug}/api/preview/documents`, {
			headers: { cookie },
		}),
	);
	expect(resp.status).toBe(200);
	return (await resp.json()) as PreviewDocumentsResponse;
}

function fileRequest(
	slug: string,
	token: string,
	encodedPath: string,
): Request {
	return new Request(
		`http://localhost/u/${slug}/api/preview/files/${token}/${encodedPath}`,
	);
}

describe("preview tokens", () => {
	test("round-trips for the workspace it was minted for", () => {
		const { token, expiresIn } = mintPreviewToken("secret", "ws_a".repeat(1));
		expect(expiresIn).toBe(PREVIEW_TOKEN_TTL_SECONDS);
		expect(verifyPreviewToken("secret", "ws_a", token)).toBe(true);
	});

	test("does not verify against a different workspace", () => {
		// The whole point of signing the workspace id: pasting one student's URL
		// into another student's slug must not authorise anything.
		const { token } = mintPreviewToken("secret", "ws_a");
		expect(verifyPreviewToken("secret", "ws_b", token)).toBe(false);
	});

	test("does not verify under a different secret", () => {
		const { token } = mintPreviewToken("secret", "ws_a");
		expect(verifyPreviewToken("other", "ws_a", token)).toBe(false);
	});

	test("rejects an expired token", () => {
		const now = Math.floor(Date.now() / 1000);
		const { token } = mintPreviewToken("secret", "ws_a", now);
		expect(verifyPreviewToken("secret", "ws_a", token, now + 10)).toBe(true);
		expect(
			verifyPreviewToken(
				"secret",
				"ws_a",
				token,
				now + PREVIEW_TOKEN_TTL_SECONDS + 1,
			),
		).toBe(false);
	});

	test("rejects tampering with the expiry, signature, version or shape", () => {
		const { token } = mintPreviewToken("secret", "ws_a");
		const [version, expiresAt, signature] = token.split(".");
		// Push the expiry out without re-signing.
		expect(
			verifyPreviewToken(
				"secret",
				"ws_a",
				`${version}.${Number(expiresAt) + 99999}.${signature}`,
			),
		).toBe(false);
		// Flip a signature byte.
		const flipped = `${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;
		expect(
			verifyPreviewToken(
				"secret",
				"ws_a",
				`${version}.${expiresAt}.${flipped}`,
			),
		).toBe(false);
		// Wrong version, truncated signature, and junk shapes.
		expect(
			verifyPreviewToken("secret", "ws_a", `p0.${expiresAt}.${signature}`),
		).toBe(false);
		expect(
			verifyPreviewToken(
				"secret",
				"ws_a",
				`${version}.${expiresAt}.${signature?.slice(0, 5)}`,
			),
		).toBe(false);
		expect(verifyPreviewToken("secret", "ws_a", "")).toBe(false);
		expect(verifyPreviewToken("secret", "ws_a", "not-a-token")).toBe(false);
		expect(
			verifyPreviewToken(
				"secret",
				"ws_a",
				`${version}.notanumber.${signature}`,
			),
		).toBe(false);
	});
});

describe("GET /u/:slug/api/preview/documents", () => {
	test("lists Markdown and HTML, including generated output, excluding machine trees", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));

				const body = await documentsFor(app, "alice", cookie);
				expect(body.ok).toBe(true);
				expect(body.truncated).toBe(false);

				const paths = body.documents.map((d) => d.path);
				expect(paths).toContain("README.md");
				expect(paths).toContain("docs/guide.md");
				expect(paths).toContain("docs/notes/index.html");
				// Generated output is in scope even though it is gitignored.
				expect(paths).toContain(`${REPORT}/index.html`);
				// A dot-directory is not excluded just for being hidden.
				expect(paths).toContain(".docs/notes.md");

				// Excluded directory trees never appear, including Markdown inside them.
				expect(paths).not.toContain(".git/notes.md");
				expect(paths.some((p) => p.startsWith(".gradle/"))).toBe(false);
				expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
				// Non-document files are not listed.
				expect(paths).not.toContain("src/main/java/Robot.java");
				expect(paths).not.toContain(`${REPORT}/css/base.css`);

				// Shallow-first, then alphabetical.
				expect(paths.slice(0, 3)).toEqual([
					"LICENSE.md",
					"README.md",
					".docs/notes.md",
				]);
				// Deep generated report pages sort below root-level docs.
				expect(paths.indexOf(`${REPORT}/index.html`)).toBeGreaterThan(
					paths.indexOf("docs/guide.md"),
				);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("classifies kinds by extension, case-insensitively", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "SHOUTING.MD", "# loud\n");
				await write(project, "Page.HTM", "<p>page</p>");
				await write(project, "Other.HTML", "<p>page</p>");

				const body = await documentsFor(app, "alice", cookie);
				const byPath = new Map(body.documents.map((d) => [d.path, d.kind]));
				expect(byPath.get("SHOUTING.MD")).toBe("markdown");
				expect(byPath.get("Page.HTM")).toBe("html");
				expect(byPath.get("Other.HTML")).toBe("html");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("omits document names that violate the preview path contract", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "README.md", "# valid\n");
				await write(project, "Notes: Week 1.md", "# invalid path\n");
				await write(project, "docs/valid.md", "# valid\n");

				const body = await documentsFor(app, "alice", cookie);
				expect(body.documents.map((document) => document.path)).toEqual([
					"README.md",
					"docs/valid.md",
				]);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("keeps duplicate filenames distinguishable by full path", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "index.html", "<p>root</p>");
				await write(project, "a/index.html", "<p>a</p>");
				await write(project, "b/deep/index.html", "<p>b</p>");

				const body = await documentsFor(app, "alice", cookie);
				const paths = body.documents.map((d) => d.path);
				expect(paths).toContain("index.html");
				expect(paths).toContain("a/index.html");
				expect(paths).toContain("b/deep/index.html");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("skips symlinked files and directories", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app, root) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await mkdir(project, { recursive: true });

				const outsideDir = join(root, "outside");
				await mkdir(outsideDir, { recursive: true });
				await writeFile(join(outsideDir, "leak.md"), "# leak\n", "utf8");

				await symlink(join(outsideDir, "leak.md"), join(project, "link.md"));
				await symlink(outsideDir, join(project, "linkdir"));

				const body = await documentsFor(app, "alice", cookie);
				const paths = body.documents.map((d) => d.path);
				expect(paths).not.toContain("link.md");
				expect(paths.some((p) => p.startsWith("linkdir"))).toBe(false);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("returns an empty list for an empty project", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const body = await documentsFor(app, "alice", cookie);
				expect(body.documents).toEqual([]);
				expect(body.truncated).toBe(false);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("requires the session cookie and rejects another student", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const bobCookie = cookieFrom(await login(app, "bob"));

				const anonymous = await app.fetch(
					new Request("http://localhost/u/alice/api/preview/documents"),
				);
				expect(anonymous.status).toBe(401);

				const wrongUser = await app.fetch(
					new Request("http://localhost/u/alice/api/preview/documents", {
						headers: { cookie: bobCookie },
					}),
				);
				expect(wrongUser.status).toBe(403);
			},
			{ dockerRunner: docker.runner },
		);
	});
});

describe("GET /u/:slug/api/preview/files/<token>/<path>", () => {
	test("renders Markdown as an isolated HTML document with heading anchors", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				const resp = await app.fetch(fileRequest("alice", token, "README.md"));
				expect(resp.status).toBe(200);
				expect(resp.headers.get("content-type")).toContain("text/html");

				const csp = resp.headers.get("content-security-policy") ?? "";
				// Markdown needs no scripts, so the sandbox does not grant any.
				expect(csp).toContain("sandbox;");
				expect(csp).toContain("script-src 'none'");
				expect(csp).not.toContain("allow-same-origin");
				expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
				expect(resp.headers.get("referrer-policy")).toBe("no-referrer");
				expect(resp.headers.get("cache-control")).toContain("no-store");

				const html = await resp.text();
				expect(html).toContain('<h1 id="robot">Robot</h1>');
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("pins resources to the public origin behind a proxy", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				// The request reaches the control plane under the proxy's upstream
				// host, but the browser loads images from the public origin.
				const resp = await app.fetch(fileRequest("alice", token, "README.md"));
				const csp = resp.headers.get("content-security-policy") ?? "";
				expect(csp).toContain(
					`img-src http://coderunner.example/u/alice/api/preview/files/${token}/`,
				);
			},
			{ dockerRunner: docker.runner, baseUrl: "http://coderunner.example" },
		);
	});

	test("serves HTML documents unmodified, under a scripted sandbox", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, `${REPORT}/index.html`, "<p id=x>report</p>");
				const { token } = await documentsFor(app, "alice", cookie);

				const resp = await app.fetch(
					fileRequest("alice", token, `${REPORT}/index.html`),
				);
				expect(resp.status).toBe(200);
				// The report's own markup is preserved, not re-rendered.
				expect(await resp.text()).toBe("<p id=x>report</p>");

				const csp = resp.headers.get("content-security-policy") ?? "";
				expect(csp).toContain("sandbox allow-scripts");
				expect(csp).not.toContain("allow-same-origin");
				// Resources are pinned to this token's own namespace.
				expect(csp).toContain(
					`http://localhost/u/alice/api/preview/files/${token}/`,
				);
				expect(csp).toContain("connect-src 'none'");
				expect(csp).toContain("form-action 'none'");
				expect(csp).toContain("navigate-to 'none'");
				expect(csp).toContain("frame-src 'none'");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("serves allowlisted report assets and refuses everything else", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				const css = await app.fetch(
					fileRequest("alice", token, `${REPORT}/css/base.css`),
				);
				expect(css.status).toBe(200);
				expect(css.headers.get("content-type")).toContain("text/css");

				const js = await app.fetch(
					fileRequest("alice", token, `${REPORT}/js/report.js`),
				);
				expect(js.status).toBe(200);
				expect(js.headers.get("content-type")).toContain("text/javascript");

				// The handler must not become a way to read project config or source.
				const properties = await app.fetch(
					fileRequest("alice", token, `${REPORT}/secrets.properties`),
				);
				expect(properties.status).toBe(415);
				expect(await properties.text()).not.toContain("hunter2");

				const java = await app.fetch(
					fileRequest("alice", token, "src/main/java/Robot.java"),
				);
				expect(java.status).toBe(415);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("isolates directly navigable SVG assets", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "README.md", "# x\n");
				await write(
					project,
					"docs/chart.svg",
					'<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
				);
				const { token } = await documentsFor(app, "alice", cookie);

				const resp = await app.fetch(
					fileRequest("alice", token, "docs/chart.svg"),
				);
				expect(resp.status).toBe(200);
				expect(resp.headers.get("content-type")).toContain("image/svg+xml");
				// An SVG can be navigated to as a document, so it gets document isolation.
				const csp = resp.headers.get("content-security-policy") ?? "";
				expect(csp).toContain("sandbox;");
				expect(csp).toContain("script-src 'none'");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("handles URL-encoded spaces, Unicode, # and % in filenames", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				const names = [
					"my notes.md",
					"café ☕.md",
					"weird #1.md",
					"100% done.md",
				];
				for (const name of names) {
					await write(project, `docs/${name}`, `# ${name}\n`);
				}
				const body = await documentsFor(app, "alice", cookie);
				const listed = body.documents.map((d) => d.path);

				for (const name of names) {
					expect(listed).toContain(`docs/${name}`);
					const encoded = `docs/${name}`
						.split("/")
						.map(encodeURIComponent)
						.join("/");
					const resp = await app.fetch(
						fileRequest("alice", body.token, encoded),
					);
					expect(resp.status).toBe(200);
					expect(await resp.text()).toContain(name.replace(/&/g, "&amp;"));
				}
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("rejects an encoded separator smuggled inside one segment", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				// "docs%2Fguide.md" decodes to a separator that was never part of the
				// URL's structure; it must not be re-interpreted as one.
				const resp = await app.fetch(
					fileRequest("alice", token, "docs%2Fguide.md"),
				);
				expect(resp.status).toBe(400);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("rejects traversal, absolute paths and excluded directories", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				for (const path of [
					"../escape.md",
					"..%2Fescape.md",
					"%2e%2e/escape.md",
					"docs/../../escape.md",
					"/etc/passwd",
					"%2Fetc%2Fpasswd",
					".git/notes.md",
					".gradle/cache/out.html",
					"node_modules/pkg/readme.md",
					"docs/",
					"",
				]) {
					const resp = await app.fetch(fileRequest("alice", token, path));
					expect([400, 403, 404]).toContain(resp.status);
					expect(await resp.text()).not.toContain("secret");
				}
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("refuses a symlinked file even when it is named directly", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app, root) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "README.md", "# x\n");

				const outside = join(root, "outside.md");
				await writeFile(outside, "# leaked\n", "utf8");
				await symlink(outside, join(project, "link.md"));

				const { token } = await documentsFor(app, "alice", cookie);
				const resp = await app.fetch(fileRequest("alice", token, "link.md"));
				expect(resp.status).toBe(403);
				expect(await resp.text()).not.toContain("leaked");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("refuses a file reached through a directory symlink", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app, root) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "README.md", "# x\n");

				const outsideDir = join(root, "outside");
				await mkdir(outsideDir, { recursive: true });
				await writeFile(join(outsideDir, "leak.md"), "# leaked\n", "utf8");
				await symlink(outsideDir, join(project, "linkdir"));

				const { token } = await documentsFor(app, "alice", cookie);
				const resp = await app.fetch(
					fileRequest("alice", token, "linkdir/leak.md"),
				);
				expect([403, 404]).toContain(resp.status);
				expect(await resp.text()).not.toContain("leaked");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("refuses directories and non-regular files", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				await write(project, "README.md", "# x\n");
				// A directory whose name ends in .md still must not be read as one.
				await mkdir(join(project, "dir.md"), { recursive: true });

				const { token } = await documentsFor(app, "alice", cookie);
				const resp = await app.fetch(fileRequest("alice", token, "dir.md"));
				expect([403, 404]).toContain(resp.status);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("reports a file that disappeared between listing and opening", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				const resp = await app.fetch(
					fileRequest("alice", token, "does-not-exist.md"),
				);
				expect(resp.status).toBe(404);
				// The failure is rendered as a document, because the frame is what the
				// student is looking at.
				expect(resp.headers.get("content-type")).toContain("text/html");
				expect(await resp.text()).toContain("no longer available");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("refuses an oversized document", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				const project = workspaceProjectPath(app, "alice");
				// 10 MiB is the document ceiling.
				await write(project, "huge.md", "x".repeat(10 * 1024 * 1024 + 1));

				const { token } = await documentsFor(app, "alice", cookie);
				const resp = await app.fetch(fileRequest("alice", token, "huge.md"));
				expect(resp.status).toBe(413);
				expect(await resp.text()).toContain("too large");
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("rejects a missing, forged, or other-workspace token", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const aliceCookie = cookieFrom(await login(app, "alice"));
				const bobCookie = cookieFrom(await login(app, "bob"));
				await seedProject(workspaceProjectPath(app, "alice"));
				await seedProject(workspaceProjectPath(app, "bob"));

				const alice = await documentsFor(app, "alice", aliceCookie);
				const bob = await documentsFor(app, "bob", bobCookie);

				// Bob's token does not open Alice's files.
				const crossUser = await app.fetch(
					fileRequest("alice", bob.token, "README.md"),
				);
				expect(crossUser.status).toBe(403);

				// A forged token is refused.
				const forged = await app.fetch(
					fileRequest("alice", "p1.99999999999.forged", "README.md"),
				);
				expect(forged.status).toBe(403);

				// Alice's own token still works, and a session cookie is not needed.
				const ok = await app.fetch(
					fileRequest("alice", alice.token, "README.md"),
				);
				expect(ok.status).toBe(200);
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("rejects mutation methods", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
					const resp = await app.fetch(
						new Request(
							`http://localhost/u/alice/api/preview/files/${token}/README.md`,
							{ method },
						),
					);
					expect(resp.status).toBe(405);
				}
			},
			{ dockerRunner: docker.runner },
		);
	});

	test("returns 404 for an unknown workspace slug without revealing anything", async () => {
		const docker = createFakeDocker();
		await withApp(
			async (app) => {
				const cookie = cookieFrom(await login(app, "alice"));
				await seedProject(workspaceProjectPath(app, "alice"));
				const { token } = await documentsFor(app, "alice", cookie);

				const resp = await app.fetch(fileRequest("nobody", token, "README.md"));
				expect(resp.status).toBe(404);
			},
			{ dockerRunner: docker.runner },
		);
	});
});
