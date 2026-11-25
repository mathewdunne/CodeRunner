import { describe, expect, test } from "bun:test";
import { access, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	flattenLessonModules,
	lessonCatalogSchema,
} from "../packages/contracts/src/index";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const catalogRoot = resolve(repoRoot, "catalog");

async function expectCatalogFile(relativePath: string): Promise<void> {
	const path = resolve(catalogRoot, relativePath);
	await access(path);
	const fileStat = await stat(path);
	expect(fileStat.isFile()).toBe(true);
	expect(fileStat.size).toBeGreaterThan(0);
}

describe("bundled lesson catalog", () => {
	test("modules.json parses and matches the contract schema", async () => {
		const manifestPath = resolve(catalogRoot, "modules.json");
		const manifest = await Bun.file(manifestPath).json();
		const catalog = lessonCatalogSchema.parse(manifest);

		expect(catalog.schemaVersion).toBe(1);
		const ids = flattenLessonModules(catalog.modules)
			.map((module) => module.id)
			.sort();
		expect(ids).toEqual(["hello-world", "robot-starter"]);
	});

	test("every subdir module exists and is non-empty", async () => {
		const manifest = await Bun.file(
			resolve(catalogRoot, "modules.json"),
		).json();
		const catalog = lessonCatalogSchema.parse(manifest);

		for (const module of flattenLessonModules(catalog.modules)) {
			if (module.subdir === undefined) continue;
			const subdirPath = resolve(catalogRoot, module.subdir);
			const subdirStat = await stat(subdirPath);
			expect(subdirStat.isDirectory()).toBe(true);
			const entries = await readdir(subdirPath);
			expect(entries.length).toBeGreaterThan(0);
		}
	});

	test("hello-world plain-java module ships its sources and launch config", async () => {
		await Promise.all([
			expectCatalogFile("modules/hello-world/src/Main.java"),
			expectCatalogFile("modules/hello-world/.vscode/launch.json"),
		]);
	});

	test("robot-starter is a complete buildable robot project with a lesson README", async () => {
		await Promise.all([
			expectCatalogFile("modules/robot-starter/build.gradle"),
			expectCatalogFile("modules/robot-starter/gradlew"),
			expectCatalogFile(
				"modules/robot-starter/gradle/wrapper/gradle-wrapper.jar",
			),
			expectCatalogFile(
				"modules/robot-starter/vendordeps/WPILibNewCommands.json",
			),
			expectCatalogFile("modules/robot-starter/README.md"),
			expectCatalogFile(
				"modules/robot-starter/src/main/java/frc/robot/Robot.java",
			),
		]);
	});
});
