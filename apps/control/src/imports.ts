import { randomBytes } from "node:crypto";
import type {
	ImportServerMessage,
	LessonModuleKind,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import { lessonModuleSubdirSchema } from "@frc-coderunner/contracts";
import { IMAGE_CATALOG_DIR } from "./catalog";
import { getLogger } from "./logging";
import type { WorkspaceRuntimeProvider } from "./runtime";
import type { AppStorage, WorkspaceRow } from "./storage";

const log = getLogger("imports");

// --- URL validation ---

// Repo-root-only: https://github.com/owner/repo(.git). No /tree/<branch>/<path>
// form — the team import is an all-branches shallow clone of the repo root
// (Decision D8), and lessons load from the configured catalog repo, not a
// student-supplied subdir.
const GITHUB_HTTPS_RE =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

export type ParsedImportUrl = {
	cloneUrl: string;
};

export function parseGitHubUrl(rawUrl: string): ParsedImportUrl {
	const url = rawUrl.trim();

	if (/^git@/i.test(url)) {
		throw new ImportError(
			"SSH URLs are not supported. Use an HTTPS GitHub URL.",
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ImportError("Invalid URL format.");
	}

	if (parsed.hostname !== "github.com") {
		throw new ImportError("Only GitHub URLs are supported.");
	}

	const simpleMatch = GITHUB_HTTPS_RE.exec(url);
	if (simpleMatch) {
		const owner = simpleMatch[1]!;
		const repo = simpleMatch[2]!;
		return {
			cloneUrl: `https://github.com/${owner}/${repo}.git`,
		};
	}

	throw new ImportError(
		"Unsupported GitHub URL format. Use https://github.com/<owner>/<repo>.",
	);
}

/**
 * Normalize a catalog module `repo` entry to an HTTPS clone URL. Accepts a full
 * GitHub URL or `owner/repo` shorthand, matching `LESSONS_CATALOG_REPO`.
 */
export function normalizeCatalogModuleRepo(repo: string): string {
	const trimmed = repo.trim();
	const url = /^https:\/\//i.test(trimmed)
		? trimmed
		: `https://github.com/${trimmed}`;
	return parseGitHubUrl(url).cloneUrl;
}

// --- Errors ---

export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportError";
	}
}

// --- Rate limiting ---

type RateLimitEntry = { timestamps: number[] };

const MAX_IMPORTS_PER_HOUR = 6;

export class ImportRateLimiter {
	private readonly entries = new Map<string, RateLimitEntry>();

	check(userId: string): void {
		const now = Date.now();
		const cutoff = now - 3_600_000;
		let entry = this.entries.get(userId);
		if (!entry) {
			entry = { timestamps: [] };
			this.entries.set(userId, entry);
		}
		entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
		if (entry.timestamps.length >= MAX_IMPORTS_PER_HOUR) {
			throw new RateLimitError();
		}
	}

	record(userId: string): void {
		let entry = this.entries.get(userId);
		if (!entry) {
			entry = { timestamps: [] };
			this.entries.set(userId, entry);
		}
		entry.timestamps.push(Date.now());
	}
}

export class RateLimitError extends Error {
	constructor() {
		super(`Rate limit exceeded: max ${MAX_IMPORTS_PER_HOUR} imports per hour.`);
		this.name = "RateLimitError";
	}
}

// --- Import / load orchestration ---

const MAX_CLONE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB
const CLONE_TIMEOUT_SECONDS = 60;

function safeCatalogSubdir(subdir: string): string {
	const parsed = lessonModuleSubdirSchema.safeParse(subdir);
	if (!parsed.success) {
		throw new ImportError("Invalid lesson module subdir.");
	}
	return parsed.data;
}

export type ImportSend = (message: ImportServerMessage) => void;

/** Arbitrary public GitHub team-repo import (D8): keeps `.git`, all branches. */
export type GithubImportContext = {
	source: "github";
	workspace: WorkspaceRow;
	userId: string;
	cloneUrl: string;
	send: ImportSend;
};

/**
 * Lesson-module load from the catalog (D11/§5.2). A module is either a folder
 * inside the catalog repo (`subdir`) or a standalone git repo (`repo`).
 * `remote` is the sparse shallow clone descriptor when the remote catalog is
 * active, or `null` to copy a subdir module from the in-image bundled catalog.
 * Never backed up; no build.gradle gate. A module repo's `.git` is dropped
 * unless `preserveGit` is set.
 */
