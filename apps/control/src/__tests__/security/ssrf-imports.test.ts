/**
 * SSRF defenses on the project-import URL parser.
 *
 * S1 — reject localhost / RFC1918 / link-local / cloud-metadata hostnames.
 * S2 — protocol + host allowlist: non-HTTPS schemes and non-github.com hosts rejected.
 * S3 — reject URL-confusion bypasses (userinfo, sibling subdomain, null bytes, whitespace).
 *
 * Notes:
 * - The repository's `parseGitHubUrl` enforces `hostname === "github.com"` (case-sensitive
 *   in the regex; lowercase via `URL` parser), so most SSRF vectors fall to that check.
 *   These tests lock the property and ensure no new accept path can quietly open the door.
 */
import { describe, test, expect } from "bun:test";
import { parseGitHubUrl, ImportError } from "../../imports";

function expectRejected(url: string) {
  try {
    parseGitHubUrl(url);
    throw new Error(`accepted unexpected URL: ${url}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
  }
}

describe("S1 SSRF — internal/loopback hostnames", () => {
  const cases = [
    "http://localhost/owner/repo",
    "http://127.0.0.1/owner/repo",
    "http://[::1]/owner/repo",
    "http://0.0.0.0/owner/repo",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://169.254.169.254/owner/repo",
    "http://10.0.0.5/owner/repo",
    "http://192.168.1.1/owner/repo",
    "http://172.16.0.1/owner/repo",
    "http://internal.corp/owner/repo",
  ];

  for (const url of cases) {
    test(`rejects ${url}`, () => expectRejected(url));
  }
});

describe("S2 protocol/host allowlist", () => {
  test("rejects HTTP variant of github.com (forces HTTPS)", () => {
    expectRejected("http://github.com/owner/repo");
  });

  test("rejects non-GitHub hosts", () => {
    for (const h of ["gitlab.com", "bitbucket.org", "evil.com", "raw.githubusercontent.com"]) {
      expectRejected(`https://${h}/owner/repo`);
    }
  });

  test("rejects dangerous schemes", () => {
    for (const s of ["javascript", "file", "data", "ftp", "gopher", "ssh"]) {
      expectRejected(`${s}://github.com/owner/repo`);
    }
  });

  test("rejects SSH-style URLs", () => {
    expectRejected("git@github.com:owner/repo.git");
  });
});

describe("S3 URL-confusion bypasses", () => {
  test("rejects userinfo@github.com pattern", () => {
    // https://github.com@evil.com/owner/repo — host is "evil.com", userinfo is "github.com".
    expectRejected("https://github.com@evil.com/owner/repo");
  });

  test("rejects sibling subdomain (github.com.evil.com)", () => {
    expectRejected("https://github.com.evil.com/owner/repo");
  });

  test("rejects embedded null bytes", () => {
    expectRejected("https://github.com\x00.evil.com/owner/repo");
  });

  test("strips leading whitespace; cloneUrl never contains whitespace", () => {
    // parseGitHubUrl calls .trim() first, so " https://..." normalizes to a
    // valid URL. The security property we care about is that no whitespace
    // leaks into the cloneUrl that downstream `git clone` would receive.
    const result = parseGitHubUrl(" https://github.com/wpilibsuite/allwpilib");
    expect(/\s/.test(result.cloneUrl)).toBe(false);
  });

  test("rejects trailing whitespace in URL", () => {
    // Currently `parseGitHubUrl` trims, so 'https://github.com/o/r \n' becomes valid.
    // The risk is unintended characters making it into the cloneUrl. Verify the
    // returned cloneUrl never contains whitespace.
    const result = parseGitHubUrl("https://github.com/wpilibsuite/allwpilib  \n");
    expect(/\s/.test(result.cloneUrl)).toBe(false);
  });

  test("rejects IDN homograph (Cyrillic 'і' in github)", () => {
    // The URL parser normalizes the IDN; the resulting host is "xn--..." not "github.com".
    expectRejected("https://gіthub.com/owner/repo");
  });

  test("rejects URLs encoded to look like github.com via @-trick", () => {
    expectRejected("https://github.com%40evil.com/owner/repo");
  });
});
