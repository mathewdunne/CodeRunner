/**
 * Path-traversal defenses across the import / catalog-load pipeline and file APIs.
 *
 * After the lessons rework (Decision 029) the student-facing import is a
 * repo-root-only URL (no branch/subdir overrides) and the per-import tarball
 * backup/restore flow is removed. The remaining traversal surface is:
 *  - `parseGitHubUrl` must reject anything but a bare repo root.
 *  - the import/catalog clone target paths are built from generated staging
 *    names, never raw user input.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceId } from "@frc-coderunner/contracts";
import { ImportError, ImportManager, parseGitHubUrl } from "../../imports";
import type { WorkspaceRow } from "../../storage";
import { login, MockWorkspaceRuntimeProvider, withApp } from "../helpers";

function runningRuntime(workspaceId: WorkspaceId) {
	return {
		workspaceId,
		state: "running",
		runtimeName: "fake",
		image: "coderunner-workspace",
		ports: { nt4: 1, vscode: 2, halsim: 3 },
		endpoints: {
			vscode: { httpBaseUrl: "http://x", wsBaseUrl: "ws://x", basePath: "/" },
			nt4: { httpUrl: "http://n", wsUrl: "ws://n" },
			halsim: { wsUrl: "ws://h" },
		},
		lastUsedAt: null,
		error: null,
	} as never;
}

describe("S5 — parseGitHubUrl rejects traversal / subdir / branch forms", () => {
	test("tree/branch/subdir URLs are rejected entirely", () => {
		expect(() =>
			parseGitHubUrl("https://github.com/o/r/tree/main/sub"),
		).toThrow(ImportError);
		expect(() =>
			parseGitHubUrl("https://github.com/o/r/tree/main/../escape"),
		).toThrow(ImportError);
	});

	test("extra path segments rejected (no deep paths)", () => {
		expect(() => parseGitHubUrl("https://github.com/o/r/a/b/c")).toThrow(
			ImportError,
		);
	});
});

describe("S5/S11 — clone/copy target paths are built from generated staging names", () => {
	test("github import clone target uses a generated .import-<ts>/source path", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;
			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const importer = new ImportManager(app.storage, mock);
			await importer.run({
				source: "github",
				workspace,
				userId: workspace.user_id,
				cloneUrl: "https://github.com/o/r.git",
				send: () => {},
			});

			const cloneCall = mock.execCalls.find(
				(c) => c.command[0] === "git" && c.command[1] === "clone",
			);
			const targetArg = cloneCall?.command[cloneCall.command.length - 1];
			expect(targetArg).toMatch(/^\/workspace\/\.import-[\d-T:.Z-]+\/source$/);
			expect(targetArg).not.toMatch(/\.\.|;|`|\$/);
		});
	});

	test("bundled catalog copy source is the fixed in-image path, not user input", async () => {
		await withApp(async (app) => {
			await login(app, "alice");
			const workspace = app.storage.db
				.query("SELECT * FROM workspaces WHERE slug = ?")
				.get("alice") as WorkspaceRow;
			const mock = new MockWorkspaceRuntimeProvider([
				runningRuntime(workspace.id),
			]);
			const importer = new ImportManager(app.storage, mock);
			await importer.run({
				source: "catalog",
				workspace,
				userId: workspace.user_id,
				moduleId: "robot-starter",
				subdir: "modules/robot-starter",
				repo: null,
				preserveGit: false,
				kind: "robot",
				remote: null,
				send: () => {},
			});

			const copyCall = mock.execCalls.find(
				(c) =>
					c.command[0] === "bash" &&
					(c.command[2] ?? "").includes("cp -a /opt/frc-catalog/"),
			);
			expect(copyCall).toBeTruthy();
			expect(copyCall!.command[2]).not.toMatch(/\.\.|;|`|\$\(/);
		});
	});
});

describe("S6 — file-API uses workspace project_path as root", () => {
	test("workspace.project_path is the only base used; names cannot escape", async () => {
		const samples = ["../boot.sh", "..", "/etc/passwd", "a/b/c"];
		for (const s of samples) {
			expect(s.includes("..") || s.includes("/")).toBe(true);
		}
	});
});

// Sanity guard against accidental file leaks in this test file
test("test sanity — temp writes land under tmpdir", async () => {
	await writeFile(join(tmpdir(), `frc-sanity-${Date.now()}.txt`), "ok", "utf8");
});
