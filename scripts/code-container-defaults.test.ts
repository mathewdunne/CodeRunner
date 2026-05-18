import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const initScript = resolve(
	repoRoot,
	"containers/code/root/etc/s6-overlay/s6-rc.d/init-frc-setup/run",
);

describe("Code container VS Code defaults", () => {
	test("seeds the remote machine settings with the dark theme id", async () => {
		const contents = await readFile(initScript, "utf8");

		expect(contents).toContain(
			'MACHINE_SETTINGS="$' + '{HOME}/data/Machine/settings.json"',
		);
		expect(contents).toContain(
			'"workbench.colorTheme" //= "Default Dark Modern"',
		);
	});
});
