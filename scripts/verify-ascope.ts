import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../apps/control/src/app";

const repoRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(repoRoot, "dist", "advantagescope");
const ascopeRoot = resolve(repoRoot, "vendor", "AdvantageScope");
const patchDir = resolve(repoRoot, "patches", "advantagescope");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function createTemplate(root: string): Promise<string> {
  const templateDir = join(root, "template");
  await mkdir(join(templateDir, "src", "main", "java", "frc", "robot"), { recursive: true });
  await writeFile(join(templateDir, "build.gradle"), "plugins {}\n", "utf8");
  await writeFile(join(templateDir, "src", "main", "java", "frc", "robot", "Robot.java"), "package frc.robot;\n", "utf8");
  return templateDir;
}

async function runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(["git", "-C", ascopeRoot, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function verifyPatchFiles(): Promise<void> {
  const patches = (await readdir(patchDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => resolve(patchDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
  assert(patches.length > 0, `No AdvantageScope patches found in ${patchDir}.`);

  for (const patch of patches) {
    const check = await runGit(["apply", "--check", patch]);
    if (check.exitCode === 0) {
      continue;
    }

    const reverseCheck = await runGit(["apply", "--reverse", "--check", patch]);
    assert(
      reverseCheck.exitCode === 0,
      `Patch ${patch} is neither cleanly applicable nor already applied: ${check.stderr || reverseCheck.stderr}`,
    );
  }
}

async function verifyStagedBundle(): Promise<void> {
  assert(await exists(resolve(distDir, "index.html")), "dist/advantagescope/index.html is missing. Run bun run build:ascope.");
  assert(
    await exists(resolve(distDir, "bundles", "main.js")),
    "dist/advantagescope/bundles/main.js is missing. Run bun run build:ascope.",
  );
  assert(
    await exists(resolve(distDir, "bundles", "hub.js")),
    "dist/advantagescope/bundles/hub.js is missing. Run bun run build:ascope.",
  );

  const indexHtml = await readFile(resolve(distDir, "index.html"), "utf8");
  assert(!/\b(?:src|href)="\//u.test(indexHtml), "AS Lite index.html contains root-absolute asset references.");

  const mainBundle = await readFile(resolve(distDir, "bundles", "main.js"), "utf8");
  const hubBundle = await readFile(resolve(distDir, "bundles", "hub.js"), "utf8");
  assert(mainBundle.includes("frc-sim:set-nt4-endpoint"), "AS Lite main bundle is missing postMessage config support.");
  assert(mainBundle.includes("frc-sim:nt4-endpoint-ready"), "AS Lite main bundle is missing endpoint acknowledgement.");
  assert(
    mainBundle.includes("did not receive an endpoint configuration"),
    "AS Lite main bundle is missing the embedded-mode endpoint timeout banner.",
  );
  assert(
    mainBundle.includes("frcSimNt4Endpoint=window.frcSimNt4Endpoint"),
    "AS Lite main bundle is not copying the injected endpoint into the hub iframe.",
  );
  assert(hubBundle.includes("frcSimNt4Endpoint"), "AS Lite hub bundle is missing injected NT4 endpoint support.");
  assert(hubBundle.includes("websocketUrl"), "AS Lite hub bundle is missing injected WebSocket URL support.");
  assert(hubBundle.includes("aliveUrl"), "AS Lite hub bundle is missing injected alive URL support.");
}

async function verifyScopeServing(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "frc-ascope-"));
  const templateDir = await createTemplate(root);
  const webDistDir = join(root, "web-dist");
  await mkdir(webDistDir, { recursive: true });
  await writeFile(join(webDistDir, "index.html"), "<!doctype html><html></html>", "utf8");

  const app = await createApp({
    dataDir: join(root, "data"),
    templateDir,
    webDistDir,
    advantageScopeDistDir: distDir,
    containerAutoStart: false,
    sessionSecret: "verify-ascope-session-secret",
  });

  try {
    const index = await app.fetch(new Request("http://localhost/scope/"));
    assert(index.status === 200, `/scope/ returned ${index.status}.`);
    assert((index.headers.get("content-type") ?? "").includes("text/html"), "/scope/ did not serve HTML.");

    const main = await app.fetch(new Request("http://localhost/scope/bundles/main.js"));
    assert(main.status === 200, `/scope/bundles/main.js returned ${main.status}.`);
    assert((main.headers.get("content-type") ?? "").includes("text/javascript"), "main.js content type is wrong.");

    const assets = await app.fetch(new Request("http://localhost/scope/assets"));
    assert(assets.status === 200, `/scope/assets returned ${assets.status}.`);
    const manifest = await assets.json();
    assert(manifest !== null && typeof manifest === "object", "/scope/assets did not return an asset manifest.");

    const redirect = await app.fetch(new Request("http://localhost/scope/www/www/textures/example.png"));
    assert(redirect.status === 302, `/scope/www/www/* redirect returned ${redirect.status}.`);
    assert(
      redirect.headers.get("location") === "/scope/www/textures/example.png",
      "/scope/www/www/* redirect target is wrong.",
    );
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await verifyPatchFiles();
  await verifyStagedBundle();
  await verifyScopeServing();
  console.log("AdvantageScope Lite patch and /scope/ serving smoke passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
