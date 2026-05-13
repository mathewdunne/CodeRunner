import { expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type ControlApp, type ControlAppOptions } from "../app";
import type { DockerCommandResult, DockerRunner } from "../containers";
import type { RunCommandFactory } from "../runs";
import type { WorkspaceRow } from "../storage";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function createTemplate(root: string): Promise<string> {
  const templateDir = join(root, "template");
  await mkdir(join(templateDir, "src", "main", "java", "frc", "robot"), { recursive: true });
  await mkdir(join(templateDir, ".wpilib"), { recursive: true });
  await mkdir(join(templateDir, "gradle", "wrapper"), { recursive: true });
  await writeFile(join(templateDir, "build.gradle"), "plugins {}\n", "utf8");
  await writeFile(join(templateDir, "src", "main", "java", "frc", "robot", "Robot.java"), "package frc.robot;\n", "utf8");
  await writeFile(join(templateDir, ".wpilib", "wpilib_preferences.json"), "{}\n", "utf8");
  await writeFile(join(templateDir, "gradle", "wrapper", "gradle-wrapper.jar"), "hidden\n", "utf8");
  return templateDir;
}

export async function createWebDist(root: string): Promise<string> {
  const webDistDir = join(root, "web-dist");
  await mkdir(join(webDistDir, "assets"), { recursive: true });
  await writeFile(
    join(webDistDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body>V2 test shell</body></html>',
    "utf8",
  );
  await writeFile(join(webDistDir, "assets", "app.js"), "console.log('v2 shell');\n", "utf8");
  await writeFile(join(webDistDir, "coderunner-icon.png"), "fake png\n", "utf8");
  return webDistDir;
}

export async function createAdvantageScopeDist(root: string): Promise<string> {
  const ascopeDistDir = join(root, "ascope-dist");
  await mkdir(join(ascopeDistDir, "bundles"), { recursive: true });
  await mkdir(join(ascopeDistDir, "bundledAssets", "Robot_Test"), { recursive: true });
  await mkdir(join(ascopeDistDir, "www", "textures"), { recursive: true });
  await writeFile(
    join(ascopeDistDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="bundles/main.js"></script></head><body>AS Lite</body></html>',
    "utf8",
  );
  await writeFile(join(ascopeDistDir, "bundles", "main.js"), "console.log('ascope main');\n", "utf8");
  await writeFile(join(ascopeDistDir, "bundles", "hub.js"), "console.log('ascope hub');\n", "utf8");
  await writeFile(join(ascopeDistDir, "bundledAssets", "Robot_Test", "config.json"), "{\"name\":\"Robot_Test\"}\n", "utf8");
  await writeFile(join(ascopeDistDir, "www", "textures", "example.png"), "fake png\n", "utf8");
  return ascopeDistDir;
}

export async function withApp<T>(
  fn: (app: ControlApp, root: string) => Promise<T>,
  options: Partial<ControlAppOptions> = {},
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "frc-v2-control-"));
  const templateDir = await createTemplate(root);
  const webDistDir = await createWebDist(root);
  const advantageScopeDistDir = await createAdvantageScopeDist(root);
  const app = await createApp({
    dataDir: join(root, "data"),
    templateDir,
    webDistDir,
    advantageScopeDistDir,
    sessionSecret: "test-session-secret",
    containerAutoStart: false,
    portAvailable: options.dockerRunner ? async () => true : undefined,
    ...options,
  });

  try {
    return await fn(app, root);
  } finally {
    app.close();
    await rm(root, { recursive: true, force: true });
  }
}

type FakeContainerPort = {
  hostPort: number;
  containerPort: number;
  hostIp: string;
};

type FakeContainer = {
  name: string;
  running: boolean;
  labels: Record<string, string>;
  ports: FakeContainerPort[];
};

export function ok(stdout = ""): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function missing(message = "missing"): DockerCommandResult {
  return { exitCode: 1, stdout: "", stderr: message };
}

export function dockerInspect(container: FakeContainer): unknown {
  const portsMap: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
  for (const p of container.ports) {
    const key = `${p.containerPort}/tcp`;
    if (!portsMap[key]) {
      portsMap[key] = [];
    }
    portsMap[key].push({ HostIp: p.hostIp, HostPort: String(p.hostPort) });
  }
  return {
    Name: `/${container.name}`,
    State: {
      Running: container.running,
      Status: container.running ? "running" : "exited",
    },
    Config: {
      Labels: container.labels,
    },
    NetworkSettings: {
      Ports: portsMap,
    },
  };
}

