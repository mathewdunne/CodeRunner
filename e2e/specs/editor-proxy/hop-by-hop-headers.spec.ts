/**
 * T10.1 — proxy strips hop-by-hop headers when forwarding to the editor.
 *
 * Anchor: commit 158bab4. Drives a real GET through /u/<slug>/vscode/ and
 * asserts the fake-vscode side receives no Connection / Transfer-Encoding /
 * Keep-Alive / Proxy-* headers (those that aren't part of the WS upgrade).
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";
import { seedRuntimeRunning } from "../../fixtures/runtime";

test("HTTP proxy strips hop-by-hop headers", async ({
  page,
  app,
  runtime,
  fakeVscode,
  fakeHalsim,
}) => {
  const session = await loginAs(page, app, { name: "Alice" });
  const workspace = app.storage.findWorkspaceBySlug(session.user.slug as never)!;
  seedRuntimeRunning({ runtime, workspaceId: workspace.id, fakeVscode, fakeHalsim });

  const headers = new Headers({
    cookie: cookieHeader(session),
    Connection: "keep-alive, X-Custom",
    "Keep-Alive": "timeout=5",
    "X-Custom": "should-be-stripped",
    "X-Pass-Through": "should-arrive",
    "Transfer-Encoding": "chunked",
  });
  await app.fetch(
    new Request(`${app.storage.config.baseUrl}/u/${session.user.slug}/vscode/`, { headers }),
  );

  const received = fakeVscode.receivedHeaders();
  expect(received.length).toBeGreaterThan(0);
  const last = received[received.length - 1]!;
  // Hop-by-hop must not arrive at upstream
  expect(last["connection"]).toBeUndefined();
  expect(last["keep-alive"]).toBeUndefined();
  expect(last["transfer-encoding"]).toBeUndefined();
  // Connection-extras list also gets stripped
  expect(last["x-custom"]).toBeUndefined();
  // End-to-end headers passthrough
  expect(last["x-pass-through"]).toBe("should-arrive");
});
