import { useCallback, useState } from "react";
import { useAdminPoll } from "../hooks/useAdminPoll";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string | null;
  slug: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

async function fetchUsers(): Promise<UserRow[]> {
  const res = await fetch("/admin/users", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.json();
  return body.users;
}

export function Users() {
  const { data: users, loading, error, refetch } = useAdminPoll(useCallback(fetchUsers, []), 10000);
  const [busy, setBusy] = useState<string | null>(null);

  async function setRole(userId: string, action: "promote" | "demote") {
    setBusy(userId);
    try {
      const response = await fetch(`/admin/users/${userId}/${action}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`${response.status}`);
      await refetch();
    } finally {
      setBusy(null);
    }
  }

  async function removeUser(user: UserRow) {
    if (!confirm(`Delete ${user.email} and their workspace? This cannot be undone.`)) return;
    setBusy(user.id);
    try {
      const response = await fetch(`/admin/users/${user.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`${response.status}`);
      await refetch();
    } finally {
      setBusy(null);
    }
  }

  if (loading && !users) return <p className="text-muted-foreground p-4">Loading…</p>;
  if (error) return <p className="text-destructive p-4">Error: {error}</p>;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Users</h2>
      <Card>
        <CardContent className="pt-6">
          {!users || users.length === 0 ? (
            <p className="text-muted-foreground">No users yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2">Email</th>
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Role</th>
                  <th className="pb-2">Slug</th>
                  <th className="pb-2">Last seen</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b last:border-0">
                    <td className="py-2">{u.email}</td>
                    <td className="py-2">{u.name}</td>
                    <td className="py-2">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs ${
                        u.role === "admin" ? "bg-blue-900 text-blue-300" : "bg-zinc-800 text-zinc-400"
                      }`}>
                        {u.role ?? "student"}
                      </span>
                    </td>
                    <td className="py-2 font-mono">{u.slug ?? "—"}</td>
                    <td className="py-2">{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleString() : "—"}</td>
                    <td className="flex gap-2 py-2">
                      {u.role === "admin" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === u.id}
                          onClick={() => setRole(u.id, "demote")}
                        >
                          Demote
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === u.id}
                          onClick={() => setRole(u.id, "promote")}
                        >
                          Promote
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy === u.id}
                        onClick={() => void removeUser(u)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
