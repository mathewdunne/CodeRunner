import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = Bun.YAML.parse(
	await Bun.file(
		new URL("../.github/workflows/release.yml", import.meta.url),
	).text(),
) as {
	jobs: Record<
		string,
		{ steps: { id?: string; name?: string; run?: string }[] }
	>;
};

function script(job: string, name: string): string {
	const step = workflow.jobs[job]?.steps.find(
		(step) => step.id === name || step.name === name,
	);
	if (!step?.run) throw new Error(`Missing workflow script: ${job}/${name}`);
	return step.run;
}

async function run(script: string, env: Record<string, string>, stubs: string) {
	const process = Bun.spawn(["bash", "-c", `${stubs}\n${script}`], {
		env: { ...Bun.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: await process.exited,
		stdout: await new Response(process.stdout).text(),
		stderr: await new Response(process.stderr).text(),
	};
}

describe("release workflow", () => {
	const git = `git() {
  case "$1" in
    rev-parse) echo test-sha ;;
    fetch) echo fetched-main ;;
    merge-base) return "$ANCESTOR_STATUS" ;;
    *) return 99 ;;
  esac
}`;

	test.each([
		["v0.6.1-selinux-fix", "1", 0],
		["v0.6.1", "1", 1],
		["v0.6.1", "0", 0],
		["v0.6.1+metadata", "0", 1],
		["not-a-version", "0", 1],
	])("validates %s with ancestry status %s", async (tag, ancestry, code) => {
		const result = await run(
			script("validate", "validate"),
			{ TAG: tag, ANCESTOR_STATUS: ancestry, GITHUB_OUTPUT: "/dev/null" },
			git,
		);
		expect(result.code).toBe(code);
		expect(result.stderr).toBe("");
		if (tag === "v0.6.1-selinux-fix") {
			expect(result.stdout).not.toContain("fetched-main");
		}
	});

	test.each([
		"v0.6.1",
		"v0.6.1-selinux-fix",
	])("publishes appropriate image and release tags for %s", async (tag) => {
		const temp = await mkdtemp(join(tmpdir(), "coderunner-release-test-"));
		try {
			for (const image of ["workspace", "control"]) {
				await mkdir(join(temp, "digests", image), { recursive: true });
				await writeFile(join(temp, "digests", image, "abc123"), "");
			}
			const result = await run(
				script("merge", "Create multi-arch manifests").replaceAll(
					// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, replaced before Bash executes.
					"${{ runner.temp }}",
					temp,
				),
				{
					TAG: tag,
					WORKSPACE_IMAGE: "test/workspace",
					CONTROL_IMAGE: "test/control",
				},
				'docker() { printf "%s\\n" "$*"; }',
			);
			expect(result.code).toBe(0);
			for (const image of ["workspace", "control"]) {
				expect(result.stdout).toContain(`-t test/${image}:${tag}`);
				expect(result.stdout.includes(`-t test/${image}:latest`)).toBe(
					!tag.includes("-"),
				);
			}
			const release = await run(
				script("release", "Upload release artifacts"),
				{ TAG: tag, TAG_SHA: "test-sha" },
				'gh() { if [[ "$2" == view ]]; then return 1; fi; printf "%s\\n" "$*"; }',
			);
			expect(release.code).toBe(0);
			expect(release.stdout).toContain(`release create ${tag}`);
			expect(release.stdout.includes("--prerelease --latest=false")).toBe(
				tag.includes("-"),
			);
			expect(release.stdout).toContain(`release upload ${tag}`);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});
});
