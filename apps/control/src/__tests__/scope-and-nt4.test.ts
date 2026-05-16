import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type ControlAppOptions } from "../app";
import type { DockerRunner } from "../containers";
import type { RunCommandFactory } from "../runs";
import {
  cookieFrom,
  createFakeDocker,
  createTemplate,
  createWebDist,
  exists,
  login,
  missing,
  waitFor,
  withApp,
  workspaceBySlug,
  workspaceProjectPath,
} from "./helpers";

describe("AdvantageScope Lite and NT4 routing", () => {
  test("serves AdvantageScope Lite under /scope with assets manifest and www redirect", async () => {
    await withApp(async (app) => {
      const index = await app.fetch(new Request("http://localhost/scope/"));
      expect(index.status).toBe(200);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("AS Lite");

      const main = await app.fetch(new Request("http://localhost/scope/bundles/main.js"));
      expect(main.status).toBe(200);
      expect(main.headers.get("content-type")).toContain("text/javascript");
      expect(await main.text()).toContain("ascope main");

      const manifest = await app.fetch(new Request("http://localhost/scope/assets"));
      expect(manifest.status).toBe(200);
      expect(await manifest.json()).toMatchObject({
        "Robot_Test/config.json": { name: "Robot_Test" },
      });

      const asset = await app.fetch(new Request("http://localhost/scope/assets/Robot_Test/config.json"));
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("Robot_Test");

      const redirect = await app.fetch(new Request("http://localhost/scope/www/www/textures/example.png"));
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/scope/www/textures/example.png");
    });
  });

  test("proxies authenticated sim alive checks to the workspace sim port", async () => {
    const fakeDocker = createFakeDocker();
    const upstreamFetch: ControlAppOptions["upstreamFetch"] = async () => new Response("nt4 alive\n");

    await withApp(
      async (app) => {
        const aliceLogin = await login(app, "alice");
        const aliceCookie = cookieFrom(aliceLogin);
        const bobLogin = await login(app, "bob");
        const bobCookie = cookieFrom(bobLogin);

        const alive = await app.fetch(
          new Request("http://localhost/u/alice/sim/alive", {
            headers: { cookie: aliceCookie },
          }),
        );
        expect(alive.status).toBe(200);
        expect(await alive.text()).toContain("ok");

        const bobReadsAlice = await app.fetch(
          new Request("http://localhost/u/alice/sim/alive", {
            headers: { cookie: bobCookie },
          }),
        );
        expect(bobReadsAlice.status).toBe(403);
      },
      {
        dockerRunner: fakeDocker.runner,
        upstreamFetch,
        codeImage: "coderunner-workspace:test",
        simPortRange: { start: 25910, end: 25910 },
        vscodePortRange: { start: 33100, end: 33100 },
      },
    );
  });
});
