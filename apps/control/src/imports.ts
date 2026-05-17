import { randomBytes } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	ImportBackupMetadata,
	ImportServerMessage,
	WorkspaceId,
} from "@frc-coderunner/contracts";
import { getLogger } from "./logging";
import type { WorkspaceRuntimeProvider } from "./runtime";
import type { AppStorage, WorkspaceRow } from "./storage";

const log = getLogger("imports");

// --- URL validation ---

const GITHUB_HTTPS_RE =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

const GITHUB_TREE_RE =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/tree\/([^/]+(?:\/[^/]+)*)$/;

const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

export type ParsedImportUrl = {
	cloneUrl: string;
	branch: string;
	subdir: string;
};

export function parseGitHubUrl(
	rawUrl: string,
	branchOverride?: string,
	subdirOverride?: string,
): ParsedImportUrl {
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

	// Try the simple https://github.com/owner/repo(.git) form first
	const simpleMatch = GITHUB_HTTPS_RE.exec(url);
	if (simpleMatch) {
		const owner = simpleMatch[1]!;
		const repo = simpleMatch[2]!;
		return {
			cloneUrl: `https://github.com/${owner}/${repo}.git`,
			branch: branchOverride || "main",
			subdir: normalizeSubdir(subdirOverride || ""),
		};
	}

	// Try tree URL: https://github.com/owner/repo/tree/branch/path
	const treeMatch = GITHUB_TREE_RE.exec(url);
	if (treeMatch) {
		const owner = treeMatch[1]!;
		const repo = treeMatch[2]!;
		const rest = treeMatch[3]!;

		// rest is "branch/maybe/path" — we can't unambiguously split branch from
		// subdir when both contain slashes. If the caller provided overrides, use
		// those; otherwise treat the first segment as the branch and the rest as
		// the subdir.
		const segments = rest.split("/");
		const branch = branchOverride || segments[0]!;
		const subdir = subdirOverride || segments.slice(1).join("/");

		return {
			cloneUrl: `https://github.com/${owner}/${repo}.git`,
			branch,
			subdir: normalizeSubdir(subdir),
		};
	}

	throw new ImportError(
		"Unsupported GitHub URL format. Use https://github.com/<owner>/<repo> or a /tree/<branch>/<path> URL.",
	);
}

function normalizeSubdir(subdir: string): string {
	const trimmed = subdir.replace(/^\/+|\/+$/g, "");
	if (trimmed.includes("..")) {
		throw new ImportError("Subdirectory must not contain '..'.");
	}
	return trimmed;
}

export function validateBranch(branch: string): void {
	if (!branch || branch.startsWith("-")) {
		throw new ImportError("Invalid branch name.");
	}
	if (!BRANCH_RE.test(branch)) {
		throw new ImportError("Branch name contains invalid characters.");
	}
}

