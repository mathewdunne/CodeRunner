import { describe, expect, test } from "bun:test";
import {
  cookieFrom,
  createFakeDocker,
  login,
  withApp,
  workspaceBySlug,
} from "./helpers";
import type { AuditLogEntry } from "../audit";

describe("audit log", () => {
  test("recordAuditEvent writes correct row", async () => {
    await withApp(async (app) => {
      const { recordAuditEvent } = await import("../audit");
      recordAuditEvent(app.storage, {
        actor: { userId: "u1", email: "coach@test.local" },
        action: "user.delete",
        target: { kind: "user", id: "u2" },
        metadata: { reason: "test" },
      });

      const rows = app.storage.db
        .query("SELECT * FROM audit_log")
        .all() as AuditLogEntry[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.actor_email).toBe("coach@test.local");
      expect(rows[0]!.action).toBe("user.delete");
      expect(rows[0]!.target_kind).toBe("user");
      expect(rows[0]!.target_id).toBe("u2");
      expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ reason: "test" });
      expect(rows[0]!.occurred_at).toBeGreaterThan(0);
    });
  });

  test("admin user promote creates audit event", async () => {
    await withApp(async (app) => {
      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);
      await login(app, "student");

      const student = app.storage.db
        .query("SELECT id FROM user WHERE email = ?")
        .get("student@test.local") as { id: string };

      const promoteRes = await app.fetch(
        new Request(`http://localhost/admin/users/${student.id}/promote`, {
          method: "POST",
          headers: { cookie: adminCookie },
        }),
      );
      expect(promoteRes.status).toBe(200);

      const rows = app.storage.db
        .query("SELECT * FROM audit_log WHERE action = 'user.promote'")
        .all() as AuditLogEntry[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.target_kind).toBe("user");
      expect(rows[0]!.target_id).toBe(student.id);
    });
  });

  test("admin user delete creates audit event", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        const adminRes = await login(app, "coach", { role: "admin" });
        const adminCookie = cookieFrom(adminRes);
        await login(app, "student");

        const student = app.storage.db
          .query("SELECT id FROM user WHERE email = ?")
          .get("student@test.local") as { id: string };

        const deleteRes = await app.fetch(
          new Request(`http://localhost/admin/users/${student.id}`, {
            method: "DELETE",
            headers: { cookie: adminCookie },
          }),
        );
        expect(deleteRes.status).toBe(200);

        const rows = app.storage.db
          .query("SELECT * FROM audit_log WHERE action = 'user.delete'")
          .all() as AuditLogEntry[];
        expect(rows.length).toBe(1);
        expect(rows[0]!.target_id).toBe(student.id);
      },
      { dockerRunner: fakeDocker.runner },
    );
  });

  test("admin container stop creates audit event", async () => {
    const fakeDocker = createFakeDocker();
    await withApp(
      async (app) => {
        const adminRes = await login(app, "coach", { role: "admin" });
        const adminCookie = cookieFrom(adminRes);
        const workspace = workspaceBySlug(app, "coach");
        await app.containers.ensureCodeContainer(workspace);

        const stopRes = await app.fetch(
          new Request(`http://localhost/admin/workspaces/${workspace.id}/stop-containers`, {
            method: "POST",
            headers: { cookie: adminCookie },
          }),
        );
        expect(stopRes.status).toBe(200);

        const rows = app.storage.db
          .query("SELECT * FROM audit_log WHERE action = 'container.stop'")
          .all() as AuditLogEntry[];
        expect(rows.length).toBe(1);
        expect(rows[0]!.target_id).toBe(workspace.id);
      },
      {
        dockerRunner: fakeDocker.runner,
        codeImage: "frc-code:test",
        simPortRange: { start: 45700, end: 45710 },
        vscodePortRange: { start: 46700, end: 46710 },
        halsimPortRange: { start: 47700, end: 47710 },
      },
    );
  });

  test("admin cap change creates audit event", async () => {
    await withApp(async (app) => {
      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/config/max-active-containers", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ value: 5 }),
        }),
      );
      expect(res.status).toBe(200);

      const rows = app.storage.db
        .query("SELECT * FROM audit_log WHERE action = 'config.max-active-containers'")
        .all() as AuditLogEntry[];
      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0]!.metadata_json!)).toEqual({ value: 5 });
    });
  });

  test("allowlist add creates audit event", async () => {
    await withApp(async (app) => {
      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/allowlist", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ kind: "email", value: "test@example.com" }),
        }),
      );
      expect(res.status).toBe(200);

      const rows = app.storage.db
        .query("SELECT * FROM audit_log WHERE action = 'allowlist.add'")
        .all() as AuditLogEntry[];
      expect(rows.length).toBe(1);
      expect(rows[0]!.target_id).toBe("test@example.com");
    });
  });

  test("GET /admin/audit-log returns paginated entries", async () => {
    await withApp(async (app) => {
      const { recordAuditEvent } = await import("../audit");

      // Insert some events
      for (let i = 0; i < 5; i++) {
        recordAuditEvent(app.storage, {
          actor: { userId: "u1", email: "coach@test.local" },
          action: `test.action-${i}`,
        });
      }

      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/audit-log?limit=3", {
          headers: { cookie: adminCookie },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; entries: AuditLogEntry[] };
      expect(body.ok).toBe(true);
      expect(body.entries.length).toBe(3);
      // Ordered by id DESC
      expect(body.entries[0]!.id).toBeGreaterThan(body.entries[1]!.id);
    });
  });

  test("GET /admin/audit-log filters by actor email", async () => {
    await withApp(async (app) => {
      const { recordAuditEvent } = await import("../audit");

      recordAuditEvent(app.storage, {
        actor: { userId: "u1", email: "coach@test.local" },
        action: "test.a",
      });
      recordAuditEvent(app.storage, {
        actor: { userId: "u2", email: "other@test.local" },
        action: "test.b",
      });

      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/audit-log?actor=other", {
          headers: { cookie: adminCookie },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: AuditLogEntry[] };
      expect(body.entries.length).toBe(1);
      expect(body.entries[0]!.actor_email).toBe("other@test.local");
    });
  });

  test("GET /admin/audit-log filters by action prefix", async () => {
    await withApp(async (app) => {
      const { recordAuditEvent } = await import("../audit");

      recordAuditEvent(app.storage, {
        actor: { userId: "u1", email: "coach@test.local" },
        action: "user.delete",
      });
      recordAuditEvent(app.storage, {
        actor: { userId: "u1", email: "coach@test.local" },
        action: "container.stop",
      });

      const adminRes = await login(app, "coach", { role: "admin" });
      const adminCookie = cookieFrom(adminRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/audit-log?action=user", {
          headers: { cookie: adminCookie },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: AuditLogEntry[] };
      expect(body.entries.length).toBe(1);
      expect(body.entries[0]!.action).toBe("user.delete");
    });
  });

  test("audit log requires admin role", async () => {
    await withApp(async (app) => {
      const studentRes = await login(app, "student");
      const studentCookie = cookieFrom(studentRes);

      const res = await app.fetch(
        new Request("http://localhost/admin/audit-log", {
          headers: { cookie: studentCookie },
        }),
      );
      expect(res.status).toBe(403);
    });
  });
});
