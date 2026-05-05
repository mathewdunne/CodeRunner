import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const ascopeRoot = resolve(repoRoot, "vendor", "AdvantageScope");
const patchDir = resolve(repoRoot, "patches", "advantagescope");

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function run(args: string[], allowFailure = false): Promise<CommandResult> {
  const subprocess = Bun.spawn(["git", "-C", ascopeRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (!allowFailure && exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`git -C ${ascopeRoot} ${args.join(" ")} failed: ${detail}`);
  }

  return { exitCode, stdout, stderr };
}

async function patchFiles(): Promise<string[]> {
  const entries = await readdir(patchDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => resolve(patchDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function applyAdvantageScopePatches(): Promise<void> {
  const patches = await patchFiles();
  if (patches.length === 0) {
    throw new Error(`No AdvantageScope patches found in ${patchDir}.`);
  }

  for (const patch of patches) {
    const check = await run(["apply", "--check", patch], true);
    if (check.exitCode === 0) {
      await run(["apply", patch]);
      console.log(`Applied ${patch}`);
      continue;
    }

    const reverseCheck = await run(["apply", "--reverse", "--check", patch], true);
    if (reverseCheck.exitCode === 0) {
      console.log(`Already applied ${patch}`);
      continue;
    }

    const detail = check.stderr.trim() || reverseCheck.stderr.trim() || "patch did not apply cleanly";
    throw new Error(`Unable to apply ${patch}: ${detail}`);
  }
}

if (import.meta.main) {
  try {
    await applyAdvantageScopePatches();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
