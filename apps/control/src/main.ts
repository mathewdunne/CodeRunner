import { createApp } from "./app";

const port = Number(Bun.env.PORT ?? 4000);
const app = await createApp();

const server = Bun.serve({
  port,
  fetch: (request, server) => app.fetch(request, server),
  websocket: app.websocket,
});

console.log(`V1 control plane listening on http://localhost:${server.port}`);
