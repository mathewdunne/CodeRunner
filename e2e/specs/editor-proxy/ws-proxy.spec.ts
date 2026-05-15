/**
 * Editor WebSocket proxy through the control plane.
 */
import { test } from "@playwright/test";

test("editor WebSocket connects through proxy", async () => {
  test.fixme(
    true,
    "Browser-driven WS upgrade is the cleanest cover. Awaiting data-testid on the editor iframe " +
      "so the page object can reliably wait for the iframe handshake before asserting.",
  );
});

test("editor WS reconnects cleanly after refresh", async () => {
  test.fixme(true, "Same as T9.1 — needs iframe-load page object hook.");
});
