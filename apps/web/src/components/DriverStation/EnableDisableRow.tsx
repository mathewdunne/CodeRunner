import { cn } from "@/lib/utils";

interface BigButtonProps {
	label: string;
	tone: "enable" | "disable";
	active: boolean;
	disabled?: boolean;
	onClick: () => void;
	testId?: string;
}

const TONE_ACTIVE: Record<BigButtonProps["tone"], string> = {
	enable:
		"border-emerald-400/60 bg-emerald-500/25 text-emerald-50 shadow-[inset_0_-2px_0_rgba(0,0,0,0.25),0_0_24px_rgba(34,197,94,0.18)]",
	disable:
		"border-red-400/60 bg-red-500/25 text-red-50 shadow-[inset_0_-2px_0_rgba(0,0,0,0.25),0_0_24px_rgba(239,68,68,0.18)]",
};

function BigButton({
	label,
	tone,
	active,
	disabled = false,
	onClick,
	testId,
}: BigButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			data-testid={testId}
			className={cn(
				"h-full w-full rounded-lg border text-[14px] font-semibold uppercase tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-45",
				active
					? TONE_ACTIVE[tone]
					: "border-border bg-white/[0.03] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
			)}
		>
			{label}
		</button>
	);
}

interface EnableDisableRowProps {
	enabled: boolean;
	canEnable: boolean;
	onSetEnabled: (enabled: boolean) => void;
}

export function EnableDisableRow({
	enabled,
	canEnable,
	onSetEnabled,
}: EnableDisableRowProps) {
	return (
		<div
			className="grid h-full min-h-0 gap-2.5"
			style={{ gridTemplateColumns: "1fr 1fr" }}
		>
			<div className="min-h-0 rounded-lg border border-border bg-card p-2">
				<BigButton
					label={enabled ? "Enabled" : "Enable"}
					tone="enable"
					active={enabled}
					disabled={enabled || !canEnable}
					onClick={() => onSetEnabled(true)}
					testId="ds-enable"
				/>
			</div>
			<div className="min-h-0 rounded-lg border border-border bg-card p-2">
				<BigButton
					label={enabled ? "Disable" : "Disabled"}
					tone="disable"
					active={!enabled}
					disabled={!enabled}
					onClick={() => onSetEnabled(false)}
					testId="ds-disable"
				/>
			</div>
		</div>
	);
}
