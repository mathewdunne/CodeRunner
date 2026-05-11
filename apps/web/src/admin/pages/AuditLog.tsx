import { useCallback, useState } from "react";
import { useAdminPoll } from "../hooks/useAdminPoll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type AuditEntry = {
  id: number;
  actor_user_id: string;
  actor_email: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  metadata_json: string | null;
  occurred_at: number;
};

type AuditLogResponse = {
  ok: boolean;
  entries: AuditEntry[];
};

export function AuditLog() {
  const [actorFilter, setActorFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [daysFilter, setDaysFilter] = useState("");
  const [beforeId, setBeforeId] = useState<number | undefined>(undefined);

  const fetcher = useCallback(async (): Promise<AuditLogResponse> => {
    const params = new URLSearchParams();
    params.set("limit", "50");
    if (beforeId !== undefined) params.set("before", String(beforeId));
    if (actorFilter.trim()) params.set("actor", actorFilter.trim());
    if (actionFilter.trim()) params.set("action", actionFilter.trim());
    if (daysFilter.trim()) params.set("days", daysFilter.trim());
    const res = await fetch(`/admin/audit-log?${params}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }, [beforeId, actorFilter, actionFilter, daysFilter]);

  const { data, loading, error } = useAdminPoll(fetcher, 10_000);

  const entries = data?.entries ?? [];
  const lastId = entries.length > 0 ? entries[entries.length - 1]!.id : undefined;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Audit Log</h2>

      <div className="flex flex-wrap gap-3 text-sm">
        <input
          placeholder="Filter actor email…"
          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5"
          value={actorFilter}
          onChange={(e) => { setActorFilter(e.target.value); setBeforeId(undefined); }}
        />
        <input
          placeholder="Action prefix…"
          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5"
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setBeforeId(undefined); }}
        />
        <input
          placeholder="Last N days…"
          type="number"
          min={1}
          className="w-28 rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5"
          value={daysFilter}
          onChange={(e) => { setDaysFilter(e.target.value); setBeforeId(undefined); }}
        />
        {beforeId !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => setBeforeId(undefined)}>
            ← Back to latest
          </Button>
        )}
      </div>

      {loading && !data && <p className="text-muted-foreground">Loading…</p>}
      {error && <p className="text-destructive">Error: {error}</p>}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>Events</CardTitle>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <p className="text-muted-foreground">No audit events found.</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="pb-2">Time</th>
                      <th className="pb-2">Actor</th>
                      <th className="pb-2">Action</th>
                      <th className="pb-2">Target</th>
                      <th className="pb-2">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <AuditRow key={entry.id} entry={entry} />
                    ))}
                  </tbody>
                </table>
                {entries.length >= 50 && lastId !== undefined && (
                  <div className="mt-4 text-center">
                    <Button variant="outline" size="sm" onClick={() => setBeforeId(lastId)}>
                      Load older →
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const time = new Date(entry.occurred_at).toLocaleString();
  const targetSummary = entry.target_kind
    ? `${entry.target_kind}: ${truncate(entry.target_id ?? "", 20)}`
    : "—";

  return (
    <>
      <tr
        className="cursor-pointer border-b last:border-0 hover:bg-zinc-900/50"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-2 text-xs text-muted-foreground">{time}</td>
        <td className="py-2">{entry.actor_email}</td>
        <td className="py-2 font-mono text-xs">{entry.action}</td>
        <td className="py-2 text-xs">{targetSummary}</td>
        <td className="py-2 text-xs text-muted-foreground">
          {entry.metadata_json ? "▸" : ""}
        </td>
      </tr>
      {expanded && entry.metadata_json && (
        <tr>
          <td colSpan={5} className="bg-zinc-900/30 px-4 py-2">
            <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
              {formatJson(entry.metadata_json)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
