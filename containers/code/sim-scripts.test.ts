import { describe, expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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
	test("start-sim applies bounded Gradle runtime defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "frc-sim-start-"));
		const home = join(root, "home");
		const projectRoot = join(root, "project");
		const argsPath = join(projectRoot, "gradlew.args");
		const userHomePath = join(projectRoot, "gradle-user-home");
		await mkdir(projectRoot, { recursive: true });
		await mkdir(home, { recursive: true });
		await writeFile(join(projectRoot, "build.gradle"), "plugins {}\n", "utf8");
		await writeFile(
			join(projectRoot, "gradlew"),
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$@" > "$SIM_PROJECT_ROOT/gradlew.args"',
				'printf "%s\\n" "$GRADLE_USER_HOME" > "$SIM_PROJECT_ROOT/gradle-user-home"',
				"sleep 60",
			].join("\n"),
			"utf8",
		);
		await chmod(join(projectRoot, "gradlew"), 0o755);

		try {
			const start = Bun.spawn(["bash", join(import.meta.dir, "start-sim.sh")], {
				env: {
					...Bun.env,
					HOME: home,
					SIM_PID_FILE: join(home, "sim.pid"),
					SIM_LOG_FILE: join(home, "sim.log"),
					SIM_PROJECT_ROOT: projectRoot,
					RUN_SIM_SCRIPT: join(import.meta.dir, "run-sim.sh"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout, stderr] = await Promise.all([
				start.exited,
				new Response(start.stdout).text(),
				new Response(start.stderr).text(),
			]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).toContain("started sim with pid");

			await waitFor(async () => {
				const args = await readFile(argsPath, "utf8").catch(() => "");
				return args.length > 0;
			});

			const args = (await readFile(argsPath, "utf8")).trim().split("\n");
			expect(args).toContain("--no-daemon");
			expect(args).toContain("--no-watch-fs");
			expect(args).toContain("--max-workers=2");
			expect(args).toContain("--console=plain");
			expect(args).toContain(
				"-Dorg.gradle.jvmargs=-Xms64m -Xmx384m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=96m -XX:+HeapDumpOnOutOfMemoryError -XX:ActiveProcessorCount=2 -Dfile.encoding=UTF-8",
			);
			expect(args.at(-1)).toBe("simulateExternalJavaRelease");
			expect(await readFile(userHomePath, "utf8")).toBe(
				`${join(home, ".gradle")}\n`,
			);
		} finally {
			const stop = Bun.spawn(["bash", join(import.meta.dir, "stop-sim.sh")], {
				env: {
					...Bun.env,
					HOME: home,
					SIM_PID_FILE: join(home, "sim.pid"),
					SIM_PROJECT_ROOT: projectRoot,
				},
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			await stop.exited;
			await rm(root, { recursive: true, force: true });
		}
	});

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