export function validateSubdir(subdir: string): void {
	if (subdir.startsWith("/")) {
		throw new ImportError("Subdirectory must be a relative path.");
	}
	if (subdir.includes("..")) {
		throw new ImportError("Subdirectory must not contain '..'.");
	}
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

// --- Import orchestration ---

const MAX_CLONE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB
const CLONE_TIMEOUT_SECONDS = 60;
const MAX_IMPORT_BACKUPS = 5;

export type ImportSend = (message: ImportServerMessage) => void;

export type ImportContext = {
	workspace: WorkspaceRow;
	userId: string;
	cloneUrl: string;
	branch: string;
	subdir: string;
	backup: boolean;
	send: ImportSend;
};

export type ImportManagerOptions = Record<string, never>;

export class ImportManager {
	private readonly rateLimiter = new ImportRateLimiter();
	private readonly activeImports = new Map<WorkspaceId, string>();

	constructor(
		readonly _storage: AppStorage,
		private readonly runtimeProvider: WorkspaceRuntimeProvider,
		readonly _options: ImportManagerOptions = {},
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

		this.rateLimiter.check(userId);

		const importId = `import_${randomBytes(8).toString("hex")}`;
		this.activeImports.set(workspace.id, importId);
		log.info("import started", {
			workspaceId: workspace.id,
			userId,
			importId,
			cloneUrl: ctx.cloneUrl,
			branch: ctx.branch,
			subdir: ctx.subdir ?? null,
		});
		send({ type: "hello", importId });

		try {
			await this.executeImport(ctx, importId);
			log.info("import completed", { workspaceId: workspace.id, importId });
			send({
				type: "done",
				success: true,
				message: "Import completed successfully.",
			});
			this.rateLimiter.record(userId);
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

	private async executeImport(
		ctx: ImportContext,
		_importId: string,
	): Promise<void> {
		const { workspace, send, cloneUrl, branch, subdir, backup } = ctx;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const stagingName = `.import-${timestamp}`;

		// 1. Ensure container is running
		send({
			type: "progress",
			stage: "container",
			detail: "Ensuring workspace runtime is running…",
		});
		const runtime = await this.runtimeProvider.ensureWorkspaceRunning(
			workspace.id,
		);
		if (runtime.state !== "running") {
			throw new ImportError(
				runtime.error ?? "Workspace runtime is not running.",
			);
		}

		try {
			// 2. Clone inside the container
			send({
				type: "progress",
				stage: "cloning",
				detail: `Cloning ${cloneUrl} (branch: ${branch})…`,
			});
			const cloneArgs = [
				"git",
				"clone",
				"--depth",
				"1",
				"--branch",
				branch,
				"--",
				cloneUrl,
				`/workspace/${stagingName}/source`,
			];
			const cloneResult = await this.runtimeExec(
				workspace.id,
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

			// 3. Determine project root
			const projectRoot = subdir
				? `/workspace/${stagingName}/source/${subdir}`
				: `/workspace/${stagingName}/source`;

			// 4. Validate build.gradle exists
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

			// 5. Check size
			send({
				type: "progress",
				stage: "validating",
				detail: "Checking repository size…",
			});
			const sizeResult = await this.runtimeExec(workspace.id, [
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

			// 6. Strip .git/
			send({
				type: "progress",
				stage: "preparing",
				detail: "Stripping git history…",
			});
			await this.runtimeExec(workspace.id, [
				"rm",
				"-rf",
				`${projectRoot}/.git`,
			]);

			// 7. Backup current project
			if (backup) {
				send({
					type: "progress",
					stage: "backup",
					detail: "Backing up current project…",
				});
				await this.backupProject(
					workspace,
					cloneUrl,
					branch,
					subdir,
					timestamp,
				);
				send({ type: "log", line: "Backup created." });
			}

			// 8. Swap contents inside /workspace/project
			send({
				type: "progress",
				stage: "swapping",
				detail: "Replacing project files…",
			});

			// Remove existing contents inside /workspace/project (not the mount point itself)
			await this.runtimeExec(workspace.id, [
				"bash",
				"-c",
				"find /workspace/project -mindepth 1 -delete",
			]);

			// Copy imported project contents into the existing mount point
			await this.runtimeExec(workspace.id, [
				"bash",
				"-c",
				`cp -a ${projectRoot}/. /workspace/project/`,
			]);

			// Ensure the abc user owns all imported files
			await this.runtimeExec(workspace.id, [
				"bash",
				"-c",
				"lsiown -R abc:abc /workspace/project",
			]);

			send({ type: "log", line: "Project files replaced." });
		} finally {
			// 9. Clean up staging dir
			await this.runtimeExec(workspace.id, [
				"rm",
				"-rf",
				`/workspace/${stagingName}`,
			]).catch(() => {});
		}

		send({ type: "progress", stage: "complete", detail: "Import finished." });
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

	private async backupProject(
		workspace: WorkspaceRow,
		url: string,
		branch: string,
		subdir: string,
		timestamp: string,
	): Promise<void> {
		const projectDir = workspace.project_path;
		const backupsDir = resolve(dirname(projectDir), "backups");
		await mkdir(backupsDir, { recursive: true });

		const archiveFile = `import-${timestamp}.tar.gz`;
		const archivePath = resolve(backupsDir, archiveFile);
		const metadataPath = resolve(backupsDir, `import-${timestamp}.json`);

		// Create the archive
		const subprocess = Bun.spawn(
			["tar", "-czf", archivePath, "-C", projectDir, "."],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [, stderr, exitCode] = await Promise.all([
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
			subprocess.exited,
		]);
		if (exitCode !== 0) {
			throw new ImportError(
				`Backup failed: ${stderr.trim() || `exit ${exitCode}`}`,
			);
		}

		// Write metadata
		const metadata: ImportBackupMetadata = {
			url,
			branch,
			subdir,
			importedAt: new Date().toISOString(),
			archiveFile,
		};
		await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

		// Prune old import backups (keep newest MAX_IMPORT_BACKUPS)
		await this.pruneImportBackups(backupsDir);
	}

	private async pruneImportBackups(backupsDir: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(backupsDir);
		} catch {
			return;
		}

		const metadataFiles = entries
			.filter((name) => name.startsWith("import-") && name.endsWith(".json"))
			.sort();

		if (metadataFiles.length <= MAX_IMPORT_BACKUPS) return;

		const toRemove = metadataFiles.slice(
			0,
			metadataFiles.length - MAX_IMPORT_BACKUPS,
		);
		for (const metaFile of toRemove) {
			const archiveFile = metaFile.replace(/\.json$/, ".tar.gz");
			await rm(resolve(backupsDir, metaFile), { force: true }).catch(() => {});
			await rm(resolve(backupsDir, archiveFile), { force: true }).catch(
				() => {},
			);
		}
	}
}

// --- Recent imports query ---

export async function listRecentImports(
	workspace: WorkspaceRow,
): Promise<ImportBackupMetadata[]> {
	const backupsDir = resolve(dirname(workspace.project_path), "backups");
	let entries: string[];
	try {
		entries = await readdir(backupsDir);
	} catch {
		return [];
	}

	const metadataFiles = entries
		.filter((name) => name.startsWith("import-") && name.endsWith(".json"))
		.sort()
		.reverse();

	const results: ImportBackupMetadata[] = [];
	for (const file of metadataFiles) {
		try {
			const content = await readFile(resolve(backupsDir, file), "utf8");
			const parsed = JSON.parse(content) as ImportBackupMetadata;
			results.push(parsed);
		} catch {
			// Skip corrupted metadata files
		}
	}
	return results;
}

export async function restoreImportBackup(
	workspace: WorkspaceRow,
	archiveFile: string,
): Promise<void> {
	const backupsDir = resolve(dirname(workspace.project_path), "backups");
	const archivePath = resolve(backupsDir, archiveFile);

	// Validate the archive file name to prevent path traversal
	if (archiveFile.includes("..") || archiveFile.includes("/")) {
		throw new ImportError("Invalid backup file name.");
	}

	try {
		const s = await stat(archivePath);
		if (!s.isFile()) {
			throw new ImportError("Backup file not found.");
		}
	} catch (e) {
		if (e instanceof ImportError) throw e;
		throw new ImportError("Backup file not found.");
	}

	const projectDir = workspace.project_path;
	const parentDir = dirname(projectDir);
	const tempDir = resolve(
		parentDir,
		`.restore-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
	await mkdir(tempDir, { recursive: true });

	try {
		const subprocess = Bun.spawn(["tar", "-xzf", archivePath, "-C", tempDir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stderr, exitCode] = await Promise.all([
			new Response(subprocess.stdout).text(),
			new Response(subprocess.stderr).text(),
			subprocess.exited,
		]);
		if (exitCode !== 0) {
			throw new ImportError(
				`Restore failed: ${stderr.trim() || `exit ${exitCode}`}`,
			);
		}

		// Remove existing contents inside project dir but not the dir itself
		const existingEntries = await readdir(projectDir).catch(() => []);
		for (const entry of existingEntries) {
			await rm(resolve(projectDir, entry), { recursive: true, force: true });
		}

		// Copy restored files into the project mount point
		const restoredEntries = await readdir(tempDir);
		for (const entry of restoredEntries) {
			const { cp } = await import("node:fs/promises");
			await cp(resolve(tempDir, entry), resolve(projectDir, entry), {
				recursive: true,
			});
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}
