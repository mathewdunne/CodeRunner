import { isWorkspaceSlug } from "@frc-sim/contracts";

const port = Number(Bun.env.PORT ?? 4000);

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, service: "control", version: "v1-placeholder" });
    }

    const workspaceMatch = /^\/u\/([^/]+)\/?$/.exec(url.pathname);
    if (workspaceMatch) {
      const workspaceSlug = workspaceMatch[1] ?? "";
      if (!isWorkspaceSlug(workspaceSlug)) {
        return new Response("Invalid workspace slug", { status: 400 });
      }
      return new Response(`FRC Web Simulator V1 placeholder for ${workspaceSlug}`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("FRC Web Simulator V1 control plane placeholder", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`V1 control plane placeholder listening on http://localhost:${server.port}`);
