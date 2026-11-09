import { constants as fsConstants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
	PREVIEW_EXCLUDED_DIRS,
	PREVIEW_MAX_DEPTH,
	type PreviewDocument,
	type PreviewDocumentKind,
	type PreviewDocumentsResponse,
	previewPathSchema,
	type WorkspaceId,
	type WorkspaceSlug,
} from "@frc-coderunner/contracts";
import { getLogger } from "../logging";
import { isInsideDirectory, isOpenFileInsideRoot } from "./assets";
import {
	renderMarkdownDocument,
	renderPreviewErrorDocument,
} from "./preview-markdown";
import { mintPreviewToken, verifyPreviewToken } from "./preview-token";
import { jsonResponse } from "./responses";

const log = getLogger("preview");

export const PREVIEW_FILES_PREFIX = "/api/preview/files/";

/**
 * Discovery budgets. A workspace has no disk quota, so an unbounded walk is a
 * way for one student to stall the control plane for everyone else. These stop
 * the walk and say so (`truncated: true`) rather than pretending the listing is
 * complete. Tune only against real report fixtures.
 */
const MAX_DOCUMENTS = 2000;
const MAX_VISITED_ENTRIES = 20_000;

/** Per-file read ceilings. Generated reports are small; anything else is not ours to stream. */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

type PreviewWorkspace = {
	id: WorkspaceId;
	slug: WorkspaceSlug;
	project_path: string;
};

// --- Discovery ---------------------------------------------------------

function documentKindFor(name: string): PreviewDocumentKind | null {
	switch (extname(name).toLowerCase()) {
		case ".md":
			return "markdown";
		case ".html":
		case ".htm":
			return "html";
		default:
			return null;
	}
}

/**
 * Breadth-first so that hitting a budget leaves a shallow, useful listing (the
 * README and top-level docs) rather than one arbitrarily deep branch.
 * Symlinks are skipped outright — following them is how a walk escapes the
 * project or spins forever on a cycle.
 */
async function discoverDocuments(
	projectRoot: string,
): Promise<{ documents: PreviewDocument[]; truncated: boolean }> {
	const documents: PreviewDocument[] = [];
	let visited = 0;
	let truncated = false;

	// [absolute directory, project-relative prefix, depth]
	let frontier: Array<[string, string, number]> = [[projectRoot, "", 0]];

	while (frontier.length > 0 && !truncated) {
		const next: Array<[string, string, number]> = [];
		for (const [directory, prefix, depth] of frontier) {
			const entries = await opendir(directory).catch(() => null);
			if (!entries) continue;

			// Stream entries so the visit budget also bounds memory use. `readdir`
			// materializes an entire directory before we can stop at the limit.
			for await (const entry of entries) {
				visited += 1;
				if (visited > MAX_VISITED_ENTRIES) {
					truncated = true;
					break;
				}
				if (entry.isSymbolicLink()) continue;

				const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

				if (entry.isDirectory()) {
					if (PREVIEW_EXCLUDED_DIRS.includes(entry.name)) continue;
					if (depth + 1 >= PREVIEW_MAX_DEPTH) continue;
					if (!previewPathSchema.safeParse(relativePath).success) continue;
					next.push([join(directory, entry.name), relativePath, depth + 1]);
					continue;
				}
				if (!entry.isFile()) continue;

				const kind = documentKindFor(entry.name);
				if (!kind) continue;
				// Linux permits names that Preview deliberately rejects (for example
				// control characters). Never emit a list that violates its own contract
				// and makes the frontend reject every otherwise-valid document.
				if (!previewPathSchema.safeParse(relativePath).success) continue;
				if (documents.length >= MAX_DOCUMENTS) {
					truncated = true;
					break;
				}
				documents.push({ path: relativePath, kind });
			}
			if (truncated) break;
		}
		frontier = next;
	}

	// Shallow paths first, then alphabetical. Hand-written docs live near the
	// root and generated report trees are deep, so this floats the things a
	// student is most likely to want above a few thousand report pages. It is
	// only an ordering: the README is chosen by name, not by position.
	documents.sort((a, b) => {
		const depthDelta = a.path.split("/").length - b.path.split("/").length;
		if (depthDelta !== 0) return depthDelta;
		return a.path.localeCompare(b.path);
	});

	return { documents, truncated };
}

export async function previewDocumentsResponse(
	sessionSecret: string,
	workspace: PreviewWorkspace,
): Promise<Response> {
	const projectRoot = resolve(workspace.project_path);
	const { documents, truncated } = await discoverDocuments(projectRoot);
	if (truncated) {
		log.warn("preview discovery truncated by budget", {
			workspaceId: workspace.id,
		});
	}
	const { token, expiresIn } = mintPreviewToken(sessionSecret, workspace.id);
	return jsonResponse({
		ok: true,
		documents,
		truncated,
		token,
		tokenExpiresIn: expiresIn,
	} satisfies PreviewDocumentsResponse);
}

