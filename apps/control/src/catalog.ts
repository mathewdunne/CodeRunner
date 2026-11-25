import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	flattenLessonModules,
	isLessonFolder,
	type LessonCatalogEntry,
	type LessonModule,
	lessonCatalogSchema,
} from "@frc-coderunner/contracts";
import type { ControlConfig } from "./config";
import { ImportError } from "./imports";
import { getLogger } from "./logging";

const log = getLogger("catalog");

/**
 * The bundled catalog is baked into the code image at this path. A bundled
 * module load `cp -a`s `<IMAGE_CATALOG_DIR>/<subdir>/.` into the workspace
 * project dir inside the container — no network. (Decision 029 #1.)
 */
export const IMAGE_CATALOG_DIR = "/opt/frc-catalog";

const REMOTE_CACHE_TTL_MS = 60_000;

export type CatalogManifest = {
	modules: LessonCatalogEntry[];
	error: string | null;
};

export interface CatalogSource {
	readonly kind: "remote" | "bundled";
	getManifest(): Promise<CatalogManifest>;
	resolveModule(moduleId: string): Promise<LessonModule>;
}

/**
 * Sort every entry by `order` at each level of the tree. Modules and folders
 * share one display scale, so a folder's position is controlled by its own
 * `order`, not by where it sits in the JSON array. Array order only breaks ties.
 */
function sortCatalogEntries(
	entries: LessonCatalogEntry[],
): LessonCatalogEntry[] {
	return [...entries]
		.sort((a, b) => a.order - b.order)
		.map((entry) =>
			isLessonFolder(entry)
				? { ...entry, modules: sortCatalogEntries(entry.modules) }
				: entry,
		);
}

/**
 * Normalize a configured catalog repo (either `https://github.com/owner/repo(.git)`
 * or `owner/repo`) into its `owner` / `repo` parts.
 */
export function parseCatalogRepo(repo: string): {
	owner: string;
	repo: string;
} {
	const trimmed = repo.trim();
	const httpsMatch =
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
			trimmed,
		);
	if (httpsMatch) {
		return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
	}
	const shorthandMatch =
		/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
	if (shorthandMatch) {
		return { owner: shorthandMatch[1]!, repo: shorthandMatch[2]! };
	}
	throw new ImportError(
		`Invalid LESSONS_CATALOG_REPO "${repo}". Expected https://github.com/owner/repo or owner/repo.`,
	);
}

export class BundledCatalogSource implements CatalogSource {
	readonly kind = "bundled" as const;

	constructor(private readonly catalogDir: string) {}

	async getManifest(): Promise<CatalogManifest> {
		const manifestPath = resolve(this.catalogDir, "modules.json");
		try {
			const raw = await readFile(manifestPath, "utf8");
			const parsed = lessonCatalogSchema.parse(JSON.parse(raw));
			return { modules: sortCatalogEntries(parsed.modules), error: null };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to read catalog.";
			log.error("bundled catalog manifest unreadable", {
				manifestPath,
				err: error instanceof Error ? error : new Error(message),
			});
			return { modules: [], error: message };
		}
	}

	async resolveModule(moduleId: string): Promise<LessonModule> {
		const { modules } = await this.getManifest();
		return findModuleOrThrow(modules, moduleId);
	}
}

export class RemoteCatalogSource implements CatalogSource {
	readonly kind = "remote" as const;

	private readonly owner: string;
	private readonly repo: string;
	private cached: { modules: LessonCatalogEntry[]; fetchedAt: number } | null =
		null;

	constructor(
		repo: string,
		private readonly branch: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {
		const parsed = parseCatalogRepo(repo);
		this.owner = parsed.owner;
		this.repo = parsed.repo;
	}

	/** The HTTPS URL used by the catalog load step's sparse shallow clone. */
	get cloneUrl(): string {
		return `https://github.com/${this.owner}/${this.repo}.git`;
	}

	get branchName(): string {
		return this.branch;
	}

	private get manifestUrl(): string {
		return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/modules.json`;
	}

	async getManifest(): Promise<CatalogManifest> {
		const now = Date.now();
		if (this.cached && now - this.cached.fetchedAt < REMOTE_CACHE_TTL_MS) {
			return { modules: this.cached.modules, error: null };
		}

		try {
			const response = await this.fetchImpl(this.manifestUrl);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} fetching catalog manifest.`);
			}
			const parsed = lessonCatalogSchema.parse(await response.json());
			const modules = sortCatalogEntries(parsed.modules);
			this.cached = { modules, fetchedAt: now };
			return { modules, error: null };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Unable to fetch catalog.";
			log.warn("remote catalog fetch failed", {
				manifestUrl: this.manifestUrl,
				err: error instanceof Error ? error : new Error(message),
			});
			// Serve last-good cached manifest on failure.
			if (this.cached) {
				return { modules: this.cached.modules, error: null };
			}
			return { modules: [], error: message };
		}
	}

	async resolveModule(moduleId: string): Promise<LessonModule> {
		const { modules } = await this.getManifest();
		return findModuleOrThrow(modules, moduleId);
	}
}

function findModuleOrThrow(
	entries: LessonCatalogEntry[],
	moduleId: string,
): LessonModule {
	const found = flattenLessonModules(entries).find(
		(module) => module.id === moduleId,
	);
	if (!found) {
		throw new ImportError(`Unknown lesson module "${moduleId}".`);
	}
	return found;
}

export function createCatalogSource(config: ControlConfig): CatalogSource {
	if (config.catalogRepo) {
		return new RemoteCatalogSource(config.catalogRepo, config.catalogBranch);
	}
	return new BundledCatalogSource(config.catalogDir);
}
