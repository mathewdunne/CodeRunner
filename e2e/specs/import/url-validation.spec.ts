/**
 * Import URL validation — exercised end-to-end against the import POST endpoint.
 *
 * Anchors S1–S3 SSRF protections at the HTTP layer (the unit tests cover
 * parseGitHubUrl directly).
 */
import { test, expect } from "../../fixtures/app";
import { loginAs, cookieHeader } from "../../fixtures/auth";

const dangerous = [
  "http://127.0.0.1/owner/repo",
  "http://169.254.169.254/latest/meta-data/",
  "https://gitlab.com/owner/repo",
  "ftp://github.com/owner/repo",
  "https://github.com@evil.com/owner/repo",
  "https://github.com.evil.com/owner/repo",
];

for (const url of dangerous) {
  test(`rejects ${url}`, async ({ page, app }) => {
    const session = await loginAs(page, app, { name: "Alice" });
    const resp = await app.fetch(
      new Request(
        `${app.storage.config.baseUrl}/u/${session.user.slug}/api/import`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: cookieHeader(session),
          },
          body: JSON.stringify({ url }),
        },
      ),
    );
    // 4xx (typically 400 Bad Request); never 2xx
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(500);
  });
}
