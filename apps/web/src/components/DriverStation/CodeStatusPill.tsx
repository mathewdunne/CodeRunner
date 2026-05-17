import { cn } from "@/lib/utils";

export type CodeStatus = "building" | "running" | "idle";

const TONES: Record<
	CodeStatus,
	{ dot: string; pulse: string; text: string; label: string }
> = {
	building: {
		dot: "bg-amber-400",
		pulse: "ds-pulse-amber",
		text: "text-amber-200",
		label: "Building",
	},
	running: {
		dot: "bg-emerald-400",
		pulse: "ds-pulse-green",
		text: "text-emerald-200",
		label: "Running",
	},
	idle: {
		dot: "bg-zinc-500",
		pulse: "",
		text: "text-zinc-300",
		label: "Idle",
	},
};

export function CodeStatusPill({ status }: { status: CodeStatus }) {
	const tone = TONES[status];
	return (
		<span
			className={cn(
				"inline-flex h-7 items-center gap-2 rounded-md border border-border bg-card px-2.5",
				tone.text,
			)}
		>
			<span className={cn("size-2 rounded-full", tone.dot, tone.pulse)} />
			<span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
				Code
			</span>
			<span className="text-[12px] font-medium">{tone.label}</span>
		</span>
	);
}