export type CatalogLoadContext = {
	source: "catalog";
	workspace: WorkspaceRow;
	userId: string;
	moduleId: string;
	subdir: string | null;
	repo: string | null;
	preserveGit: boolean;
	kind: LessonModuleKind;
	remote: { cloneUrl: string; branch: string } | null;
	send: ImportSend;
};

export type ImportContext = GithubImportContext | CatalogLoadContext;

export class ImportManager {
	private readonly rateLimiter = new ImportRateLimiter();
	private readonly activeImports = new Map<WorkspaceId, string>();

	constructor(
		readonly _storage: AppStorage,
		private readonly runtimeProvider: WorkspaceRuntimeProvider,
	) {}

	isImporting(workspaceId: WorkspaceId): boolean {
		return this.activeImports.has(workspaceId);
	}

	async run(ctx: ImportContext): Promise<void> {
		const { workspace, userId, send } = ctx;

		if (this.activeImports.has(workspace.id)) {
			log.warn("import already in progress", { workspaceId: workspace.id });
			throw new ImportError(
				"An import is already in progress for this workspace.",
			);
		}

		// Team imports are public clones of student-supplied repos and are
		// rate-limited. Catalog loads are NOT, so students can switch lessons
		// freely: every module, including a `repo` module's full shallow clone,
		// comes from a catalog the control plane is configured to trust.
		if (ctx.source === "github") {
			this.rateLimiter.check(userId);
		}

		const importId = `import_${randomBytes(8).toString("hex")}`;
		this.activeImports.set(workspace.id, importId);
		log.info("import started", {
			workspaceId: workspace.id,
			userId,
			importId,
			source: ctx.source,
			cloneUrl:
				ctx.source === "github"
					? ctx.cloneUrl
					: (ctx.repo ?? ctx.remote?.cloneUrl ?? null),
			moduleId: ctx.source === "catalog" ? ctx.moduleId : null,
		});
		send({ type: "hello", importId });

		try {
			if (ctx.source === "github") {
				await this.executeGithubImport(ctx);
				this.rateLimiter.record(userId);
			} else {
				await this.executeCatalogLoad(ctx);
			}
			log.info("import completed", { workspaceId: workspace.id, importId });
			send({
				type: "done",
				success: true,
				message:
					ctx.source === "github"
						? "Import completed successfully."
						: "Lesson loaded successfully.",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Import failed.";
			log.error("import failed", {
				workspaceId: workspace.id,
				importId,
				err: error instanceof Error ? error : new Error(message),
			});
			send({ type: "done", success: false, message });
		} finally {
			this.activeImports.delete(workspace.id);
		}
	}

	private async executeGithubImport(ctx: GithubImportContext): Promise<void> {
		const { workspace, send, cloneUrl } = ctx;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const stagingName = `.import-${timestamp}`;
		const projectRoot = `/workspace/${stagingName}/source`;

		// 1. Ensure container is running
		send({
			type: "progress",
			stage: "container",
			detail: "Ensuring workspace runtime is running…",
		});
		await this.ensureRunning(workspace.id);

		try {
			// 2. All-branches shallow clone of the repo root (D8). Keeps `.git`/origin.
			send({
				type: "progress",
				stage: "cloning",
				detail: `Cloning ${cloneUrl}…`,
			});
			await this.cloneOrThrow(
				workspace.id,
				[
					"git",
					"clone",
					"--no-single-branch",
					"--depth",
					"1",
					"--",
					cloneUrl,
					projectRoot,
				],
				send,
			);

			// 3. Require build.gradle (a team import is always a robot project).
			send({
				type: "progress",
				stage: "validating",
				detail: "Checking for build.gradle…",
			});
			const checkResult = await this.runtimeExec(workspace.id, [
				"test",
				"-f",
				`${projectRoot}/build.gradle`,
			]);
			if (checkResult.exitCode !== 0) {
				throw new ImportError(
					"Not a Gradle/WPILib project: build.gradle not found at the project root.",
				);
			}

			// 4. Size cap.
			await this.enforceSizeCap(workspace.id, projectRoot, send);

			// 5. Swap into /workspace/project (do NOT strip .git, do NOT back up).
			await this.swapProject(workspace.id, projectRoot, send);
		} finally {
			await this.cleanupStaging(workspace.id, stagingName);
		}

		// Clear the editor workspace cache and the loaded-module record: a team
		// import renders as a normal robot project (current_module = NULL).
		await this.runtimeExec(workspace.id, [
			"rm",
			"-rf",
			"/config/data/User/workspaceStorage",
		]).catch(() => {});
		this._storage.setCurrentModule(workspace.id, null, null);

		send({ type: "progress", stage: "complete", detail: "Import finished." });
	}

	private async executeCatalogLoad(ctx: CatalogLoadContext): Promise<void> {
		const { workspace, send, moduleId, kind, remote, preserveGit } = ctx;
		const subdir = ctx.subdir ? safeCatalogSubdir(ctx.subdir) : null;
		const repo = ctx.repo ? normalizeCatalogModuleRepo(ctx.repo) : null;
		if ((subdir === null) === (repo === null)) {
			throw new ImportError(
				"Lesson module must define exactly one of subdir or repo.",
			);
		}
		const moduleLabel = subdir ?? repo ?? moduleId;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const stagingName = `.lesson-${timestamp}`;

		// 1. Ensure container is running (the active run is stopped by the caller).
		send({
			type: "progress",
			stage: "container",
			detail: "Ensuring workspace runtime is running…",
		});
		await this.ensureRunning(workspace.id);

		let projectRoot: string;
		try {
			if (repo) {
				// Standalone module repo: the repository root is the project.
				send({
					type: "progress",
					stage: "cloning",
					detail: `Fetching lesson "${moduleId}"…`,
				});
				const sourceDir = `/workspace/${stagingName}/source`;
				await this.cloneOrThrow(
					workspace.id,
					["git", "clone", "--depth", "1", "--", repo, sourceDir],
					send,
				);
				projectRoot = sourceDir;
			} else if (remote && subdir) {
				// Remote catalog: sparse shallow clone of just this module's subdir.
				send({
					type: "progress",
					stage: "cloning",
					detail: `Fetching lesson "${moduleId}"…`,
				});
				const sourceDir = `/workspace/${stagingName}/source`;
				await this.cloneOrThrow(
					workspace.id,
					[
						"git",
						"clone",
						"--depth",
						"1",
						"--filter=blob:none",
						"--sparse",
						"--branch",
						remote.branch,
						"--",
						remote.cloneUrl,
						sourceDir,
					],
					send,
				);
				const sparseResult = await this.runtimeExec(workspace.id, [
					"git",
					"-C",
					sourceDir,
					"sparse-checkout",
					"set",
					subdir,
				]);
				if (sparseResult.exitCode !== 0) {
					const detail =
						sparseResult.stderr.trim() ||
						sparseResult.stdout.trim() ||
						`exit ${sparseResult.exitCode}`;
					throw new ImportError(`Sparse checkout failed: ${detail}`);
				}
				projectRoot = `${sourceDir}/${subdir}`;
			} else if (subdir) {
				// Bundled: copy from the in-image catalog. No network, no clone.
				send({
					type: "progress",
					stage: "materializing",
					detail: `Loading bundled lesson "${moduleId}"…`,
				});
				projectRoot = `${IMAGE_CATALOG_DIR}/${subdir}`;
			} else {
				throw new ImportError(
					"Lesson module must define exactly one of subdir or repo.",
				);
			}

			// Validate the module root exists and is non-empty (no build.gradle gate).
			// `.git` alone does not count: a repo module's clone always has one,
			// even when the repository itself is empty.
			send({
				type: "progress",
				stage: "validating",
				detail: "Checking lesson files…",
			});
			const existsResult = await this.runtimeExec(workspace.id, [
				"test",
				"-d",
				projectRoot,
			]);
			if (existsResult.exitCode !== 0) {
				throw new ImportError(`Lesson module not found at ${moduleLabel}.`);
			}
			const nonEmptyResult = await this.runtimeExec(workspace.id, [
				"bash",
				"-c",
				`test -n "$(find ${projectRoot} -mindepth 1 -maxdepth 1 ! -name .git -print -quit)"`,
			]);
			if (nonEmptyResult.exitCode !== 0) {
				throw new ImportError(`Lesson module ${moduleLabel} is empty.`);
			}

			// Size cap as cheap insurance.
			await this.enforceSizeCap(workspace.id, projectRoot, send);

			// Swap into /workspace/project. Only a module repo may keep `.git`;
			// subdir modules are always gitless.
			await this.swapProject(workspace.id, projectRoot, send);
			if (!repo || !preserveGit) {
				await this.runtimeExec(workspace.id, [
					"rm",
					"-rf",
					"/workspace/project/.git",
				]);
			}
			await this.runtimeExec(workspace.id, [
				"bash",
				"-c",
				"lsiown -R abc:abc /workspace/project",
			]);
			// Clear the editor workspace cache so redhat.java rebuilds its project model.
			await this.runtimeExec(workspace.id, [
				"rm",
				"-rf",
				"/config/data/User/workspaceStorage",
			]).catch(() => {});
		} finally {
			await this.cleanupStaging(workspace.id, stagingName);
		}

		// Record the loaded module + kind (captured at load time).
		this._storage.setCurrentModule(workspace.id, moduleId, kind);

		send({ type: "progress", stage: "complete", detail: "Lesson loaded." });
	}

	private async ensureRunning(workspaceId: WorkspaceId): Promise<void> {
		const runtime =
			await this.runtimeProvider.ensureWorkspaceRunning(workspaceId);
		if (runtime.state !== "running") {
			throw new ImportError(
				runtime.error ?? "Workspace runtime is not running.",
			);
		}
	}

	private async cloneOrThrow(
		workspaceId: WorkspaceId,
		cloneArgs: string[],
		send: ImportSend,
	): Promise<void> {
		const cloneResult = await this.runtimeExec(
			workspaceId,
			cloneArgs,
			CLONE_TIMEOUT_SECONDS,
		);
		if (cloneResult.exitCode !== 0) {
			const detail =
				cloneResult.stderr.trim() ||
				cloneResult.stdout.trim() ||
				`exit ${cloneResult.exitCode}`;
			throw new ImportError(`Git clone failed: ${detail}`);
		}
		send({ type: "log", line: "Clone completed." });
	}

	private async enforceSizeCap(
		workspaceId: WorkspaceId,
		projectRoot: string,
		send: ImportSend,
	): Promise<void> {
		send({
			type: "progress",
			stage: "validating",
			detail: "Checking size…",
		});
		const sizeResult = await this.runtimeExec(workspaceId, [
			"du",
			"-sb",
			projectRoot,
		]);
		if (sizeResult.exitCode === 0) {
			const sizeStr = sizeResult.stdout.split("\t")[0]?.trim();
			const sizeBytes = Number(sizeStr);
			if (Number.isFinite(sizeBytes) && sizeBytes > MAX_CLONE_SIZE_BYTES) {
				throw new ImportError(
					`Repository too large for import (${Math.round(sizeBytes / 1024 / 1024)} MB, max ${MAX_CLONE_SIZE_BYTES / 1024 / 1024} MB).`,
				);
			}
		}
	}

	private async swapProject(
		workspaceId: WorkspaceId,
		projectRoot: string,
		send: ImportSend,
	): Promise<void> {
		send({
			type: "progress",
			stage: "swapping",
			detail: "Replacing project files…",
		});

		// Remove existing contents inside /workspace/project (not the mount point).
		await this.runtimeExec(workspaceId, [
			"bash",
			"-c",
			"find /workspace/project -mindepth 1 -delete",
		]);

		// Copy the new project contents into the existing mount point.
		await this.runtimeExec(workspaceId, [
			"bash",
			"-c",
			`cp -a ${projectRoot}/. /workspace/project/`,
		]);

		// Ensure the abc user owns all files.
		await this.runtimeExec(workspaceId, [
			"bash",
			"-c",
			"lsiown -R abc:abc /workspace/project",
		]);

		send({ type: "log", line: "Project files replaced." });
	}

	private async cleanupStaging(
		workspaceId: WorkspaceId,
		stagingName: string,
	): Promise<void> {
		await this.runtimeExec(workspaceId, [
			"rm",
			"-rf",
			`/workspace/${stagingName}`,
		]).catch(() => {});
	}

	private async runtimeExec(
		workspaceId: WorkspaceId,
		args: string[],
		timeoutSeconds?: number,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		return this.runtimeProvider.exec(workspaceId, args, {
			timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
		});
	}
}
