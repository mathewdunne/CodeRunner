import { describe, expect, test } from "vitest";
import type { LessonCatalogEntry, LessonModule } from "@/lib/contracts";
import {
	catalogContainsModule,
	countCatalogModules,
	folderPathKey,
	groupCatalogBlocks,
} from "./module-groups";

function module(id: string, order = 10): LessonModule {
	return {
		id,
		title: id,
		description: "",
		subdir: `modules/${id}`,
		preserveGit: false,
		kind: "plain-java",
		order,
	};
}

describe("catalog tree helpers", () => {
	const tree: LessonCatalogEntry[] = [
		module("intro", 10),
		{
			folder: "Course",
			order: 20,
			modules: [
				module("stage-1", 20),
				{
					folder: "Advanced",
					order: 30,
					modules: [module("stage-2", 30)],
				},
				module("stage-3", 40),
			],
		},
		module("appendix", 50),
	];

	test("groups consecutive modules and preserves entry order", () => {
		const blocks = groupCatalogBlocks([
			module("a"),
			module("b"),
			{ folder: "F", order: 10, modules: [module("c")] },
			module("d"),
		]);

		expect(blocks.map((block) => block.type)).toEqual([
			"modules",
			"folder",
			"modules",
		]);
		expect(blocks[0]).toMatchObject({
			modules: [{ id: "a" }, { id: "b" }],
		});
	});

	test("counts nested modules and finds the current module", () => {
		expect(countCatalogModules(tree)).toBe(5);
		expect(catalogContainsModule(tree, "stage-2")).toBe(true);
		expect(catalogContainsModule(tree, "missing")).toBe(false);
		expect(catalogContainsModule(tree, null)).toBe(false);
	});

	test("skips folders with no modules in their subtree", () => {
		const blocks = groupCatalogBlocks([
			{ folder: "Empty", order: 10, modules: [] },
			{
				folder: "OnlyEmptyChildren",
				order: 20,
				modules: [{ folder: "Child", order: 10, modules: [] }],
			},
			module("visible"),
		]);

		expect(blocks).toEqual([{ type: "modules", modules: [module("visible")] }]);
	});

	test("builds stable folder path keys", () => {
		expect(folderPathKey(["Course", "Advanced"])).toBe("Course/Advanced");
	});
});