export function createFakeDocker(options: {
  failRunPortsOnce?: number[];
  onRun?: (name: string, ports: FakeContainerPort[]) => void;
} = {}) {
  const containers = new Map<string, FakeContainer>();
  const calls: string[][] = [];
  const failRunPortsOnce = new Set(options.failRunPortsOnce ?? []);

  const runner: DockerRunner = async (args) => {
    calls.push([...args]);

    if (args[0] === "image" && args[1] === "inspect") {
      return ok(JSON.stringify([{ Id: "fake-image" }]));
    }

    if (args[0] === "container" && args[1] === "inspect") {
      const container = containers.get(args[2] ?? "");
      return container ? ok(JSON.stringify([dockerInspect(container)])) : missing("No such container");
    }

    if (args[0] === "container" && args[1] === "ls") {
      const workspaceFilter = args.find((arg) => arg.startsWith("label=frc-sim.workspace="));
      const workspaceId = workspaceFilter?.slice("label=frc-sim.workspace=".length);
      const roleFilter = args.find((arg) => arg.startsWith("label=frc-sim.role="));
      const roleValue = roleFilter?.slice("label=frc-sim.role=".length);
      const versionFilter = args.find((arg) => arg.startsWith("label=frc-sim.version="));
      const versionValue = versionFilter?.slice("label=frc-sim.version=".length);
      const statusFilter = args.find((arg) => arg.startsWith("status="));
      const statusValue = statusFilter?.slice("status=".length);
      const names = [...containers.values()]
        .filter((container) => {
          if (workspaceId && container.labels["frc-sim.workspace"] !== workspaceId) {
            return false;
          }
          if (roleValue && container.labels["frc-sim.role"] !== roleValue) {
            return false;
          }
          if (versionValue && container.labels["frc-sim.version"] !== versionValue) {
            return false;
          }
          if (statusValue === "exited" && container.running) {
            return false;
          }
          if (statusValue === "running" && !container.running) {
            return false;
          }
          return true;
        })
        .map((container) => container.name);
      return ok(`${names.join("\n")}${names.length ? "\n" : ""}`);
    }

    if (args[0] === "run") {
      const name = args[args.indexOf("--name") + 1] ?? "";
      // Parse all -p flags for dual-port support
      const parsedPorts: FakeContainerPort[] = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "-p") {
          const mapping = args[i + 1] ?? "";
          const portMatch = /^([\d.]+):(\d+):(\d+)$/u.exec(mapping);
          if (portMatch) {
            parsedPorts.push({
              hostIp: portMatch[1]!,
              hostPort: Number(portMatch[2]),
              containerPort: Number(portMatch[3]),
            });
          }
        }
      }
      // Check if any port should trigger a failure
      for (const p of parsedPorts) {
        if (failRunPortsOnce.has(p.hostPort)) {
          failRunPortsOnce.delete(p.hostPort);
          return missing(`Bind for ${p.hostIp}:${p.hostPort} failed: port is already allocated`);
        }
      }
      const labels: Record<string, string> = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, value] = (args[index + 1] ?? "").split("=");
          if (key && value) {
            labels[key] = value;
          }
        }
      }
      containers.set(name, {
        name,
        running: true,
        labels,
        ports: parsedPorts,
      });
      options.onRun?.(name, parsedPorts);
      return ok("fake-container-id\n");
    }

    if (args[0] === "start") {
      const container = containers.get(args[1] ?? "");
      if (!container) {
        return missing("No such container");
      }
      container.running = true;
      return ok(`${container.name}\n`);
    }

    if (args[0] === "rm" && args[1] === "-f") {
      containers.delete(args[2] ?? "");
      return ok();
    }

    if (args[0] === "rm" && args[1] && args[1] !== "-f") {
      containers.delete(args[1]);
      return ok();
    }

    if (args[0] === "stop") {
      const container = containers.get(args[1] ?? "");
      if (!container) {
        return missing("No such container");
      }
      container.running = false;
      return ok(`${container.name}\n`);
    }

    return missing(`unhandled docker args: ${args.join(" ")}`);
  };

  return { runner, containers, calls };
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition.");
}

/** HMAC-SHA256 sign a session token for Better Auth cookies. */
async function signToken(token: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${token}.${encodeURIComponent(signature)}`;
}

/** Better Auth generates random 32-char alphanumeric tokens, not UUIDs. */
function randomToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

/**
 * Simulate an OAuth login by directly inserting Better Auth records.
 * Returns a fake Response whose set-cookie header carries the signed session token,
 * keeping the existing `cookieFrom()` helper working unchanged.
 */
export async function login(
  app: ControlApp,
  displayName: string,
  options: { role?: "student" | "admin"; email?: string } = {},
): Promise<Response> {
  const db = app.storage.db;
  const secret = app.storage.config.sessionSecret;
  const email = (options.email ?? `${displayName.toLowerCase()}@test.local`).toLowerCase();
  const role = options.role ?? "student";
  const slug = displayName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // If user already exists (same email → same display name), create a new session
  const existing = db.query("SELECT id, slug FROM user WHERE email = ?").get(email) as {
    id: string;
    slug: string;
  } | null;
  if (existing) {
    if (options.role) {
      db.query("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?").run(options.role, now, existing.id);
    }
    const sessionToken = randomToken();
    const signedToken = await signToken(sessionToken, secret);
    db.query(
      "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomToken(), expiresAt, sessionToken, now, now, existing.id);
    return new Response(null, {
      status: 303,
      headers: new Headers([
        ["set-cookie", `frc_session=${signedToken}; Path=/; HttpOnly`],
        ["location", `/u/${existing.slug}/`],
      ]),
    });
  }

  // New user — create user, session, and workspace
  const userId = randomToken();
  const sessionToken = randomToken();
  const signedToken = await signToken(sessionToken, secret);
  db.query(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, role, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(userId, displayName, email, 0, now, now, role, slug);
  db.query(
    "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(randomToken(), expiresAt, sessionToken, now, now, userId);
  await app.storage.ensureWorkspaceForUser(userId, slug);

  return new Response(null, {
    status: 303,
    headers: new Headers([
      ["set-cookie", `frc_session=${signedToken}; Path=/; HttpOnly`],
      ["location", `/u/${slug}/`],
    ]),
  });
}

export function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie?.split(";")[0] ?? "";
}

export function workspaceProjectPath(app: ControlApp, slug: string): string {
  const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as {
    project_path: string;
  } | null;
  expect(workspace).toBeTruthy();
  return workspace?.project_path ?? "";
}

export function workspaceBySlug(app: ControlApp, slug: string) {
  const workspace = app.storage.db.query("SELECT * FROM workspaces WHERE slug = ?").get(slug) as WorkspaceRow | null;
  expect(workspace).toBeTruthy();
  return workspace!;
}
