import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakeDocker, login, withApp, workspaceBySlug } from "./helpers";

describe("container reconciliation", () => {
	test("adoption rejects a container with non-loopback port bindings", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = `coderunner-workspace-${workspace.id}`;

				// Pre-create a container with a non-loopback (0.0.0.0) sim port
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
						{ hostPort: 25830, containerPort: 5810, hostIp: "0.0.0.0" },
						{ hostPort: 33050, containerPort: 3000, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				// The container with non-loopback ports should have been removed and a new one created
				expect(status.state).toBe("running");
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBeGreaterThan(0);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25830, end: 25831 },
				vscodePortRange: { start: 33050, end: 33051 },
			},
		);
	});

	test("adoption rejects a container with mismatched labels", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = `coderunner-workspace-${workspace.id}`;

				// Pre-create a container with wrong version label
				fakeDocker.containers.set(name, {
					name,
					running: true,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v1",
						"frc-sim.role": "sim",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25832, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33052, containerPort: 3000, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				// The old mismatched container should have been removed
				expect(fakeDocker.calls).toContainEqual(["rm", "-f", name]);
				// A new properly-labeled container should have been created
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBeGreaterThan(0);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25832, end: 25833 },
				vscodePortRange: { start: 33052, end: 33053 },
			},
		);
	});

	test("adoption restarts a stopped code container instead of creating a new one", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = `coderunner-workspace-${workspace.id}`;

				// Pre-create a stopped container with correct labels
				fakeDocker.containers.set(name, {
					name,
					running: false,
					labels: {
						"frc-sim.managed": "true",
						"frc-sim.version": "v2",
						"frc-sim.role": "code",
						"frc-sim.workspace": workspace.id,
					},
					ports: [
						{ hostPort: 25834, containerPort: 5810, hostIp: "127.0.0.1" },
						{ hostPort: 33054, containerPort: 3000, hostIp: "127.0.0.1" },
						{ hostPort: 34054, containerPort: 3300, hostIp: "127.0.0.1" },
					],
				});

				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				// Should have started the existing container, not created a new one
				expect(fakeDocker.calls).toContainEqual(["start", name]);
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBe(0);
				expect(fakeDocker.containers.get(name)?.running).toBe(true);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25834, end: 25835 },
				vscodePortRange: { start: 33054, end: 33055 },
				halsimPortRange: { start: 34054, end: 34055 },
			},
		);
	});

	test("lease row exists but container is missing triggers recreation", async () => {
		const fakeDocker = createFakeDocker();

		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");
				const name = `coderunner-workspace-${workspace.id}`;

				// Create a lease row without a matching Docker container
				app.storage.upsertCodeContainerLease({
					workspaceId: workspace.id,
					containerName: name,
					simPort: 25836,
					vscodePort: 33056,
					halsimPort: 34056,
					state: "running",
				});

				// ensureCodeContainer should detect the missing container and recreate
				const status = await app.containers.ensureCodeContainer(workspace);
				expect(status.state).toBe("running");
				const runCalls = fakeDocker.calls.filter((call) => call[0] === "run");
				expect(runCalls.length).toBe(1);
				expect(fakeDocker.containers.has(name)).toBe(true);
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25836, end: 25837 },
				vscodePortRange: { start: 33056, end: 33057 },
				halsimPortRange: { start: 34056, end: 34057 },
			},
		);
	});

	test("idle teardown followed by reload preserves vscode user data directory", async () => {
		const fakeDocker = createFakeDocker();
		await withApp(
			async (app) => {
				await login(app, "alice");
				const workspace = workspaceBySlug(app, "alice");

				await app.containers.ensureCodeContainer(workspace);
				expect(
					fakeDocker.containers.get(`coderunner-workspace-${workspace.id}`)
						?.running,
				).toBe(true);

				// Write a file into the home directory (simulating vscode user data)
				const homePath = join(
					app.storage.config.dataDir,
					"users",
					workspace.id,
					"home",
				);
				await mkdir(join(homePath, "data", "User"), { recursive: true });
				await writeFile(
					join(homePath, "data", "User", "settings.json"),
					'{"editor.fontSize": 16}',
					"utf8",
				);

				// Idle teardown
				await app.containers.stopWorkspaceContainers(workspace.id);
				await app.containers.removeCodeContainer(workspace.id);
				expect(
					fakeDocker.containers.has(`coderunner-workspace-${workspace.id}`),
				).toBe(false);

				// Reload creates new container
				await app.containers.ensureCodeContainer(workspace);
				expect(
					fakeDocker.containers.has(`coderunner-workspace-${workspace.id}`),
				).toBe(true);

				// User data should persist on the host (bind-mounted home)
				const settingsContent = await readFile(
					join(homePath, "data", "User", "settings.json"),
					"utf8",
				);
				expect(settingsContent).toContain("editor.fontSize");
			},
			{
				dockerRunner: fakeDocker.runner,
				codeImage: "coderunner-workspace:test",
				simPortRange: { start: 25838, end: 25839 },
				vscodePortRange: { start: 33058, end: 33059 },
			},
		);
	});
});
