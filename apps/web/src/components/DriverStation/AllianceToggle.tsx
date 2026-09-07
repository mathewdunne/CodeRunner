import type { AllianceStation } from "@/lib/contracts";
import { cn } from "@/lib/utils";

type Side = "blue" | "red";

// The sim reports six stations; students only pick a side, so each side maps
// to station 1. Re-picking the active side is a no-op, which lets robot code
// that set e.g. red3 keep its station number.
const SIDE_STATION: Record<Side, AllianceStation> = {
	blue: "blue1",
	red: "red1",
};

const SIDE_ACTIVE: Record<Side, string> = {
	blue: "border-blue-400/60 bg-blue-500/20 text-blue-100",
	red: "border-red-400/60 bg-red-500/20 text-red-100",
};

// Joined segments: the pair reads as one switch rather than two buttons.
const SIDE_EDGE: Record<Side, string> = {
	blue: "rounded-l-md",
	red: "-ml-px rounded-r-md",
};

function sideOf(alliance: AllianceStation): Side {
	return alliance.startsWith("red") ? "red" : "blue";
}

interface AllianceToggleProps {
	alliance: AllianceStation;
	enabled: boolean;
	onSelect: (alliance: AllianceStation) => void;
}

export function AllianceToggle({
	alliance,
	enabled,
	onSelect,
}: AllianceToggleProps) {
	const current = sideOf(alliance);

	return (
		<div className="flex min-h-[50px] flex-1 flex-col gap-1 overflow-hidden pt-1">
			<span className="px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
				Alliance
			</span>
			<fieldset
				aria-label="Alliance"
				className="flex min-h-0 min-w-0 flex-1 items-stretch border-0 p-0"
			>
				{(["blue", "red"] as Side[]).map((side) => {
					const active = current === side;
					return (
						<button
							key={side}
							type="button"
							onClick={() => {
								if (!active) onSelect(SIDE_STATION[side]);
							}}
							disabled={enabled}
							aria-pressed={active}
							title={
								enabled ? "Disable the robot to change alliance" : undefined
							}
							data-testid={`ds-alliance-${side}`}
							data-active={active}
							className={cn(
								"min-h-[28px] flex-1 border px-1.5 py-1 text-[11px] font-semibold uppercase leading-none tracking-[0.1em] transition-colors disabled:cursor-not-allowed",
								SIDE_EDGE[side],
								// Lift the selected segment so its coloured border wins on
								// the shared edge.
								active
									? cn("relative z-10", SIDE_ACTIVE[side])
									: "border-border bg-white/[0.02] text-muted-foreground enabled:hover:bg-white/[0.05] enabled:hover:text-foreground",
								// Keep the selected side legible while locked — alliance
								// matters most exactly when the robot is running.
								enabled && (active ? "opacity-70" : "opacity-40"),
							)}
						>
							{side}
						</button>
					);
				})}
			</fieldset>
		</div>
	);
}