// --- Request parsing ---------------------------------------------------

export type PreviewFileRequest = { token: string; path: string };

/**
 * Split `<token>/<path>` out of the encoded URL suffix.
 *
 * Each path segment is decoded exactly once, individually — decoding the whole
 * suffix in one go would let `%2F` inside a filename introduce a separator that
 * was never in the URL structure. A decoded segment that still contains a
 * separator is rejected rather than re-split.
 */
export function parsePreviewFileRequest(
	encodedSuffix: string,
): PreviewFileRequest | null {
	const slash = encodedSuffix.indexOf("/");
	if (slash <= 0) return null;

	const token = encodedSuffix.slice(0, slash);
	const encodedPath = encodedSuffix.slice(slash + 1);
	if (token.length === 0 || token.length > 256) return null;
	if (encodedPath.length === 0 || encodedPath.length > 2048) return null;

	const decoded: string[] = [];
	for (const segment of encodedPath.split("/")) {
		let value: string;
		try {
			value = decodeURIComponent(segment);
		} catch {
			return null;
		}
		if (value.includes("/") || value.includes("\\")) return null;
		decoded.push(value);
	}

	const parsed = previewPathSchema.safeParse(decoded.join("/"));
	return parsed.success ? { token, path: parsed.data } : null;
}

// --- Serving -----------------------------------------------------------

/**
 * MIME allowlist for non-document resources. Narrow on purpose: this handler
 * must not become a way to read a project's source or config files back out
 * through the browser. Extend it only when a real report needs the type.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

function previewHeaders(contentType: string, csp?: string): Headers {
	const headers = new Headers({
		"content-type": contentType,
		// Preview responses are one student's private files and carry a
		// capability token in their URL; they must not be stored anywhere shared.
		"cache-control": "no-store, private",
		"x-content-type-options": "nosniff",
		// Keeps the token out of the Referer header on any outbound navigation.
		"referrer-policy": "no-referrer",
	});
	if (csp) headers.set("content-security-policy", csp);
	return headers;
}

/**
 * The sandbox is applied twice on purpose: once as the iframe attribute in the
 * web shell, and again here as a response header, so that opening a report URL
 * directly — outside our frame — is isolated too.
 *
 * `'self'` is useless here: a sandbox without `allow-same-origin` gives the
 * document an opaque origin, which `'self'` would never match. Resources are
 * pinned to this response's own token-scoped path prefix instead, which is
 * exactly the "authenticated preview namespace" and nothing else.
 */
function documentCsp(resourcePrefix: string, allowScripts: boolean): string {
	const directives = [
		allowScripts ? "sandbox allow-scripts" : "sandbox",
		"default-src 'none'",
		`style-src ${resourcePrefix} 'unsafe-inline'`,
		`img-src ${resourcePrefix} data:`,
		`font-src ${resourcePrefix} data:`,
		"connect-src 'none'",
		"object-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"form-action 'none'",
		// Best-effort protection for browsers that implement CSP navigation
		// restrictions. The iframe sandbox separately blocks top-level navigation.
		"navigate-to 'none'",
		"base-uri 'none'",
		"frame-ancestors 'self'",
	];
	// Static reports carry inline handlers and inline <script> blocks; there is
	// no useful nonce story for content we do not author. Scripts stay confined
	// by the opaque origin, which is what actually contains them.
	directives.splice(
		2,
		0,
		allowScripts
			? `script-src ${resourcePrefix} 'unsafe-inline'`
			: "script-src 'none'",
	);
	return directives.join("; ");
}

/**
 * Behind a proxy (Cloudflare → Caddy in prod) the request URL carries the
 * upstream host, not the origin the browser loads from, so the configured
 * public origin is listed first. The request origin stays for direct access
 * (dev, tests), where it is the browser's origin.
 */
function resourcePrefixFor(
	publicBaseUrl: string,
	requestUrl: URL,
	slug: WorkspaceSlug,
	token: string,
): string {
	const path = `/u/${slug}${PREVIEW_FILES_PREFIX}${token}/`;
	const origins = new Set([new URL(publicBaseUrl).origin, requestUrl.origin]);
	return [...origins].map((origin) => `${origin}${path}`).join(" ");
}

function errorDocument(
	heading: string,
	detail: string,
	status: number,
): Response {
	return new Response(renderPreviewErrorDocument(heading, detail), {
		status,
		headers: previewHeaders(
			"text/html; charset=utf-8",
			documentCsp("'none'", false),
		),
	});
}

type OpenedFile =
	| { ok: true; bytes: Uint8Array<ArrayBuffer> }
	| { ok: false; response: Response };

/**
 * Open a validated project-relative path and read it, refusing anything that is
 * not a regular file inside the real project root.
 *
 * The path checks above this are lexical, and a student can write to their own
 * project, so they are check-then-use: a directory can be swapped for a symlink
 * between the check and the open. Confirming the *descriptor* we already hold
 * closes that race — it names the inode we opened, which cannot be re-pointed
 * underneath us. `O_NOFOLLOW` covers the final segment.
 */
