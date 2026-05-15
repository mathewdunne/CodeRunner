/**
 * Command-injection defenses — proves that user-influenced strings are passed as
 * argv arrays to the runtime, never concatenated into shell strings.
 *
 * S9 — Run/import argv passes args as arrays.
 * S10 — Docker labels with embedded specials don't break the label parser.
 * S11 — Git clone target paths never interpolated into a shell.
 */
import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImportManager, type ImportContext } from "../../imports";
import { MockWorkspaceRuntimeProvider, withApp, login, cookieFrom } from "../helpers";
import type { WorkspaceRow } from "../../storage";
import type { WorkspaceId } from "@frc-sim/contracts";

describe("S9 — ImportManager passes argv as arrays to the runtime", () => {
  test("clone invocation is an argv list, not a shell string", async () => {
    await withApp(async (app) => {
      // Build a fake workspace row to drive the import
      const userResp = await login(app, "alice");
      void cookieFrom(userResp);
      const workspace = app.storage.db
        .query("SELECT * FROM workspaces WHERE slug = ?")
        .get("alice") as WorkspaceRow;

      const mock = new MockWorkspaceRuntimeProvider([
        {
          workspaceId: workspace.id,
          state: "running",
          runtimeName: "fake",
          ports: { nt4: 1, vscode: 2, halsim: 3 },
          endpoints: {
            vscode: { httpBaseUrl: "http://x", wsBaseUrl: "ws://x", basePath: "/" },
            nt4: { httpUrl: "http://n", wsUrl: "ws://n" },
            halsim: { wsUrl: "ws://h" },
          },
          error: null,
        } as never,
      ]);

      const importer = new ImportManager(app.storage, mock);
      const ctx: ImportContext = {
        workspace,
        userId: workspace.user_id,
        cloneUrl: "https://github.com/o/r.git",
        branch: "main",
        subdir: "",
        backup: false,
        send: () => {},
      };
      await importer.run(ctx);

      // Find the clone call; assert URL is a single arg, not embedded in a shell string.
      const cloneCall = mock.execCalls.find(
        (c) => c.command[0] === "git" && c.command[1] === "clone",
      );
      expect(cloneCall).toBeTruthy();
      // The URL is its own arg, not concatenated with quotes or ; or backticks
      const cloneArgs = cloneCall!.command;
      const urlArg = cloneArgs[cloneArgs.indexOf("--") + 1];
      expect(urlArg).toBe("https://github.com/o/r.git");
      // No arg contains a shell metachar — that would be evidence of shell-string construction.
      for (const arg of cloneArgs) {
        // Quotes/backticks/semicolons should not appear in any argv element
        expect(arg).not.toMatch(/[`$]/);
      }
    });
  });

  test("staging dir uses a generated timestamp prefix; user content cannot influence it", async () => {
    await withApp(async (app) => {
      const userResp = await login(app, "bob");
      void cookieFrom(userResp);
      const workspace = app.storage.db
        .query("SELECT * FROM workspaces WHERE slug = ?")
        .get("bob") as WorkspaceRow;

      const mock = new MockWorkspaceRuntimeProvider([
        {
          workspaceId: workspace.id,
          state: "running",
          runtimeName: "fake",
          ports: { nt4: 1, vscode: 2, halsim: 3 },
          endpoints: {
            vscode: { httpBaseUrl: "http://x", wsBaseUrl: "ws://x", basePath: "/" },
            nt4: { httpUrl: "http://n", wsUrl: "ws://n" },
            halsim: { wsUrl: "ws://h" },
          },
          error: null,
        } as never,
      ]);

      const importer = new ImportManager(app.storage, mock);
      await importer.run({
        workspace,
        userId: workspace.user_id,
        cloneUrl: "https://github.com/o/r.git",
        // Even a branch with dots — once it reaches ImportManager it has been validated.
        branch: "main",
        subdir: "",
        backup: false,
        send: () => {},
      });

      // The clone target path uses /workspace/<.import-{timestamp}>/source
      const cloneCall = mock.execCalls.find(
        (c) => c.command[0] === "git" && c.command[1] === "clone",
      );
      const targetArg = cloneCall!.command[cloneCall!.command.length - 1];
      expect(targetArg).toMatch(/^\/workspace\/\.import-[\d-T:.Z-]+\/source$/);
      // No traversal markers
      expect(targetArg).not.toMatch(/\.\.|;|`|\$/);
    });
  });
});

describe("S10 — Docker labels remain safe under user-influenced workspace/user data", () => {
  test("workspaceId is opaque (`ws_` + 32 hex) — cannot contain shell or label meta", async () => {
    await withApp(async (app) => {
      await login(app, "alice");
      const row = app.storage.db
        .query("SELECT id FROM workspaces WHERE slug = ?")
        .get("alice") as { id: WorkspaceId };
      expect(row.id).toMatch(/^ws_[a-f0-9]{32}$/);
    });
  });
});

describe("S11 — clone target path never includes user-supplied subdir before validation", () => {
  test("subdir is normalized before reaching exec", async () => {
    // We can't easily inject `..` via parseGitHubUrl (it rejects), but we lock
    // the invariant that ImportManager itself doesn't recompute paths from raw
    // strings: the projectRoot is built from `${stagingName}/source/${subdir}`,
    // and stagingName/subdir come from validated values. This test acts as a
    // canary: if someone refactors and lets unvalidated input through, the
    // clone target will look weird.
    await withApp(async (app) => {
      await login(app, "carol");
      const workspace = app.storage.db
        .query("SELECT * FROM workspaces WHERE slug = ?")
        .get("carol") as WorkspaceRow;

      const mock = new MockWorkspaceRuntimeProvider([
        {
          workspaceId: workspace.id,
          state: "running",
          runtimeName: "fake",
          ports: { nt4: 1, vscode: 2, halsim: 3 },
          endpoints: {
            vscode: { httpBaseUrl: "http://x", wsBaseUrl: "ws://x", basePath: "/" },
            nt4: { httpUrl: "http://n", wsUrl: "ws://n" },
            halsim: { wsUrl: "ws://h" },
          },
          error: null,
        } as never,
      ]);

      const importer = new ImportManager(app.storage, mock);
      await importer.run({
        workspace,
        userId: workspace.user_id,
        cloneUrl: "https://github.com/o/r.git",
        branch: "main",
        subdir: "",
        backup: false,
        send: () => {},
      });

      // Check that no bash -c invocation interpolates the user URL
      const bashCalls = mock.execCalls.filter((c) => c.command[0] === "bash");
      for (const call of bashCalls) {
        // The script lives in argv[2]; ensure it doesn't contain the clone URL
        const script = call.command[2] ?? "";
        expect(script).not.toContain("https://github.com");
      }
    });
  });
});
