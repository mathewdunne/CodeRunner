import { cp, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyAdvantageScopePatches } from "./apply-ascope-patches";

const repoRoot = resolve(import.meta.dirname, "..");
const ascopeRoot = resolve(repoRoot, "vendor", "AdvantageScope");
const ascopeLiteStatic = resolve(ascopeRoot, "lite", "static");
const distDir = resolve(repoRoot, "dist", "advantagescope");
const defaultEmsdk = "D:/Documents/GitHub/emsdk";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function run(
	command: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<void> {
	console.log(`\n> ${command} ${args.join(" ")}`);
	const spawnOptions: {
		cwd?: string;
		env?: Record<string, string>;
		stdout: "inherit";
		stderr: "inherit";
		stdin: "ignore";
	} = {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	};
	if (options.cwd !== undefined) {
		spawnOptions.cwd = options.cwd;
	}
	if (options.env !== undefined) {
		spawnOptions.env = options.env;
	}
	const subprocess = Bun.spawn([command, ...args], spawnOptions);
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed with exit ${exitCode}.`,
		);
	}
}

async function ensureSubmodule(): Promise<void> {
	if (!(await exists(resolve(ascopeRoot, "package.json")))) {
		throw new Error(
			"vendor/AdvantageScope/package.json not found. Run git submodule update --init --recursive.",
		);
	}
}

async function ensureEmscripten(): Promise<string> {
	const emsdkRoot = Bun.env.EMSDK ?? defaultEmsdk;
	const emscriptenDir = resolve(emsdkRoot, "upstream", "emscripten");
	if (!(await exists(emscriptenDir))) {
		throw new Error(
			`emscripten not found at ${emscriptenDir}. Set EMSDK or install/activate emsdk 4.0.12.`,
		);
	}
	return emsdkRoot;
}

function envWithEmsdk(emsdkRoot: string): Record<string, string> {
	const separator = process.platform === "win32" ? ";" : ":";
	const currentPath = Bun.env.PATH ?? Bun.env.Path ?? "";
	return {
		...Bun.env,
		EMSDK: emsdkRoot,
		PATH: [
			emsdkRoot,
			resolve(emsdkRoot, "upstream", "emscripten"),
			currentPath,
		].join(separator),
	};
}

type GitSymlink = { path: string; hash: string };

async function gitSymlinksUnder(prefix: string): Promise<GitSymlink[]> {
	const subprocess = Bun.spawn(
		["git", "-C", ascopeRoot, "ls-files", "-s", prefix],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			stderr.trim() || `git ls-files failed with exit ${exitCode}.`,
		);
	}

	const symlinks: GitSymlink[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		// Format: "120000 <hash> <stage>\t<path>"
		if (!line.startsWith("120000 ")) continue;
		const tabIdx = line.indexOf("\t");
		if (tabIdx < 0) continue;
		const fields = line.slice(0, tabIdx).split(/\s+/u);
		const hash = fields[1];
		const path = line.slice(tabIdx + 1);
		if (!hash || !path) continue;
		symlinks.push({ path, hash });
	}
	return symlinks;
}

async function gitBlobContent(hash: string): Promise<string> {
	const subprocess = Bun.spawn(
		["git", "-C", ascopeRoot, "cat-file", "-p", hash],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			stderr.trim() || `git cat-file failed with exit ${exitCode}.`,
		);
	}
	return stdout;
}

async function resolveSymlinksInDist(): Promise<void> {
	for (const { path: repoRelativePath, hash } of await gitSymlinksUnder(
		"lite/static",
	)) {
		const distRelativePath = repoRelativePath.replace(/^lite\/static\//u, "");
		const placeholder = resolve(distDir, ...distRelativePath.split("/"));

		// Read the link target from git, not from the filesystem. The upstream
		// bundleLiteAssets.mjs rewrites some symlinks at build time into corrupt
		// absolute paths (e.g. lite/static/www → /abs/.../lite/static/www, which
		// loops back on itself). The git blob holds the canonical relative target.
		const linkText = (await gitBlobContent(hash)).trim();

		const linkSourceDir = dirname(
			resolve(ascopeRoot, ...repoRelativePath.split("/")),
		);
		const target = resolve(linkSourceDir, linkText);
		await rm(placeholder, { force: true, recursive: true });
		if (!(await exists(target))) {
			console.warn(
				`Skipped missing symlink target ${repoRelativePath} -> ${linkText}`,
			);
			continue;
		}
		await cp(target, placeholder, { recursive: true });
		console.log(`Resolved ${repoRelativePath} -> ${linkText}`);
	}
}

async function stageBundle(): Promise<void> {
	if (!(await exists(ascopeLiteStatic))) {
		throw new Error(
			`Expected AdvantageScope Lite output at ${ascopeLiteStatic}.`,
		);
	}

	await rm(distDir, { recursive: true, force: true });
	await cp(ascopeLiteStatic, distDir, { recursive: true });
	await resolveSymlinksInDist();
}

async function runPostinstallForLite(): Promise<void> {
	// AdvantageScope's upstream `postinstall` runs five steps. The last
	// (`npm run download-owlet`) downloads ~7 platform binaries used by the
	// desktop OCR/AprilTag tooling and is not needed for AS Lite. The docs
	// workspace install is also unused. Run only the steps Lite's compile
	// and asset staging actually depend on.
	console.log("Running Lite-only postinstall steps (skipping owlet, docs)...");
	// getLicenses populates ThirdPartyLicenses.txt referenced by the bundle.
	await run("node", ["getLicenses.mjs"], { cwd: ascopeRoot }).catch((error) => {
		console.warn(
			`getLicenses.mjs failed (non-fatal): ${error instanceof Error ? error.message : error}`,
		);
	});
	// tesseract language data is referenced by Lite's optional OCR features;
	// failure is non-fatal because Lite's NT4 view does not need OCR.
	await run("node", ["tesseractLangDownload.mjs"], { cwd: ascopeRoot }).catch(
		(error) => {
			console.warn(
				`tesseractLangDownload.mjs failed (non-fatal): ${error instanceof Error ? error.message : error}`,
			);
		},
	);
	// bundleLiteAssets stages lite/static, which the build script copies into
	// dist/advantagescope. This step is required.
	await run("node", ["bundleLiteAssets.mjs"], { cwd: ascopeRoot });
}

async function main(): Promise<void> {
	await ensureSubmodule();
	await applyAdvantageScopePatches();
	const emsdkRoot = await ensureEmscripten();

	console.log(`Building AdvantageScope Lite from ${ascopeRoot}`);
	if (Bun.env.ASCOPE_SKIP_NPM_INSTALL === "1") {
		console.log("Skipping npm install because ASCOPE_SKIP_NPM_INSTALL=1.");
	} else {
		// --ignore-scripts skips the upstream postinstall (which downloads owlet
		// binaries we don't need for AS Lite). We then run only the Lite-relevant
		// postinstall steps explicitly.
		await run(npmCommand, ["install", "--ignore-scripts"], { cwd: ascopeRoot });
		await runPostinstallForLite();
	}
	await run(npmCommand, ["run", "compile"], {
		cwd: ascopeRoot,
		env: { ...Bun.env, ASCOPE_DISTRIBUTION: "LITE" },
	});
	if (Bun.env.ASCOPE_SKIP_WASM === "1") {
		console.log("Skipping wasm compile because ASCOPE_SKIP_WASM=1.");
	} else {
		await run(npmCommand, ["run", "wasm:compile"], {
			cwd: ascopeRoot,
			env: envWithEmsdk(emsdkRoot),
		});
	}
	await stageBundle();
	console.log(`\nAdvantageScope Lite staged at ${distDir}`);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
