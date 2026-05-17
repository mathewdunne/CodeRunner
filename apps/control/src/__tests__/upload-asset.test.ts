import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cookieFrom, login, withApp, workspaceBySlug } from "./helpers";

/**
 * Build a minimal valid AdvantageScope asset ZIP containing a single directory
 * with a config.json and one model file.
 */
async function createAssetZip(
	root: string,
	assetName: string,
	config: object = { name: assetName },
): Promise<string> {
	const assetDir = join(root, assetName);
	await mkdir(assetDir, { recursive: true });
	await writeFile(
		join(assetDir, "config.json"),
		JSON.stringify(config),
		"utf8",
	);
	await writeFile(join(assetDir, "model.glb"), "fake-model-data", "utf8");

	const zipPath = join(root, `${assetName}.zip`);
	const proc = Bun.spawn(["zip", "-r", zipPath, assetName], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return zipPath;
}

describe("AdvantageScope upload asset", () => {
	test("POST /scope/uploadAsset without auth returns 401", async () => {
		await withApp(async (app) => {
			const res = await app.fetch(
				new Request("http://localhost/scope/uploadAsset", { method: "POST" }),
			);
			expect(res.status).toBe(401);
		});
	});

	test("POST /scope/uploadAsset with valid ZIP extracts to user assets dir", async () => {
		await withApp(async (app, root) => {
			const loginRes = await login(app, "Alice");
			const cookie = cookieFrom(loginRes);
			const workspace = workspaceBySlug(app, "alice");

			const zipPath = await createAssetZip(join(root, "zips"), "Robot_Custom", {
				name: "Robot_Custom",
				type: "Robot",
			});
			const zipFile = Bun.file(zipPath);

			const formData = new FormData();
			formData.append(
				"file",
				new File([await zipFile.arrayBuffer()], "Robot_Custom.zip"),
			);

			const res = await app.fetch(
				new Request("http://localhost/scope/uploadAsset", {
					method: "POST",
					headers: { cookie },
					body: formData,
				}),
			);
			expect(res.status).toBe(200);

			// Verify files were extracted to the user's assets directory
			const assetsDir = join(dirname(workspace.project_path), "assets");
			const assetEntries = await readdir(join(assetsDir, "Robot_Custom"));
			expect(assetEntries).toContain("config.json");
			expect(assetEntries).toContain("model.glb");

			const config = JSON.parse(
				await readFile(join(assetsDir, "Robot_Custom", "config.json"), "utf8"),
			);
			expect(config.name).toBe("Robot_Custom");
		});
	});

	test("POST /scope/uploadAsset rejects ZIP without config.json", async () => {
		await withApp(async (app, root) => {
			const loginRes = await login(app, "Alice");
			const cookie = cookieFrom(loginRes);

			// Create a ZIP with a directory but no config.json
			const assetDir = join(root, "zips", "BadAsset");
			await mkdir(assetDir, { recursive: true });
			await writeFile(join(assetDir, "model.glb"), "fake-model-data", "utf8");

			const zipPath = join(root, "zips", "BadAsset.zip");
			const proc = Bun.spawn(["zip", "-r", zipPath, "BadAsset"], {
				cwd: join(root, "zips"),
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;

			const formData = new FormData();
			formData.append(
				"file",
				new File([await Bun.file(zipPath).arrayBuffer()], "BadAsset.zip"),
			);

			const res = await app.fetch(
				new Request("http://localhost/scope/uploadAsset", {
					method: "POST",
					headers: { cookie },
					body: formData,
				}),
			);
			expect(res.status).toBe(400);
			expect(await res.text()).toContain("config.json");
		});
	});

	test("GET /scope/assets manifest includes user-uploaded assets merged with bundled", async () => {
		await withApp(async (app, _root) => {
			const loginRes = await login(app, "Alice");
			const cookie = cookieFrom(loginRes);
			const workspace = workspaceBySlug(app, "alice");

			// Place a user asset directly
			const userAssetDir = join(
				dirname(workspace.project_path),
				"assets",
				"Field2d_Custom",
			);
			await mkdir(userAssetDir, { recursive: true });
			await writeFile(
				join(userAssetDir, "config.json"),
				JSON.stringify({ name: "Field2d_Custom" }),
				"utf8",
			);
			await writeFile(join(userAssetDir, "field.png"), "fake-image", "utf8");

			const res = await app.fetch(
				new Request("http://localhost/scope/assets", {
					headers: { cookie },
				}),
			);
			expect(res.status).toBe(200);
			const manifest = (await res.json()) as Record<string, unknown>;

			// Should include both the bundled Robot_Test and user-uploaded Field2d_Custom
			expect(manifest["Robot_Test/config.json"]).toBeTruthy();
			expect(manifest["Field2d_Custom/config.json"]).toBeTruthy();
			expect(manifest["Field2d_Custom/field.png"]).toBe(null);
		});
	});

	test("GET /scope/assets/<user-asset-path> serves files from user assets dir", async () => {
		await withApp(async (app, _root) => {
			const loginRes = await login(app, "Alice");
			const cookie = cookieFrom(loginRes);
			const workspace = workspaceBySlug(app, "alice");

			// Place a user asset
			const userAssetDir = join(
				dirname(workspace.project_path),
				"assets",
				"Robot_Custom",
			);
			await mkdir(userAssetDir, { recursive: true });
			await writeFile(
				join(userAssetDir, "config.json"),
				JSON.stringify({ name: "Robot_Custom" }),
				"utf8",
			);

			const res = await app.fetch(
				new Request("http://localhost/scope/assets/Robot_Custom/config.json", {
					headers: { cookie },
				}),
			);
			expect(res.status).toBe(200);
			const config = (await res.json()) as { name: string };
			expect(config.name).toBe("Robot_Custom");
		});
	});
});
