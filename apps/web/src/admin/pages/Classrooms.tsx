import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAdminPoll } from "../hooks/useAdminPoll";

type ClassroomGuest = {
	id: string;
	displayName: string;
	slug: string | null;
	joinedAt: string;
	lastAccessedAt: string | null;
};

type Classroom = {
	id: string;
	code: string;
	createdAt: string;
	expiresAt: string;
	joinUrl: string;
	guests: ClassroomGuest[];
};

type ClassroomsData = { ok: true; classrooms: Classroom[] };

const DURATIONS = [
	{ minutes: 60, label: "1 hour" },
	{ minutes: 120, label: "2 hours" },
	{ minutes: 240, label: "4 hours" },
	{ minutes: 480, label: "8 hours" },
];

async function fetchClassrooms(): Promise<ClassroomsData> {
	const res = await fetch("/admin/classrooms", { credentials: "same-origin" });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

function formatTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function Classrooms() {
	const { data, loading, error, refetch } = useAdminPoll(
		useCallback(fetchClassrooms, []),
		5000,
	);
	const [duration, setDuration] = useState(240);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	async function start() {
		setBusy(true);
		setActionError(null);
		try {
			const res = await fetch("/admin/classrooms", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ durationMinutes: duration }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				setActionError(body?.error ?? `Start failed (${res.status}).`);
			}
			refetch();
		} catch {
			setActionError("Couldn't reach the server.");
		} finally {
			setBusy(false);
		}
	}

	async function end(classroom: Classroom) {
		const confirmed = window.confirm(
			`End classroom ${classroom.code}? This signs out and deletes its ${classroom.guests.length} guest(s) and their projects.`,
		);
		if (!confirmed) return;
		setBusy(true);
		setActionError(null);
		try {
			const res = await fetch(`/admin/classrooms/${classroom.id}/end`, {
				method: "POST",
				credentials: "same-origin",
			});
			if (!res.ok) setActionError(`End failed (${res.status}).`);
			refetch();
		} catch {
			setActionError("Couldn't reach the server.");
		} finally {
			setBusy(false);
		}
	}

	if (loading && !data)
		return <p className="text-muted-foreground p-4">Loading…</p>;
	if (error) return <p className="text-destructive p-4">Error: {error}</p>;

	return (
		<div className="space-y-6">
			<h2 className="text-xl font-semibold">Classrooms</h2>

			{actionError && (
				<p className="text-destructive text-sm" role="alert">
					{actionError}
				</p>
			)}

			<Card>
				<CardHeader>
					<CardTitle className="text-sm">Start a classroom</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="flex gap-2">
						<select
							value={duration}
							onChange={(e) => setDuration(Number(e.target.value))}
							className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
						>
							{DURATIONS.map((option) => (
								<option key={option.minutes} value={option.minutes}>
									{option.label}
								</option>
							))}
						</select>
						<Button size="sm" onClick={start} disabled={busy}>
							Start classroom
						</Button>
					</div>
					<p className="text-muted-foreground mt-2 text-xs">
						Students go to the join link, enter the code and their name. When
						the classroom ends, its guests and their projects are deleted.
					</p>
				</CardContent>
			</Card>

			{data?.classrooms.length === 0 && (
				<p className="text-muted-foreground text-sm">No active classrooms.</p>
			)}

			{data?.classrooms.map((classroom) => (
				<Card key={classroom.id}>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="font-mono text-4xl tracking-[0.3em]">
								{classroom.code}
							</CardTitle>
							<Button
								variant="outline"
								size="sm"
								onClick={() => end(classroom)}
								disabled={busy}
							>
								End now
							</Button>
						</div>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex items-center gap-2">
							<span className="font-mono text-sm">{classroom.joinUrl}</span>
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									void navigator.clipboard
										.writeText(classroom.joinUrl)
										.catch(() => undefined)
								}
							>
								Copy
							</Button>
						</div>
						<p className="text-muted-foreground text-sm">
							Ends at {formatTime(classroom.expiresAt)} ·{" "}
							{classroom.guests.length} guest(s)
						</p>
						{classroom.guests.length > 0 && (
							<ul className="space-y-1">
								{classroom.guests.map((guest) => (
									<li
										key={guest.id}
										className="flex items-center justify-between rounded px-2 py-1 hover:bg-zinc-800"
									>
										<span className="text-sm">{guest.displayName}</span>
										<span className="text-muted-foreground text-xs">
											joined {formatTime(guest.joinedAt)}
											{guest.lastAccessedAt
												? ` · active ${formatTime(guest.lastAccessedAt)}`
												: ""}
										</span>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}
