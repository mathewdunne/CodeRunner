/**
 * Property tests for `parseGitHubUrl` and friends.
 *
 * P1 — for any string input, the validator either returns a normalized URL
 *      or rejects with a typed error. Never throws an unexpected error type,
 *      never returns NaN/undefined/garbage.
 * P2 — idempotence: any accepted URL re-validates to the same accepted form.
 * P3 — URLs containing `..`, `\0`, control chars, or non-HTTPS scheme are rejected.
 */
import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  parseGitHubUrl,
  validateBranch,
  validateSubdir,
  ImportError,
} from "../../imports";

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS ?? 200);

describe("parseGitHubUrl — properties", () => {
  test("P1 never throws non-ImportError", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        try {
          parseGitHubUrl(raw);
        } catch (err) {
          if (!(err instanceof ImportError)) {
            throw new Error(`unexpected error type: ${(err as Error)?.constructor?.name}: ${String(err)}`);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("P2 idempotence: parsed cloneUrl re-parses to the same cloneUrl", () => {
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.stringMatching(/^[A-Za-z0-9_.-]{1,20}$/),
            fc.stringMatching(/^[A-Za-z0-9_.-]{1,20}$/),
          )
          .filter(([owner, repo]) => !owner.startsWith(".") && !repo.startsWith(".")),
        ([owner, repo]) => {
          const url = `https://github.com/${owner}/${repo}`;
          const first = parseGitHubUrl(url);
          const second = parseGitHubUrl(first.cloneUrl);
          expect(second.cloneUrl).toBe(first.cloneUrl);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("P3 rejects non-HTTPS schemes", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "ftp", "file", "javascript", "data"),
        (scheme) => {
          expect(() => parseGitHubUrl(`${scheme}://github.com/o/r`)).toThrow();
        },
      ),
      { numRuns: 50 },
    );
  });

  test("P3 rejects non-github hosts even with looks-like-github path", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("gitlab.com", "evil.com", "github.com.evil.com", "127.0.0.1", "localhost"),
        (host) => {
          try {
            parseGitHubUrl(`https://${host}/owner/repo`);
            throw new Error(`accepted bad host: ${host}`);
          } catch (err) {
            expect(err).toBeInstanceOf(ImportError);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("validateBranch — properties", () => {
  test("P1 never throws non-ImportError", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        try {
          validateBranch(raw);
        } catch (err) {
          if (!(err instanceof ImportError)) {
            throw err;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("accepts ordinary branch names", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,30}$/), (branch) => {
        validateBranch(branch); // should not throw
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("rejects branches starting with `-` (could be parsed as a flag)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^-[A-Za-z0-9]{1,20}$/), (branch) => {
        expect(() => validateBranch(branch)).toThrow();
      }),
      { numRuns: 50 },
    );
  });

  test("rejects branches with shell-meta or whitespace characters", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(";", "&", "|", "$", "`", "\n", "\r", "\t", " ", "\\", "<", ">"),
        (bad) => {
          expect(() => validateBranch(`main${bad}rm`)).toThrow();
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("validateSubdir — properties", () => {
  test("P1 never throws non-ImportError", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        try {
          validateSubdir(raw);
        } catch (err) {
          if (!(err instanceof ImportError)) {
            throw err;
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("rejects absolute paths", () => {
    expect(() => validateSubdir("/etc/passwd")).toThrow();
  });

  test("rejects `..` traversal in any position", () => {
    for (const sub of ["..", "a/..", "../a", "a/../b", "..\\evil"]) {
      expect(() => validateSubdir(sub)).toThrow();
    }
  });
});
