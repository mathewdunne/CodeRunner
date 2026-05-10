import { useCallback, useState } from "react";
import { useAdminPoll } from "../hooks/useAdminPoll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type AllowlistData = {
  emails: string[];
  domains: string[];
};

async function fetchAllowlist(): Promise<AllowlistData> {
  const res = await fetch("/admin/allowlist", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function Allowlist() {
  const { data, loading, error, refetch } = useAdminPoll(useCallback(fetchAllowlist, []), 10000);
  const [newValue, setNewValue] = useState("");
  const [newKind, setNewKind] = useState<"email" | "domain">("email");
  const [busy, setBusy] = useState(false);

  async function addEntry() {
    if (!newValue.trim()) return;
    setBusy(true);
    try {
      await fetch("/admin/allowlist", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: newKind, value: newValue.trim() }),
      });
      setNewValue("");
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function removeEntry(value: string) {
    setBusy(true);
    try {
      await fetch(`/admin/allowlist/${encodeURIComponent(value)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      refetch();
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setBusy(true);
    try {
      await fetch("/admin/allowlist/reload", {
        method: "POST",
        credentials: "same-origin",
      });
      refetch();
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <p className="text-muted-foreground p-4">Loading…</p>;
  if (error) return <p className="text-destructive p-4">Error: {error}</p>;

  const isEmpty = !data || (data.emails.length === 0 && data.domains.length === 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Allowlist</h2>
        <Button variant="outline" size="sm" onClick={reload} disabled={busy}>
          Reload from disk
        </Button>
      </div>

      {isEmpty && (
        <p className="text-muted-foreground text-sm">
          Allowlist is empty — all emails are permitted (dev mode).
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add entry</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as "email" | "domain")}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            >
              <option value="email">Email</option>
              <option value="domain">Domain</option>
            </select>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={newKind === "email" ? "user@example.com" : "example.com"}
              className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm"
              onKeyDown={(e) => e.key === "Enter" && addEntry()}
            />
            <Button size="sm" onClick={addEntry} disabled={busy || !newValue.trim()}>
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      {data && data.emails.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Emails</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {data.emails.map((email) => (
                <li key={email} className="flex items-center justify-between rounded px-2 py-1 hover:bg-zinc-800">
                  <span className="font-mono text-sm">{email}</span>
                  <Button variant="ghost" size="sm" onClick={() => removeEntry(email)} disabled={busy}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {data && data.domains.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Domains</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1">
              {data.domains.map((domain) => (
                <li key={domain} className="flex items-center justify-between rounded px-2 py-1 hover:bg-zinc-800">
                  <span className="font-mono text-sm">{domain}</span>
                  <Button variant="ghost" size="sm" onClick={() => removeEntry(domain)} disabled={busy}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
