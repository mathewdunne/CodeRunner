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

describe("editor proxy", () => {
  test("unauthenticated GET /u/<slug>/vscode/ returns redirect to /", async () => {
    await withApp(async (app) => {
      // Create a user so the workspace exists
      await login(app, "alice");

      // Request without cookie
      const response = await app.fetch(
        new Request("http://localhost/u/alice/vscode/", { method: "GET" }),
      );

      // page kind → 303 redirect to /
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    });
  });

  test("cross-workspace GET /u/<other>/vscode/ returns 403", async () => {
    await withApp(async (app) => {
      const aliceResponse = await login(app, "alice");
      const aliceCookie = cookieFrom(aliceResponse);

      // Create bob workspace
      await login(app, "bob");

      // Alice tries to access bob's vscode
      const response = await app.fetch(
        new Request("http://localhost/u/bob/vscode/", {
          method: "GET",
          headers: { cookie: aliceCookie },
        }),
      );

      expect(response.status).toBe(403);
    });
  });

  test("authenticated GET /u/<slug>/vscode/ returns an error when the image is unavailable", async () => {
    const dockerRunner: DockerRunner = async () => missing("No such image");

    await withApp(
      async (app) => {
        const aliceResponse = await login(app, "alice");
        const aliceCookie = cookieFrom(aliceResponse);

        const response = await app.fetch(
          new Request("http://localhost/u/alice/vscode/", {
            method: "GET",
            headers: { cookie: aliceCookie },
          }),
        );

        expect(response.status).toBe(503);
        expect(await response.text()).toContain("CODE image");
      },
      { dockerRunner },
    );
  });

  test("authenticated GET /u/<slug>/vscode/ proxies to upstream when code container runs", async () => {
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                return new Response(`upstream hit: ${url.pathname}`, {
                  headers: {
                    "content-type": "text/plain",
                    "x-upstream-marker": "openvscode-test",
                  },
                });
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/?folder=/workspace/project", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain("upstream hit: /u/alice/vscode/");
          expect(response.headers.get("x-upstream-marker")).toBe("openvscode-test");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25920, end: 25920 },
          vscodePortRange: { start: 33200, end: 33200 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("authenticated GET /u/<slug>/vscode/ waits for upstream readiness", async () => {
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          setTimeout(() => {
            upstreamServers.push(
              Bun.serve({
                port: vscodePort.hostPort,
                hostname: "127.0.0.1",
                fetch() {
                  return new Response("delayed editor ready", {
                    headers: { "content-type": "text/plain" },
                  });
                },
              }),
            );
          }, 150);
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);
          const startedAt = Date.now();

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(response.status).toBe(200);
          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
          expect(await response.text()).toBe("delayed editor ready");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25924, end: 25924 },
          vscodePortRange: { start: 33204, end: 33204 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("hop-by-hop headers are stripped from proxy requests", async () => {
    let receivedHeaders: Record<string, string> = {};
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                receivedHeaders = {};
                request.headers.forEach((value, key) => {
                  receivedHeaders[key] = value;
                });
                return new Response("ok", {
                  headers: {
                    "content-type": "text/plain",
                    "connection": "keep-alive",
                    "keep-alive": "timeout=5",
                    "transfer-encoding": "chunked",
                    "x-real-header": "should-pass",
                  },
                });
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          const response = await app.fetch(
            new Request("http://localhost/u/alice/vscode/", {
              method: "GET",
              headers: {
                cookie: aliceCookie,
                connection: "keep-alive, x-custom-hop",
                "keep-alive": "timeout=5",
                "proxy-authorization": "Basic abc",
                "x-custom-hop": "should-be-stripped",
                "x-normal-header": "should-pass-through",
              },
            }),
          );

          expect(response.status).toBe(200);

          expect(receivedHeaders["proxy-authorization"]).toBeUndefined();
          expect(receivedHeaders["x-custom-hop"]).toBeUndefined();
          expect(receivedHeaders["x-normal-header"]).toBe("should-pass-through");

          expect(response.headers.get("connection")).toBeNull();
          expect(response.headers.get("keep-alive")).toBeNull();
          expect(response.headers.get("transfer-encoding")).toBeNull();
          expect(response.headers.get("x-real-header")).toBe("should-pass");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25921, end: 25921 },
          vscodePortRange: { start: 33201, end: 33201 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("vscode proxy passes query strings through", async () => {
    let receivedPath = "";
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                receivedPath = url.pathname + url.search;
                return new Response("ok");
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          await app.fetch(
            new Request("http://localhost/u/alice/vscode/?folder=/workspace/project&some=extra", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(receivedPath).toBe("/u/alice/vscode/?folder=/workspace/project&some=extra");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25922, end: 25922 },
          vscodePortRange: { start: 33202, end: 33202 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });

  test("vscode proxy handles sub-paths correctly", async () => {
    let receivedPath = "";
    const upstreamServers: Array<ReturnType<typeof Bun.serve>> = [];
    const fakeDocker = createFakeDocker({
      onRun(_name, ports) {
        const vscodePort = ports.find((p) => p.containerPort === 3000);
        if (vscodePort) {
          upstreamServers.push(
            Bun.serve({
              port: vscodePort.hostPort,
              hostname: "127.0.0.1",
              fetch(request) {
                const url = new URL(request.url);
                receivedPath = url.pathname;
                return new Response("ok");
              },
            }),
          );
        }
      },
    });

    try {
      await withApp(
        async (app) => {
          const aliceResponse = await login(app, "alice");
          const aliceCookie = cookieFrom(aliceResponse);

          await app.fetch(
            new Request("http://localhost/u/alice/vscode/static/workbench.js", {
              method: "GET",
              headers: { cookie: aliceCookie },
            }),
          );

          expect(receivedPath).toBe("/u/alice/vscode/static/workbench.js");
        },
        {
          dockerRunner: fakeDocker.runner,
          codeImage: "frc-code:test",
          simPortRange: { start: 25923, end: 25923 },
          vscodePortRange: { start: 33203, end: 33203 },
        },
      );
    } finally {
      for (const server of upstreamServers) {
        server.stop(true);
      }
    }
  });
});

describe("hop-by-hop header stripping", () => {
  test("removes standard hop-by-hop headers", async () => {
    const { stripHopByHopHeaders } = await import("../app");

    const source = new Headers({
      "connection": "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic abc",
      "te": "gzip",
      "trailer": "Expires",
      "transfer-encoding": "chunked",
      "upgrade": "websocket",
      "content-type": "text/html",
      "x-custom": "value",
    });

    const result = stripHopByHopHeaders(source);

    expect(result.get("connection")).toBeNull();
    expect(result.get("keep-alive")).toBeNull();
    expect(result.get("proxy-authenticate")).toBeNull();
    expect(result.get("proxy-authorization")).toBeNull();
    expect(result.get("te")).toBeNull();
    expect(result.get("trailer")).toBeNull();
    expect(result.get("transfer-encoding")).toBeNull();
    expect(result.get("upgrade")).toBeNull();
    expect(result.get("content-type")).toBe("text/html");
    expect(result.get("x-custom")).toBe("value");
  });

  test("removes headers listed in Connection header", async () => {
    const { stripHopByHopHeaders } = await import("../app");

    const source = new Headers({
      "connection": "keep-alive, x-my-hop",
      "x-my-hop": "should-be-stripped",
      "x-normal": "should-remain",
    });

    const result = stripHopByHopHeaders(source);

    expect(result.get("connection")).toBeNull();
    expect(result.get("x-my-hop")).toBeNull();
    expect(result.get("x-normal")).toBe("should-remain");
  });

  test("handles empty headers", async () => {
    const { stripHopByHopHeaders } = await import("../app");

    const source = new Headers();
    const result = stripHopByHopHeaders(source);
    expect([...result.keys()].length).toBe(0);
  });
});
