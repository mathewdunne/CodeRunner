import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Timed out waiting for condition.");
}

function processArgs(pid: number): string {
	const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return result.stdout.toString();
}

describe("sim container scripts", () => {
	test("stop-sim cleans orphaned robot jar processes without a pid file", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-sim-scripts-"));
		const home = join(root, "home");
		const projectRoot = join(root, "project");
		const robotJar = join(
			projectRoot,
			"build",
			"libs",
			"frc-training-robot.jar",
		);
		await mkdir(join(projectRoot, "build", "libs"), { recursive: true });
		await mkdir(home, { recursive: true });

		const sleeper = Bun.spawn(
			["bash", "-lc", 'exec -a "java -jar $ROBOT_JAR" sleep 60'],
			{
				env: { ...Bun.env, ROBOT_JAR: robotJar },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			},
		);

		try {
			await waitFor(() => processArgs(sleeper.pid).includes(robotJar));

			const stop = Bun.spawn(["bash", join(import.meta.dir, "stop-sim.sh")], {
				env: {
					...Bun.env,
					HOME: home,
					SIM_PID_FILE: join(home, "sim.pid"),
					SIM_PROJECT_ROOT: projectRoot,
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout, stderr] = await Promise.all([
				stop.exited,
				new Response(stop.stdout).text(),
				new Response(stop.stderr).text(),
			]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toContain("sim stopped");

			const sleeperExit = await Promise.race([
				sleeper.exited,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
			]);
			expect(sleeperExit).not.toBeNull();
		} finally {
			try {
				sleeper.kill("SIGKILL");
			} catch {
				// The script should have already stopped it.
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});
