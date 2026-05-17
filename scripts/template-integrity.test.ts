import { describe, expect, test } from "bun:test";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const templateRoot = resolve(repoRoot, "templates", "wpilib-java-command");

async function expectTemplateFile(relativePath: string): Promise<void> {
	const path = resolve(templateRoot, relativePath);
	await access(path);
	const fileStat = await stat(path);
	expect(fileStat.isFile()).toBe(true);
	expect(fileStat.size).toBeGreaterThan(0);
}

describe("WPILib Java command starter template", () => {
	test("contains the files required for clean-checkout workspace creation", async () => {
		await Promise.all([
			expectTemplateFile("build.gradle"),
			expectTemplateFile("settings.gradle"),
			expectTemplateFile("gradle.properties"),
			expectTemplateFile("gradlew"),
			expectTemplateFile("gradlew.bat"),
			expectTemplateFile("gradle/wrapper/gradle-wrapper.jar"),
			expectTemplateFile("gradle/wrapper/gradle-wrapper.properties"),
			expectTemplateFile(".vscode/settings.json"),
			expectTemplateFile(".wpilib/wpilib_preferences.json"),
			expectTemplateFile("vendordeps/WPILibNewCommands.json"),
			expectTemplateFile("src/main/java/frc/robot/Main.java"),
			expectTemplateFile("src/main/java/frc/robot/Robot.java"),
			expectTemplateFile("src/main/java/frc/robot/RobotContainer.java"),
		]);
	});
});
