import { type FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { classroomJoinErrorSchema } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const inputClass =
	"h-10 w-full rounded-md border border-border bg-card px-3 text-[13px] text-foreground outline-none focus:border-foreground/40";

function digitsOnly(value: string): string {
	return value.replace(/\D/gu, "").slice(0, 6);
}

function goToWorkspace() {
	// "/" redirects a signed-in user to their workspace.
	window.location.assign("/");
}

export function JoinPage({
	onJoined = goToWorkspace,
}: {
	onJoined?: () => void;
}) {
	const [searchParams] = useSearchParams();
	const [code, setCode] = useState(() =>
		digitsOnly(searchParams.get("code") ?? ""),
	);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [takenName, setTakenName] = useState<string | null>(null);

	async function join(confirmExisting: boolean) {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/classroom/join", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					code,
					name,
					...(confirmExisting ? { confirmExisting: true } : {}),
				}),
			});
			if (response.ok) {
				onJoined();
				return;
			}
			const parsed = classroomJoinErrorSchema.safeParse(
				await response.json().catch(() => null),
			);
			if (parsed.success && parsed.data.code === "NAME_TAKEN") {
				setTakenName(parsed.data.displayName ?? name.trim());
				return;
			}
			setTakenName(null);
			setError(
				parsed.success
					? parsed.data.message
					: "Couldn't join right now. Please try again.",
			);
		} catch {
			setError(
				"Couldn't reach CodeRunner. Check your connection and try again.",
			);
		} finally {
			setBusy(false);
		}
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		void join(false);
	}

	const canSubmit = code.length === 6 && name.trim() !== "" && !busy;

	return (
		<div className="flex h-screen w-full items-center justify-center bg-background px-8">
			<div className="w-full max-w-[320px]">
				<p className="mb-6 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
					Join a classroom
				</p>

				{error && (
					<div
						role="alert"
						className="mb-5 rounded-md border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12px] text-red-300"
					>
						{error}
					</div>
				)}

				{takenName ? (
					<div className="flex flex-col gap-3">
						<p className="text-[13px] text-foreground">
							<strong>{takenName}</strong> already joined this classroom. Is
							that you?
						</p>
						<Button
							type="button"
							disabled={busy}
							onClick={() => void join(true)}
						>
							Yes, that&apos;s me
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => setTakenName(null)}
						>
							No, change my name
						</Button>
					</div>
				) : (
					<form onSubmit={onSubmit} className="flex flex-col gap-3">
						<label
							htmlFor="classroom-code"
							className="text-[12px] text-muted-foreground"
						>
							Classroom code
						</label>
						<input
							id="classroom-code"
							inputMode="numeric"
							autoComplete="off"
							placeholder="123456"
							value={code}
							onChange={(event) => setCode(digitsOnly(event.target.value))}
							className={cn(inputClass, "font-mono tracking-[0.3em]")}
						/>
						<label
							htmlFor="guest-name"
							className="text-[12px] text-muted-foreground"
						>
							Your name
						</label>
						<input
							id="guest-name"
							autoComplete="off"
							maxLength={40}
							placeholder="First name + last initial (e.g. Alex D)"
							value={name}
							onChange={(event) => setName(event.target.value)}
							className={inputClass}
						/>
						<Button type="submit" disabled={!canSubmit}>
							Join
						</Button>
					</form>
				)}

				<p className="mt-6 text-[10.5px] leading-relaxed text-muted-foreground">
					Have an account?{" "}
					<a href="/login" className="text-foreground/60 underline">
						Sign in instead
					</a>
				</p>
			</div>
		</div>
	);
}
