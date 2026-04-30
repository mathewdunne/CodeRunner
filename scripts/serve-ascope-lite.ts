// Static server for the AS Lite bundle. Plain HTTP only — NT4 is ws://, and a
// page served from https:// would block the WebSocket as mixed content.

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(repoRoot, "dist", "advantagescope");
const bundledAssetsDir = join(distDir, "bundledAssets");

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "127.0.0.1";

if (!existsSync(distDir)) {
  console.error(
    `dist/advantagescope/ not found. Run \`npm run build:ascope\` first.`,
  );
  process.exit(1);
}

// AS Lite calls `fetch("assets")` to get a manifest of every file under
// bundledAssets/, then loads individual assets at `assets/<name>/<file>`.
// The upstream Python server (vendor/AdvantageScope/lite/lite_server.py) does
// the same — we mirror its behavior.
type AssetManifest = Record<string, unknown>;

function buildAssetManifest(): AssetManifest {
  const manifest: AssetManifest = {};
  if (!existsSync(bundledAssetsDir)) return manifest;
  const stack: string[] = [bundledAssetsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const rel = relative(bundledAssetsDir, full).split(sep).join(posix.sep);
      let contents: unknown = null;
      if (entry.name === "config.json") {
        try {
          contents = JSON.parse(readFileSync(full, "utf8"));
        } catch {
          contents = null;
        }
      }
      manifest[rel] = contents;
    }
  }
  return manifest;
}

// Cached at startup — bundledAssets is shipped with the build, not edited
// at runtime. Rebuild the manifest by restarting the server.
const assetManifest = buildAssetManifest();

const app = Fastify({ logger: { level: "info" } });

app.get("/assets", async (_req, reply) => {
  reply.type("application/json");
  return assetManifest;
});

app.get<{ Params: { "*": string } }>("/assets/*", async (req, reply) => {
  const rel = decodeURIComponent(req.params["*"]);
  if (rel.length === 0) {
    reply.type("application/json");
    return assetManifest;
  }
  // Block path traversal — bail if the resolved absolute path escapes the
  // bundled assets directory.
  const target = resolve(bundledAssetsDir, rel);
  if (!target.startsWith(bundledAssetsDir + sep)) {
    return reply.code(400).send({ error: "Bad asset path" });
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return reply.code(404).send({ error: "Asset not found" });
  }
  return reply.sendFile(relative(distDir, target).split(sep).join(posix.sep));
});

await app.register(fastifyStatic, {
  root: distDir,
  index: ["index.html"],
});

try {
  const address = await app.listen({ host, port });
  app.log.info(`AS Lite available at ${address}`);
  app.log.info(`Asset manifest: ${Object.keys(assetManifest).length} entries`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
