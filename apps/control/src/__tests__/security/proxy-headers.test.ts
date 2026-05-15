/**
 * stripHopByHopHeaders — RFC 7230 § 6.1 compliance, also locks the fix in commit 158bab4.
 */
import { describe, test, expect } from "bun:test";
import { stripHopByHopHeaders } from "../../app";

describe("stripHopByHopHeaders", () => {
  test("removes standard hop-by-hop headers", () => {
    const input = new Headers({
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=5",
      "Proxy-Authenticate": "x",
      "Proxy-Authorization": "y",
      "TE": "trailers",
      "Trailer": "Expires",
      "Transfer-Encoding": "chunked",
      "Upgrade": "websocket",
      "X-Custom": "keep",
    });
    const stripped = stripHopByHopHeaders(input);
    for (const h of [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(stripped.get(h)).toBeNull();
    }
    expect(stripped.get("x-custom")).toBe("keep");
  });

  test("removes connection-listed extras", () => {
    const input = new Headers({
      "Connection": "Upgrade, X-Custom",
      "X-Custom": "drop",
      "X-Keep": "keep",
    });
    const stripped = stripHopByHopHeaders(input);
    expect(stripped.get("x-custom")).toBeNull();
    expect(stripped.get("x-keep")).toBe("keep");
  });

  test("is case-insensitive", () => {
    const input = new Headers({ "CONNECTION": "close", "FOO": "bar" });
    const stripped = stripHopByHopHeaders(input);
    expect(stripped.get("connection")).toBeNull();
    expect(stripped.get("foo")).toBe("bar");
  });

  test("empty Connection header doesn't strip anything else", () => {
    const input = new Headers({ "X-Keep": "keep" });
    const stripped = stripHopByHopHeaders(input);
    expect(stripped.get("x-keep")).toBe("keep");
  });
});
