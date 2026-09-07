import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceId } from "@frc-coderunner/contracts";
import { type ControlAppOptions, createApp } from "../app";
import {
	managedContainerStats,
	removeCodeVolume,
} from "../containers/lifecycle";
import { codeContainerName, codeVolumeName } from "../containers/metadata";
import {
	cookieFrom,
	createCatalogDir,
	createFakeDocker,
	createWebDist,
	login,
	waitFor,
	withApp,
	workspaceBySlug,
	workspaceProjectPath,
} from "./helpers";

describe("code container orchestration", () => {
	test("container status creates a managed code container with dual ports and lease", async () => {
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
				expect(body).toMatchObject({
					workspace: { slug: "alice" },
					code: {
						role: "code",
						state: "running",
						image: "coderunner-workspace:test",
						simPortAllocated: true,
						vscodePortAllocated: true,
						error: null,
					},
				});

				const workspace = app.storage.db
					.query("SELECT * FROM workspaces WHERE slug = ?")
					.get("alice") as {
					id: string;
					project_path: string;
				};
				const expectedName = codeContainerName(workspace.id);
				expect(body.code.containerName).toBe(expectedName);
				expect(fakeDocker.containers.has(expectedName)).toBe(true);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain(`frc-sim.workspace=${workspace.id}`);
				expect(runCall).toContain(`frc-sim.version=v2`);
				expect(runCall).toContain(`frc-sim.role=code`);
				expect(runCall).toContain(
					`${workspace.project_path}:/workspace/project:z`,
				);
				expect(runCall).toContain(
					`${join(app.storage.config.dataDir, "users", workspace.id, "home")}:/config:z`,
				);
				expect(runCall).toContain("127.0.0.1:45910:5810");
				expect(runCall).toContain("127.0.0.1:46000:3000");
				expect(runCall).toContain("PUID=123");
				expect(runCall).toContain("PGID=456");

				const lease = app.storage.db
					.query("SELECT * FROM container_leases WHERE workspace_id = ?")
					.get(workspace.id) as {
					vscode_container: string;
					nt4_port: number;
					vscode_port: number;
					code_state: string;
				};
				expect(lease).toMatchObject({
					vscode_container: expectedName,
					nt4_port: 45910,
					vscode_port: 46000,
					code_state: "running",
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45910, end: 45910 },
				vscodePortRange: { start: 46000, end: 46000 },
				containerUser: "123:456",
			},
		);
	});

	test("code container creation caps disk reads per detected block device", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				const cookie = cookieFrom(response);
				await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).toContain("--device-read-bps");
				expect(runCall).toContain("/dev/nvme0n1:48mb");
				expect(runCall).toContain("/dev/nvme1n1:48mb");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45911, end: 45911 },
				vscodePortRange: { start: 46001, end: 46001 },
				codeDiskReadLimit: "48mb",
				blockDevices: ["/dev/nvme0n1", "/dev/nvme1n1"],
			},
		);
	});

	test("disabling the disk read limit omits --device-read-bps", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				const cookie = cookieFrom(response);
				await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).not.toContain("--device-read-bps");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45912, end: 45912 },
				vscodePortRange: { start: 46002, end: 46002 },
				codeDiskReadLimit: null,
				blockDevices: ["/dev/nvme0n1"],
			},
		);
	});

	test("demo mode backs /config with a labelled named volume", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const workspace = workspaceBySlug(app, "demo");
				await app.containers.ensureCodeContainer(workspace);

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				const volume = codeVolumeName(workspace.id);
				expect(runCall).toContain(
					`${workspace.project_path}:/workspace/project:z`,
				);
				expect(runCall).toContain(`type=volume,src=${volume},dst=/config`);
				expect(runCall).not.toContain(
					`${join(app.storage.config.dataDir, "users", workspace.id, "home")}:/config:z`,
				);

				// Created explicitly so cleanup can reap it by label.
				const volumeCall = fakeDocker.calls.find(
					(call) => call[0] === "volume" && call[1] === "create",
				);
				expect(volumeCall).toBeTruthy();
				expect(volumeCall).toContain("frc-sim.managed=true");
				expect(volumeCall).toContain(`frc-sim.workspace=${workspace.id}`);
				expect(volumeCall).toContain(volume);
			},
			{
				demo: true,
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45913, end: 45913 },
				vscodePortRange: { start: 46003, end: 46003 },
			},
		);
	});

	test("deleting a workspace removes the named volume after its container", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const workspace = workspaceBySlug(app, "demo");
				await app.containers.ensureCodeContainer(workspace);
				const name = codeContainerName(workspace.id);
				const volume = codeVolumeName(workspace.id);

				await app.containers.removeWorkspace(workspace.id);

				expect(fakeDocker.containers.has(name)).toBe(false);
				const removeIndex = fakeDocker.calls.findIndex(
					(call) => call[0] === "rm" && call[1] === "-f" && call[2] === name,
				);
				const volumeIndex = fakeDocker.calls.findIndex(
					(call) =>
						call[0] === "volume" && call[1] === "rm" && call[2] === volume,
				);
				expect(removeIndex).toBeGreaterThanOrEqual(0);
				// The container must release the volume before it can be removed.
				expect(volumeIndex).toBeGreaterThan(removeIndex);
			},
			{
				demo: true,
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45915, end: 45915 },
				vscodePortRange: { start: 46005, end: 46005 },
			},
		);
	});

	test("volume removal tolerates a missing volume and a failing docker", async () => {
		const workspaceId = "ws-volume-cleanup" as WorkspaceId;
		const volume = codeVolumeName(workspaceId);

		for (const stderr of [`Error: No such volume: ${volume}`, "daemon boom"]) {
			const calls: string[][] = [];
			const runner = async (args: string[]) => {
				calls.push(args);
				return { exitCode: 1, stdout: "", stderr };
			};

			await removeCodeVolume(runner, workspaceId);

			expect(calls).toEqual([["volume", "rm", volume]]);
		}
	});

	test("demo mode skips the disk read cap even when one is configured", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await app.containers.ensureCodeContainer(workspaceBySlug(app, "demo"));

				const runCall = fakeDocker.calls.find((call) => call[0] === "run");
				expect(runCall).toBeTruthy();
				expect(runCall).not.toContain("--device-read-bps");
			},
			{
				demo: true,
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 45914, end: 45914 },
				vscodePortRange: { start: 46004, end: 46004 },
				codeDiskReadLimit: "48mb",
				blockDevices: ["/dev/nvme0n1"],
			},
		);
	});

	test("opening a workspace kicks off code container startup without blocking the shell", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				const cookie = cookieFrom(response);

				const shell = await app.fetch(
					new Request("http://localhost/u/alice/", {
						headers: { cookie },
					}),
				);
				expect(shell.status).toBe(200);
				await waitFor(() => fakeDocker.calls.some((call) => call[0] === "run"));
				expect(fakeDocker.containers.size).toBe(1);
			},
			{
				dockerRunner: fakeDocker.runner,
				containerAutoStart: true,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25811, end: 25811 },
				vscodePortRange: { start: 33001, end: 33001 },
			},
		);
	});

	test("s6 service script launches codium-server as primary process", async () => {
		const serviceScript = await readFile(
			join(
				process.cwd(),
				"containers",
				"code",
				"root",
				"etc",
				"s6-overlay",
				"s6-rc.d",
				"svc-vscodium-web",
				"run",
			),
			"utf8",
		);
		expect(serviceScript).toContain("/app/vscodium-web/bin/codium-server");
		expect(serviceScript).toContain("--server-base-path");
		// codium-server ignores --user-data-dir (unpatched upstream overwrites it
		// with <server-data-dir>/data); the settings layout depends on this flag.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matches literal shell text
		expect(serviceScript).toContain('--server-data-dir "${HOME}"');
		expect(serviceScript).not.toContain('--user-data-dir "');
		expect(serviceScript).toContain("--disable-workspace-trust");
	});

	test("restarted control plane rediscovers a labeled code container", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-v2-control-"));
		const catalogDir = await createCatalogDir(root);
		const webDistDir = await createWebDist(root);
		const fakeDocker = createFakeDocker();
		const config: ControlAppOptions = {
			dataDir: join(root, "data"),
			catalogDir,
			webDistDir,
			sessionSecret: "test-session-secret",
			baseUrl: "http://localhost:4000",
			containerAutoStart: false,
			dockerRunner: fakeDocker.runner,
			portAvailable: async () => true,
			codeImage: "coderunner-workspace:test",
			simPortRange: { start: 25812, end: 25812 },
			vscodePortRange: { start: 33002, end: 33002 },
		};

		const app1 = await createApp(config);
		try {
			const response = await login(app1, "alice");
			const cookie = cookieFrom(response);
			const firstStatus = await app1.fetch(
				new Request("http://localhost/u/alice/api/containers/status", {
					headers: { cookie },
				}),
			);
			expect(firstStatus.status).toBe(200);
			const runCount = fakeDocker.calls.filter(
				(call) => call[0] === "run",
			).length;
			app1.close();

			const app2 = await createApp(config);
			try {
				const secondStatus = await app2.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);
				expect(secondStatus.status).toBe(200);
				expect(await secondStatus.json()).toMatchObject({
					code: {
						state: "running",
						simPortAllocated: true,
						vscodePortAllocated: true,
					},
				});
				expect(
					fakeDocker.calls.filter((call) => call[0] === "run").length,
				).toBe(runCount);
			} finally {
				app2.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("recreating a removed container preserves project files", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				const response = await login(app, "alice");
				const cookie = cookieFrom(response);
				const projectPath = workspaceProjectPath(app, "alice");
				const robotPath = join(
					projectPath,
					"src",
					"main",
					"java",
					"frc",
					"robot",
					"Robot.java",
				);
				// The project starts empty (no first-login seed); create the dirs.
				await mkdir(dirname(robotPath), { recursive: true });
				await writeFile(robotPath, "package frc.robot;\n// sentinel\n", "utf8");

				const firstStatus = await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);
				expect(firstStatus.status).toBe(200);
				const firstBody = await firstStatus.json();
				fakeDocker.containers.delete(firstBody.code.containerName);

				const secondStatus = await app.fetch(
					new Request("http://localhost/u/alice/api/containers/status", {
						headers: { cookie },
					}),
				);
				expect(secondStatus.status).toBe(200);
				expect(await secondStatus.json()).toMatchObject({
					code: { state: "running" },
				});
				expect(await readFile(robotPath, "utf8")).toContain("sentinel");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25813, end: 25813 },
				vscodePortRange: { start: 33003, end: 33003 },
			},
		);
	});

	test("concurrent workspace startup reserves distinct port pairs", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				await login(app, "bob");
				const aliceWorkspace = workspaceBySlug(app, "alice");
				const bobWorkspace = workspaceBySlug(app, "bob");

				const [aliceStatus, bobStatus] = await Promise.all([
					app.containers.ensureCodeContainer(aliceWorkspace),
					app.containers.ensureCodeContainer(bobWorkspace),
				]);

				expect(aliceStatus.state).toBe("running");
				expect(bobStatus.state).toBe("running");
				const simPorts = [...fakeDocker.containers.values()].flatMap((c) =>
					c.ports
						.filter((p) => p.containerPort === 5810)
						.map((p) => p.hostPort),
				);
				const vscodePorts = [...fakeDocker.containers.values()].flatMap((c) =>
					c.ports
						.filter((p) => p.containerPort === 3000)
						.map((p) => p.hostPort),
				);
				expect(new Set(simPorts).size).toBe(2);
				expect(new Set(vscodePorts).size).toBe(2);
				expect(simPorts.sort()).toEqual([25814, 25815]);
				expect(vscodePorts.sort()).toEqual([33004, 33005]);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25814, end: 25815 },
				vscodePortRange: { start: 33004, end: 33005 },
			},
		);
	});

	test("retries the next port when Docker reports a bind conflict", async () => {
		const fakeDocker = createFakeDocker({ failRunPortsOnce: [25816] });

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				const status = await app.containers.ensureCodeContainer(workspace);

				expect(status.state).toBe("running");
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBe(2);
				expect(app.storage.getContainerLease(workspace.id)).toMatchObject({
					nt4_port: 25817,
				});
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25816, end: 25817 },
				vscodePortRange: { start: 33006, end: 33007 },
			},
		);
	});
});

