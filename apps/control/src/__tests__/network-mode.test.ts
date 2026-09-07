import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadControlConfig } from "../config";
import { codeContainerName } from "../containers/metadata";
import { toHostPath } from "../containers/paths";
import { createStorage } from "../storage";
import {
	cookieFrom,
	createFakeDocker,
	login,
	withApp,
	workspaceBySlug,
} from "./helpers";

describe("toHostPath", () => {
	const config = loadControlConfig({
		dataDir: "/data",
		hostDataDir: "/var/lib/coderunner/data",
	});

	test("translates paths under dataDir to the host prefix", () => {
		expect(toHostPath(config, "/data/users/ws_1/project")).toBe(
			"/var/lib/coderunner/data/users/ws_1/project",
		);
		expect(toHostPath(config, "/data")).toBe("/var/lib/coderunner/data");
	});

	test("passes paths through unchanged when hostDataDir is unset", () => {
		const passthrough = loadControlConfig({ dataDir: "/data" });
		expect(toHostPath(passthrough, "/data/users/ws_1/project")).toBe(
			"/data/users/ws_1/project",
		);
	});

	test("rejects paths outside the data directory", () => {
		expect(() => toHostPath(config, "/etc/passwd")).toThrow(
			/outside the data directory/,
		);
		expect(() => toHostPath(config, "/data/../etc")).toThrow(
			/outside the data directory/,
		);
	});

	test("rejects a relative FRC_HOST_DATA_DIR", () => {
		expect(() =>
			loadControlConfig({ dataDir: "/data", hostDataDir: "relative/path" }),
		).toThrow(/absolute path/);
	});
});

describe("network mode container orchestration", () => {
	test("creates containers on the shared network with no published ports", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				const cookie = cookieFrom(response);

				const status = await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);

				expect(status.status).toBe(200);
				const body = await status.json();
				expect(body.code).toMatchObject({
					state: "running",
					simPortAllocated: true,
					vscodePortAllocated: true,
					halsimPortAllocated: true,
					error: null,
				});

				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);
				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain("--network");
				expect(runCall).toContain("coderunner");
				expect(runCall).not.toContain("-p");

				const lease = app.storage.db
					.query("SELECT * FROM container_leases WHERE workspace_id = ?")
					.get(workspace.id) as {
					vscode_container: string;
					nt4_port: number | null;
					vscode_port: number | null;
					halsim_port: number | null;
				};
				expect(lease).toMatchObject({
					vscode_container: name,
					nt4_port: null,
					vscode_port: null,
					halsim_port: null,
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});

	test("runtime endpoints target the container name on the network", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				const runtime = await app.containers.ensureWorkspaceRunning(
					workspace.id,
				);
				const name = codeContainerName(workspace.id);
				expect(runtime.ports).toEqual({
					nt4: null,
					vscode: null,
					halsim: null,
				});
				expect(runtime.endpoints.vscode?.httpBaseUrl).toBe(
					`http://${name}:3000`,
				);
				expect(runtime.endpoints.nt4?.wsUrl).toBe(
					`ws://${name}:5810/nt/AdvantageScopeLite`,
				);
				expect(runtime.endpoints.halsim?.wsUrl).toBe(
					`ws://${name}:3300/wpilibws`,
				);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});

	test("translates bind mount sources to host paths when FRC_HOST_DATA_DIR is set", async () => {
		const fakeDocker = createFakeDocker();
		const hostDataDir = "/srv/coderunner-data";

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(workspace);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain(
					`${hostDataDir}/users/${workspace.id}/project:/workspace/project:z`,
				);
				expect(runCall).toContain(
					`${hostDataDir}/users/${workspace.id}/home:/config:z`,
				);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
				hostDataDir,
			},
		);
	});

	test("stamps the compose project label so workspaces nest under the control plane", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(workspace);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain("--label");
				expect(runCall).toContain("com.docker.compose.project=coderunner");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
				composeProject: "coderunner",
			},
		);
	});

	test("omits the compose project label when none is configured", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				await app.containers.ensureCodeContainer(workspace);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(
					runCall?.some((arg) => arg.startsWith("com.docker.compose.project=")),
				).toBe(false);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});

	test("adopts a running container already attached to the network", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [],
					networks: ["coderunner"],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				expect(status.containerName).toBe(name);
				expect(fakeDocker.calls).not.toContainEqual(["rm", "-f", name]);
				expect(fakeDocker.calls.filter((call) => call[0] === "run")).toEqual(
					[],
				);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});

	test("recreates a port-mode leftover container when running in network mode", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				// A leftover from a published-port deployment: right labels, but it
				// publishes loopback ports and is not attached to the network.
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25810, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33000, containerPort: 3000, hostIp: "127.0.0.1" },
						{ hostPort: 34000, containerPort: 3300, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain("--network");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});

	test("restarts a stopped network-mode container instead of recreating it", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = codeContainerName(workspace.id);

				fakeDocker.containers.set(name, {
					name,
					running: false,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [],
					networks: ["coderunner"],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).toContainEqual(["start", name]);
				expect(fakeDocker.calls.filter((call) => call[0] === "run")).toEqual(
					[],
				);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				containerNetwork: "coderunner",
			},
		);
	});
});

describe("workspace project path normalization", () => {
	test("re-roots project_path rows written by a differently-rooted deployment", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-normalize-"));
		const dataDir = join(root, "data");
		try {
			const first = await createStorage({
				dataDir,
				sessionSecret: "test-session-secret",
				baseUrl: "http://localhost:4000",
			});
			const now = new Date().toISOString();
			first.db
				.query(
					"INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					"user-1",
					"Alice",
					"alice@test.local",
					0,
					now,
					now,
					"student",
					"alice",
				);
			first.db
				.query(
					"INSERT INTO workspaces (id, user_id, slug, project_path, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(
					"ws_foreign",
					"user-1",
					"alice",
					"/var/lib/coderunner/data/users/ws_foreign/project",
					now,
					now,
				);
			first.close();

			// A fresh boot against the same DB (e.g. the same data dir mounted at a
			// different location) must rewrite the stale prefix.
			const second = await createStorage({
				dataDir,
				sessionSecret: "test-session-secret",
				baseUrl: "http://localhost:4000",
			});
			const row = second.db
				.query("SELECT project_path FROM workspaces WHERE id = ?")
				.get("ws_foreign") as { project_path: string };
			second.close();

			expect(row.project_path).toBe(
				resolve(dataDir, "users", "ws_foreign", "project"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
