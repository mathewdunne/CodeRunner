import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const initScript = resolve(
	repoRoot,
	"containers/code/root/etc/s6-overlay/s6-rc.d/init-frc-setup/run",
);
const dockerfile = resolve(repoRoot, "containers/code/Dockerfile");
const robotSettings = resolve(
	repoRoot,
	"catalog/modules/robot-starter/.vscode/settings.json",
);

describe("Code container VS Code defaults", () => {
	test("adds the WPILib wrapper alias to existing Gradle homes", async () => {
		const contents = await readFile(initScript, "utf8");

		expect(contents).toContain(
			'ln -s wrapper "$' + '{GRADLE_USER_HOME}/permwrapper"',
		);
	});

	test("seeds workbench and Java defaults as remote machine settings", async () => {
		const contents = await readFile(initScript, "utf8");

		expect(contents).toContain(
			'MACHINE_SETTINGS="$' + '{HOME}/data/Machine/settings.json"',
		);
		expect(contents).toContain(
			'"workbench.colorTheme" //= "Default Dark Modern"',
		);
		expect(contents).toContain(
			'merge_vscode_settings "$' + '{MACHINE_SETTINGS}" defaults',
		);
		expect(contents).not.toContain("USER_SETTINGS=");
	});

	test("keeps Gradle daemon limits out of editor build arguments", async () => {
		const contents = await readFile(initScript, "utf8");
		const settings = JSON.parse(await readFile(robotSettings, "utf8"));

		expect(contents).toContain(
			"org.gradle.jvmargs=$" + "{CODERUNNER_GRADLE_JVMARGS}",
		);
		expect(contents).toContain('then del(."java.import.gradle.jvmArguments")');
		expect(contents).not.toContain(
			'."java.import.gradle.jvmArguments" //= $gradleJvmargs',
		);
		expect(contents).toContain('then del(."java.import.gradle.arguments")');
		expect(settings["java.import.gradle.jvmArguments"]).toBeUndefined();
		expect(settings["java.import.gradle.arguments"]).toBeUndefined();
	});

	test("retains the imported-project JDT memory migration", async () => {
		const contents = await readFile(initScript, "utf8");

		expect(contents).toContain('contains("-Xmx8G")');
		expect(contents).toContain('contains("-Xmx2G")');
	});

	test("runs JDT LS on Java 21 while keeping projects and Gradle on Java 17", async () => {
		const contents = await readFile(initScript, "utf8");
		const dockerfileContents = await readFile(dockerfile, "utf8");

		expect(dockerfileContents).toContain("ENV JDK_HOME=/usr/lib/jvm/jdk-21");
		expect(dockerfileContents).not.toContain("ENV JDTLS_JAVA_HOME=");
		expect(contents).toContain(
			'TOOLING_JAVA_HOME="$' + '{JDK_HOME:-/usr/lib/jvm/jdk-21}"',
		);
		expect(contents).toContain(
			'PROJECT_JAVA_HOME="$' + '{PROJECT_JAVA_HOME:-/usr/lib/jvm/jdk-17}"',
		);
		expect(contents).toContain(
			'if ."java.jdt.ls.java.home" == $legacyJdtJavaHome',
		);
		expect(contents).toContain('then del(."java.jdt.ls.java.home")');
		expect(contents).toContain(
			'."java.import.gradle.java.home" //= $projectJavaHome',
		);
		expect(contents).toContain('"name": "JavaSE-17"');
		expect(contents).toContain('"default": true');
	});

	test("ships one directly primed Gradle cache layer", async () => {
		const contents = await readFile(dockerfile, "utf8");

		expect(contents).toContain(
			"GRADLE_USER_HOME=/opt/frc-gradle-cache ./gradlew",
		);
		expect(contents).toContain(
			"COPY --chown=abc:abc catalog/ /opt/frc-catalog/",
		);
		expect(contents).not.toContain("cp -a /config/.gradle/.");
	});

	test("builds Spotless from pinned publisher source", async () => {
		const contents = await readFile(dockerfile, "utf8");

		expect(contents).toContain(
			"SPOTLESS_GRADLE_COMMIT=c11a273a11454bfc06fc9cbb19290d5c330e884c",
		);
		expect(contents).toContain("FROM node:24-slim AS spotless-builder");
		expect(contents).not.toContain("gallery.vsassets.io");
	});

	test("trusts repository LF normalization at image build time", async () => {
		const contents = await readFile(dockerfile, "utf8");

		expect(contents).not.toContain("sed -i 's/\\r$//' ");
	});

	test("pairs the webview CDN bootstrap with the VSCodium build", async () => {
		const contents = await readFile(dockerfile, "utf8");

		expect(contents).toContain(
			"VSCODE_WEBVIEW_COMMIT=7e7950df89d055b5a378379db9ee14290772148a",
		);
		expect(contents).toContain(
			"STALE_WEBVIEW_COMMIT=ef65ac1ba57f57f2a3961bfe94aa20481caca4c6",
		);
		expect(contents).toContain(
			'xargs sed -i "s/$' +
				"{STALE_WEBVIEW_COMMIT}/$" +
				'{VSCODE_WEBVIEW_COMMIT}/g"',
		);
		expect(contents).toContain(
			'grep -rhoF "$' +
				'{STALE_WEBVIEW_COMMIT}" $' +
				'{VSCODE_PRODUCT_PATHS} | wc -l)" -eq 0',
		);
	});
});