async function readVerifiedProjectFile(
	projectRoot: string,
	relativePath: string,
	maxBytes: number,
): Promise<OpenedFile> {
	const target = resolve(projectRoot, relativePath);
	if (!isInsideDirectory(projectRoot, target)) {
		return {
			ok: false,
			response: errorDocument(
				"Not available",
				"That path is outside the project.",
				403,
			),
		};
	}
	const realProjectRoot = await realpath(projectRoot).catch(() => projectRoot);

	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") {
			return {
				ok: false,
				response: errorDocument(
					"Not available",
					"That path is a symbolic link.",
					403,
				),
			};
		}
		return {
			ok: false,
			response: errorDocument(
				"File not found",
				"This file is no longer available. Refresh the document list.",
				404,
			),
		};
	}

	try {
		if (!(await isOpenFileInsideRoot(handle.fd, realProjectRoot))) {
			return {
				ok: false,
				response: errorDocument(
					"Not available",
					"That path is outside the project.",
					403,
				),
			};
		}
		const stats = await handle.stat();
		if (!stats.isFile()) {
			return {
				ok: false,
				response: errorDocument(
					"Not available",
					"That path is not a regular file.",
					403,
				),
			};
		}
		if (stats.size > maxBytes) {
			return {
				ok: false,
				response: errorDocument(
					"File is too large",
					`This file is ${Math.round(stats.size / (1024 * 1024))} MB; Preview stops at ${Math.round(maxBytes / (1024 * 1024))} MB.`,
					413,
				),
			};
		}

		// Read at most one byte past the size we just checked: that bounds the
		// allocation to the inspected size while still detecting a file that grew
		// underneath us, rather than silently serving a truncated copy.
		const buffer = new Uint8Array(new ArrayBuffer(stats.size + 1));
		const { bytesRead } = await handle.read(buffer, 0, stats.size + 1, 0);
		if (bytesRead > stats.size) {
			return {
				ok: false,
				response: errorDocument(
					"File changed",
					"This file changed while it was being read. Refresh to try again.",
					409,
				),
			};
		}
		return { ok: true, bytes: buffer.subarray(0, bytesRead) };
	} finally {
		await handle.close();
	}
}

/**
 * Serve one preview resource. Authenticated by the path token rather than the
 * session cookie — see `preview-token.ts` for why the cookie cannot reach here.
 */
export async function previewFileResponse(
	sessionSecret: string,
	publicBaseUrl: string,
	workspace: PreviewWorkspace,
	requestUrl: URL,
	encodedSuffix: string,
): Promise<Response> {
	const parsed = parsePreviewFileRequest(encodedSuffix);
	if (!parsed) {
		return errorDocument(
			"Not available",
			"That preview path is not valid.",
			400,
		);
	}
	if (!verifyPreviewToken(sessionSecret, workspace.id, parsed.token)) {
		return errorDocument(
			"Preview link expired",
			"Click Refresh in the Preview toolbar to reopen this document.",
			403,
		);
	}

	const projectRoot = resolve(workspace.project_path);
	const kind = documentKindFor(parsed.path);
	const prefix = resourcePrefixFor(
		publicBaseUrl,
		requestUrl,
		workspace.slug,
		parsed.token,
	);

	if (kind === "markdown") {
		const file = await readVerifiedProjectFile(
			projectRoot,
			parsed.path,
			MAX_DOCUMENT_BYTES,
		);
		if (!file.ok) return file.response;
		const title = parsed.path.split("/").pop() ?? parsed.path;
		return new Response(
			renderMarkdownDocument(new TextDecoder().decode(file.bytes), title),
			{
				headers: previewHeaders(
					"text/html; charset=utf-8",
					documentCsp(prefix, false),
				),
			},
		);
	}

	if (kind === "html") {
		const file = await readVerifiedProjectFile(
			projectRoot,
			parsed.path,
			MAX_DOCUMENT_BYTES,
		);
		if (!file.ok) return file.response;
		return new Response(file.bytes, {
			headers: previewHeaders(
				"text/html; charset=utf-8",
				documentCsp(prefix, true),
			),
		});
	}

	const contentType = ASSET_CONTENT_TYPES[extname(parsed.path).toLowerCase()];
	if (!contentType) {
		return errorDocument(
			"Not available",
			"Preview only serves documents and their stylesheets, scripts, images and fonts.",
			415,
		);
	}
	const file = await readVerifiedProjectFile(
		projectRoot,
		parsed.path,
		MAX_ASSET_BYTES,
	);
	if (!file.ok) return file.response;

	// An SVG can be navigated to directly and can carry script, so it gets the
	// same document isolation an HTML page does.
	const csp = contentType.startsWith("image/svg")
		? documentCsp("'none'", false)
		: undefined;
	return new Response(file.bytes, {
		headers: previewHeaders(contentType, csp),
	});
}