describe("managedContainerStats", () => {
	test("batches docker inspect into a single call and maps fields per container", async () => {
		const fakeDocker = createFakeDocker();
		fakeDocker.containers.set("coderunner-workspace-alice", {
			name: "coderunner-workspace-alice",
			running: true,
			labels: {
				"frc-sim.managed": "true",
				"frc-sim.workspace": "alice",
				"frc-sim.role": "code",
			},
			ports: [],
		});
		fakeDocker.containers.set("coderunner-workspace-bob", {
			name: "coderunner-workspace-bob",
			running: false,
			labels: {
				"frc-sim.managed": "true",
				"frc-sim.workspace": "bob",
				"frc-sim.role": "code",
			},
			ports: [],
		});

		const stats = await managedContainerStats(fakeDocker.runner);

		const byName = new Map(stats.map((stat) => [stat.name, stat]));
		expect(byName.get("coderunner-workspace-alice")).toMatchObject({
			workspaceId: "alice",
			role: "code",
			state: "running",
		});
		expect(byName.get("coderunner-workspace-bob")).toMatchObject({
			workspaceId: "bob",
			role: "code",
			state: "stopped",
		});

		// Regression guard: one inspect call for all names, not one per container.
		const inspectCalls = fakeDocker.calls.filter(
			(call) => call[0] === "container" && call[1] === "inspect",
		);
		expect(inspectCalls.length).toBe(1);
		expect(inspectCalls[0]).toEqual([
			"container",
			"inspect",
			"coderunner-workspace-alice",
			"coderunner-workspace-bob",
		]);
	});

	test("degrades gracefully when a container disappears between ls and inspect", async () => {
		const fakeDocker = createFakeDocker();
		// Present in the ls output but resolvable by inspect.
		fakeDocker.containers.set("coderunner-workspace-alice", {
			name: "coderunner-workspace-alice",
			running: true,
			labels: {
				"frc-sim.managed": "true",
				"frc-sim.workspace": "alice",
				"frc-sim.role": "code",
			},
			ports: [],
		});

		// Wrap the runner so the ls also advertises a name that inspect can't find.
		const runner: typeof fakeDocker.runner = async (args) => {
			const result = await fakeDocker.runner(args);
			if (args[0] === "container" && args[1] === "ls") {
				return {
					...result,
					stdout: `${result.stdout.trim()}\ncoderunner-workspace-ghost\n`,
				};
			}
			return result;
		};

		const stats = await managedContainerStats(runner);
		const ghost = stats.find(
			(stat) => stat.name === "coderunner-workspace-ghost",
		);
		expect(ghost).toMatchObject({
			workspaceId: null,
			role: null,
			state: null,
		});
	});
});
