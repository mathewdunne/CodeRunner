import type { DsMode } from "@/lib/contracts";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<DsMode, string> = {
	teleop: "Teleop",
	auto: "Auto",
	test: "Test",
};

const MODE_CLASSES: Record<DsMode, { active: string }> = {
	teleop: {
		active: "border-blue-400/60 bg-blue-500/20 text-blue-100",
	},
	auto: {
		active: "border-orange-400/60 bg-orange-500/20 text-orange-100",
	},
	test: {
		active: "border-purple-400/60 bg-purple-500/20 text-purple-100",
	},
};

interface ModeColumnProps {
	mode: DsMode;
	onSelect: (mode: DsMode) => void;
}

export function ModeColumn({ mode, onSelect }: ModeColumnProps) {
	return (
		<div className="flex h-full min-h-0 flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card p-1.5">
			<span className="px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
				Mode
			</span>
			{(Object.keys(MODE_LABELS) as DsMode[]).map((m) => {
				const active = mode === m;
				return (
					<button
						key={m}
						type="button"
						onClick={() => onSelect(m)}
						data-testid={`ds-mode-${m}`}
						data-active={active}
						className={cn(
							"min-h-[18px] flex-1 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase leading-none tracking-[0.12em] transition-colors",
							active
								? MODE_CLASSES[m].active
								: "border-border bg-white/[0.02] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
						)}
					>
						{MODE_LABELS[m]}
					</button>
				);
			})}
		</div>
	);
}
