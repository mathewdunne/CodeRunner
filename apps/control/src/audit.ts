import type { AppStorage } from "./storage";

export type AuditActor = {
  userId: string;
  email: string;
};

export type AuditEventInput = {
  actor: AuditActor;
  action: string;
  target?: { kind: string; id: string } | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export function recordAuditEvent(storage: AppStorage, event: AuditEventInput): void {
  const metadataJson = event.metadata ? JSON.stringify(event.metadata) : null;
  storage.db
    .query(
      `INSERT INTO audit_log (actor_user_id, actor_email, action, target_kind, target_id, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.actor.userId,
      event.actor.email,
      event.action,
      event.target?.kind ?? null,
      event.target?.id ?? null,
      metadataJson,
      Date.now(),
    );
}

export type AuditLogEntry = {
  id: number;
  actor_user_id: string;
  actor_email: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  metadata_json: string | null;
  occurred_at: number;
};

export type AuditLogQuery = {
  limit?: number;
  before?: number | undefined;
  actorEmail?: string | undefined;
  actionPrefix?: string | undefined;
  sinceMs?: number | undefined;
};

export function queryAuditLog(storage: AppStorage, query: AuditLogQuery = {}): AuditLogEntry[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.before !== undefined) {
    conditions.push("id < ?");
    params.push(query.before);
  }

  if (query.actorEmail) {
    conditions.push("actor_email LIKE ?");
    params.push(`%${query.actorEmail}%`);
  }

  if (query.actionPrefix) {
    conditions.push("action LIKE ?");
    params.push(`${query.actionPrefix}%`);
  }

  if (query.sinceMs !== undefined) {
    conditions.push("occurred_at >= ?");
    params.push(query.sinceMs);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  params.push(limit);

  return storage.db
    .query(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params) as AuditLogEntry[];
}
