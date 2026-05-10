import { useCallback } from "react";
import { useAdminPoll } from "../hooks/useAdminPoll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type AdminStatus = {
  ok: boolean;
  workspaces: Array<{
    workspace: { id: string; slug: string; lastAccessed: string };
    user: { displayName: string; email: string; role: string };
    lease: { codeState: string } | null;
  }>;
  idleStopMinutes: number;
  activeBuilds: number;
};

async function fetchStatus(): Promise<AdminStatus> {
  const res = await fetch("/admin/status", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export function Dashboard() {
  const { data, loading, error } = useAdminPoll(useCallback(fetchStatus, []), 5000);

  if (loading && !data) return <p className="text-muted-foreground p-4">Loading…</p>;
  if (error) return <p className="text-destructive p-4">Error: {error}</p>;
  if (!data) return null;

  const running = data.workspaces.filter((w) => w.lease?.codeState === "running").length;
  const total = data.workspaces.length;

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Dashboard</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Active Workspaces</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{running} / {total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Active Builds</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data.activeBuilds}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Idle Timeout</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{data.idleStopMinutes} min</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
        </CardHeader>
        <CardContent>
          {data.workspaces.length === 0 ? (
            <p className="text-muted-foreground">No workspaces yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2">Slug</th>
                  <th className="pb-2">User</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.workspaces.map((w) => (
                  <tr key={w.workspace.id} className="border-b last:border-0">
                    <td className="py-2 font-mono">{w.workspace.slug}</td>
                    <td className="py-2">{w.user.displayName}</td>
                    <td className="py-2">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs ${
                        w.lease?.codeState === "running" ? "bg-green-900 text-green-300" :
                        w.lease?.codeState === "starting" ? "bg-yellow-900 text-yellow-300" :
                        "bg-zinc-800 text-zinc-400"
                      }`}>
                        {w.lease?.codeState ?? "no container"}
                      </span>
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
