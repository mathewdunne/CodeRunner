import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAdminPoll } from "../hooks/useAdminPoll";

type WorkspaceStatus = {
	workspace: { id: string; slug: string; lastAccessedAt: string };
	user: { displayName: string; email: string; role: string };
	code: { state: string };
	idle: boolean;
};

type DiskUsage = {
	workspaceId: string;
	bytes: number;
};

async function fetchWorkspaceData(): Promise<{
	workspaces: WorkspaceStatus[];
	usage: DiskUsage[];
}> {
	const [statusRes, usageRes] = await Promise.all([
		fetch("/admin/status", { credentials: "same-origin" }),
		fetch("/admin/workspaces/disk-usage", { credentials: "same-origin" }),
	]);
	if (!statusRes.ok) throw new Error(`${statusRes.status}`);
	if (!usageRes.ok) throw new Error(`${usageRes.status}`);
	const status = await statusRes.json();
	const usage = await usageRes.json();
	return { workspaces: status.workspaces, usage: usage.workspaces };
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024;
	for (const unit of units) {
		if (value < 1024) return `${value.toFixed(1)} ${unit}`;
		value /= 1024;
	}
	return `${value.toFixed(1)} TiB`;
}

export function Workspaces() {
	const { data, loading, error, refetch } = useAdminPoll(
		useCallback(fetchWorkspaceData, []),
		10000,
	);
	const usageByWorkspace = useMemo(
		() =>
			new Map(
				(data?.usage ?? []).map((entry) => [entry.workspaceId, entry.bytes]),
			),
		[data],
	);

	async function postWorkspaceAction(
		workspaceId: string,
		action: "backup" | "stop-containers" | "restart-code",
	) {
		const response = await fetch(`/admin/workspaces/${workspaceId}/${action}`, {
			method: "POST",
			credentials: "same-origin",
		});
		if (!response.ok) {
			throw new Error(`${response.status}`);
		}
		await refetch();
	}

	if (loading && !data)
		return <p className="text-muted-foreground p-4">Loading…</p>;
	if (error) return <p className="text-destructive p-4">Error: {error}</p>;

	return (
		<div className="space-y-6">
			<h2 className="text-xl font-semibold">Workspaces</h2>
			<Card>
				<CardContent className="pt-6">
					{!data || data.workspaces.length === 0 ? (
						<p className="text-muted-foreground">No workspaces yet.</p>
					) : (
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b text-left text-muted-foreground">
									<th className="pb-2">Slug</th>
									<th className="pb-2">Owner</th>
									<th className="pb-2">Last seen</th>
									<th className="pb-2">Disk</th>
									<th className="pb-2">State</th>
									<th className="pb-2">Actions</th>
								</tr>
							</thead>
							<tbody>
								{data.workspaces.map((workspace) => (
									<tr
										key={workspace.workspace.id}
										className="border-b last:border-0"
									>
										<td className="py-2 font-mono">
											{workspace.workspace.slug}
										</td>
										<td className="py-2">
											{workspace.user.displayName}
											<div className="text-xs text-muted-foreground">
												{workspace.user.email}
											</div>
										</td>
										<td className="py-2">
											{new Date(
												workspace.workspace.lastAccessedAt,
											).toLocaleString()}
										</td>
										<td className="py-2">
											{formatBytes(
												usageByWorkspace.get(workspace.workspace.id) ?? 0,
											)}
										</td>
										<td className="py-2">{workspace.code.state}</td>
										<td className="flex gap-2 py-2">
											<a
												className="inline-flex h-7 items-center rounded-lg border border-border px-2.5 text-[0.8rem] hover:bg-muted"
												href={`/u/${workspace.workspace.slug}/`}
											>
												Open
											</a>
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													void postWorkspaceAction(
														workspace.workspace.id,
														"backup",
													)
												}
											>
												Backup
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													void postWorkspaceAction(
														workspace.workspace.id,
														"restart-code",
													)
												}
											>
												Restart
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													void postWorkspaceAction(
														workspace.workspace.id,
														"stop-containers",
													)
												}
											>
												Stop
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
