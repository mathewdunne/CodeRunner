import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminPoll } from "../hooks/useAdminPoll";

type AdminStatus = {
	ok: boolean;
	workspaces: Array<{
		workspace: { id: string; slug: string; lastAccessedAt: string };
		user: { displayName: string; email: string; role: string };
		code: { state: string; containerName: string | null };
		idle: boolean;
		lastActivity: string;
	}>;
	idleStopMinutes: number;
	activeBuilds: number;
	maxActiveContainers?: number;
};

async function fetchStatus(): Promise<AdminStatus> {
	const res = await fetch("/admin/status", { credentials: "same-origin" });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

function CapacityEditor({
	current,
	onSave,
}: {
	current: number;
	onSave: (value: number) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(String(current));
	const [saving, setSaving] = useState(false);

	if (!editing) {
		return (
			<div className="flex items-center gap-2">
				<span className="text-2xl font-bold">{current}</span>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setValue(String(current));
						setEditing(true);
					}}
				>
					Edit
				</Button>
			</div>
		);
	}

	const handleSave = async () => {
		const parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed < 1) return;
		setSaving(true);
		try {
			const res = await fetch("/admin/config/max-active-containers", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ value: parsed }),
			});
			if (res.ok) {
				onSave(parsed);
				setEditing(false);
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex items-center gap-2">
			<input
				type="number"
				min={1}
				className="w-20 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				disabled={saving}
			/>
			<Button
				variant="secondary"
				size="sm"
				onClick={handleSave}
				disabled={saving}
			>
				Save
			</Button>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setEditing(false)}
				disabled={saving}
			>
				Cancel
			</Button>
		</div>
	);
}

export function Dashboard() {
	const { data, loading, error, refetch } = useAdminPoll(
		useCallback(fetchStatus, []),
		5000,
	);

	if (loading && !data)
		return <p className="text-muted-foreground p-4">Loading…</p>;
	if (error) return <p className="text-destructive p-4">Error: {error}</p>;
	if (!data) return null;

	const running = data.workspaces.filter(
		(w) => w.code.state === "running",
	).length;
	const total = data.workspaces.length;
	const cap = data.maxActiveContainers ?? 10;

	return (
		<div className="space-y-6">
			<h2 className="text-xl font-semibold">Dashboard</h2>
			<div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-muted-foreground">
							Active Workspaces
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-bold">
							{running} / {total}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-muted-foreground">
							Container Cap
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="flex items-baseline gap-2">
							<span className="text-lg text-muted-foreground">{running} /</span>
							<CapacityEditor current={cap} onSave={() => refetch()} />
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-muted-foreground">
							Active Builds
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="text-2xl font-bold">{data.activeBuilds}</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm text-muted-foreground">
							Idle Timeout
						</CardTitle>
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
											<span
												className={`inline-block rounded px-2 py-0.5 text-xs ${
													w.code.state === "running"
														? "bg-green-900 text-green-300"
														: w.code.state === "starting"
															? "bg-yellow-900 text-yellow-300"
															: "bg-zinc-800 text-zinc-400"
												}`}
											>
												{w.code.state}
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
