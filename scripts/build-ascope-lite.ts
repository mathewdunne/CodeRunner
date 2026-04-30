// Build AdvantageScope Lite from the vendored submodule and stage the static
// bundle at dist/advantagescope/. Invoked via `npm run build:ascope`.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ascopeRoot = join(repoRoot, "vendor", "AdvantageScope");
const ascopeLiteStatic = join(ascopeRoot, "lite", "static");
const distDir = join(repoRoot, "dist", "advantagescope");

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

// Default emsdk location for the project author's machine. Override with the
// EMSDK env var if installed elsewhere. README documents the install steps.
const DEFAULT_EMSDK = "D:/Documents/GitHub/emsdk";

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): void {
  const display = `${cmd} ${args.join(" ")}`;
  console.log(`\n→ ${display}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    // Required on Windows so npm.cmd / npx.cmd resolve. Inputs are hardcoded
    // in this script (not user-supplied), so shell quoting is not a concern.
    shell: isWindows,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${display}`);
  }
}

function ensureSubmodule(): void {
  if (!existsSync(join(ascopeRoot, "package.json"))) {
    throw new Error(
      `vendor/AdvantageScope/package.json not found. Run:\n  git submodule update --init --recursive`,
    );
  }
}

function ensureEmscripten(): { emsdkRoot: string } {
  const emsdkRoot = process.env.EMSDK ?? DEFAULT_EMSDK;
  if (!existsSync(emsdkRoot) || !statSync(emsdkRoot).isDirectory()) {
    throw new Error(
      `emsdk not found at ${emsdkRoot}. Set the EMSDK env var or install emsdk per README.`,
    );
  }
  const emscriptenDir = join(emsdkRoot, "upstream", "emscripten");
  if (!existsSync(emscriptenDir)) {
    throw new Error(
      `emscripten not found at ${emscriptenDir}. Run \`emsdk install 4.0.12 && emsdk activate 4.0.12\` in ${emsdkRoot}.`,
    );
  }
  return { emsdkRoot };
}

function envWithEmsdk(emsdkRoot: string): NodeJS.ProcessEnv {
  const sep = isWindows ? ";" : ":";
  const additions = [emsdkRoot, join(emsdkRoot, "upstream", "emscripten")];
  const existingPath = process.env.PATH ?? process.env.Path ?? "";
  return {
    ...process.env,
    EMSDK: emsdkRoot,
    PATH: [...additions, existingPath].join(sep),
  };
}

function npmInstallSubmodule(): void {
  // Idempotent: npm install is a no-op if node_modules is up to date.
  // AS's postinstall downloads ~50 MB of bundled field/robot assets on first run.
  run(npmCmd, ["install"], { cwd: ascopeRoot });
}

function compileLite(): void {
  run(npmCmd, ["run", "compile"], {
    cwd: ascopeRoot,
    env: { ...process.env, ASCOPE_DISTRIBUTION: "LITE" },
  });
}

function compileWasm(emsdkRoot: string): void {
  run(npmCmd, ["run", "wasm:compile"], {
    cwd: ascopeRoot,
    env: envWithEmsdk(emsdkRoot),
  });
}

// Git supports filesystem symlinks; on Windows without Developer Mode they're
// checked out as plain text files containing the link target. The Lite static
// tree includes such symlinks (e.g. `lite/static/www` → `../../www`) which
// would otherwise leave the dist bundle missing global.css, hub.html, etc.
// We query git directly for tracked symlinks under the Lite static path and
// resolve them by copying the real target into place.
function listGitSymlinksUnder(repoDir: string, prefix: string): string[] {
  const result = spawnSync("git", ["-C", repoDir, "ls-files", "-s", prefix], {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed in ${repoDir}`);
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("120000 "))
    .map((line) => {
      // Format: "<mode> <hash> <stage>\t<path>"
      const tab = line.indexOf("\t");
      return tab >= 0 ? line.slice(tab + 1) : "";
    })
    .filter(Boolean);
}

function resolveSymlinksInDist(): void {
  const symlinks = listGitSymlinksUnder(ascopeRoot, "lite/static");
  for (const repoRel of symlinks) {
    // repoRel is like "lite/static/www" — strip the "lite/static/" prefix to
    // get the path within both the source tree and the dist directory.
    const inStatic = repoRel.replace(/^lite\/static\//, "");
    const placeholder = join(distDir, ...inStatic.split("/"));
    if (!existsSync(placeholder)) continue;
    const linkText = readFileSync(placeholder, "utf8").trim();
    // Resolve relative to the symlink's own directory inside the source tree.
    const sourceLinkDir = dirname(join(ascopeRoot, ...repoRel.split("/")));
    const linkTargetAbs = resolve(sourceLinkDir, ...linkText.split(posix.sep));
    rmSync(placeholder, { force: true });
    if (!existsSync(linkTargetAbs)) {
      console.warn(
        `  ! symlink ${repoRel} → ${linkText} target missing; placeholder removed`,
      );
      continue;
    }
    console.log(`  ↳ resolved ${repoRel} → ${linkText}`);
    cpSync(linkTargetAbs, placeholder, { recursive: true });
  }
}

function stageBundle(): void {
  if (!existsSync(ascopeLiteStatic)) {
    throw new Error(
      `Expected build output at ${ascopeLiteStatic} but the directory does not exist.`,
    );
  }
  rmSync(distDir, { recursive: true, force: true });
  cpSync(ascopeLiteStatic, distDir, { recursive: true });
  resolveSymlinksInDist();
}

function main(): void {
  ensureSubmodule();
  const { emsdkRoot } = ensureEmscripten();

  console.log(`Building AdvantageScope Lite from ${ascopeRoot}`);
  console.log(`Using emsdk at ${emsdkRoot}`);

  npmInstallSubmodule();
  compileLite();
  compileWasm(emsdkRoot);
  stageBundle();

  console.log(`\n✓ AS Lite bundle ready at ${distDir}`);
}

try {
  main();
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
