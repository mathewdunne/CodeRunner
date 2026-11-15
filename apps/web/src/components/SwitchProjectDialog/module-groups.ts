import {
	isLessonFolder,
	type LessonCatalogEntry,
	type LessonFolder,
	type LessonModule,
} from "@/lib/contracts";

export type CatalogBlock =
	| { type: "modules"; modules: LessonModule[] }
	| { type: "folder"; folder: LessonFolder };

/** Stable key for a folder path (folder names cannot contain `/`). */
export function folderPathKey(path: string[]): string {
	return path.join("/");
}

/** Total modules inside a tree, including nested folders. */
export function countCatalogModules(entries: LessonCatalogEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		total += isLessonFolder(entry) ? countCatalogModules(entry.modules) : 1;
	}
	return total;
}

/** Whether a tree contains the given module id. */
export function catalogContainsModule(
	entries: LessonCatalogEntry[],
	moduleId: string | null,
): boolean {
	if (!moduleId) return false;
	return entries.some((entry) =>
		isLessonFolder(entry)
			? catalogContainsModule(entry.modules, moduleId)
			: entry.id === moduleId,
	);
}

/** Number modules depth-first, in the order the tree renders them. */
export function numberCatalogModules(
	entries: LessonCatalogEntry[],
): Map<string, number> {
	const numbers = new Map<string, number>();
	let next = 1;
	const visit = (items: LessonCatalogEntry[]) => {
		for (const entry of items) {
			if (isLessonFolder(entry)) visit(entry.modules);
			else numbers.set(entry.id, next++);
		}
	};
	visit(entries);
	return numbers;
}

/**
 * Group consecutive modules into one grid per run. Folder entries break the run
 * so the rendered list follows the sorted entry order exactly. Folders with no
 * modules anywhere in their subtree are skipped (the schema allows them).
 */
export function groupCatalogBlocks(
	entries: LessonCatalogEntry[],
): CatalogBlock[] {
	const blocks: CatalogBlock[] = [];
	let run: LessonModule[] = [];

	const flush = () => {
		if (run.length === 0) return;
		blocks.push({ type: "modules", modules: run });
		run = [];
	};

	for (const entry of entries) {
		if (isLessonFolder(entry)) {
			if (countCatalogModules(entry.modules) === 0) continue;
			flush();
			blocks.push({ type: "folder", folder: entry });
		} else {
			run.push(entry);
		}
	}
	flush();
	return blocks;
}
