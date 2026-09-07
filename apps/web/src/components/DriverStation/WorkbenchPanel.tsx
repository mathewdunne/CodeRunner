import type { RunConnection } from "@/hooks/useRunChannel";
import type {
	DriverStationPatch,
	SimRunStatus,
	SimStatusResponse,
} from "@/lib/contracts";
import type { InputMode } from "@/state/store";
import { AllianceToggle } from "./AllianceToggle";
import { EnableDisableRow } from "./EnableDisableRow";
import { ModeColumn } from "./ModeColumn";
import { SimControlsBlock } from "./SimControlsBlock";
import { StatusTileRow } from "./StatusTile";

interface WorkbenchPanelProps {
	runStatus: SimRunStatus;
	sessionReady: boolean;
	simulationStatus: SimStatusResponse | null;
	runConnection: RunConnection;
	inputMode: InputMode;
	keyboardCaptureActive: boolean;
	onStartRun: () => void;
	onStopRun: () => void;
	onRestartRun: () => void;
	onSetDriverStation: (patch: DriverStationPatch) => void;
}

export function WorkbenchPanel({
	runStatus,
	sessionReady,
	simulationStatus,
	runConnection,
	inputMode,
	keyboardCaptureActive,
	onStartRun,
	onStopRun,
	onRestartRun,
	onSetDriverStation,
}: WorkbenchPanelProps) {
	const driverStation = simulationStatus?.driverStation ?? {
		enabled: false,
		mode: "teleop" as const,
		eStopped: false,
		alliance: "blue1" as const,
	};
	const halConnection = simulationStatus?.halsim.connection ?? "disconnected";
	const canEnable = Boolean(simulationStatus?.comms.canEnable && sessionReady);

	return (
		<div
			className="grid h-full min-h-0 w-[560px] shrink-0 overflow-hidden gap-2.5 border-r border-border p-3"
			style={{
				gridTemplateColumns: "1fr 130px",
				gridTemplateRows:
					"minmax(60px, 0.7fr) minmax(64px, 0.95fr) minmax(48px, 1fr)",
			}}
		>
			{/* Row 1, col 1: Sim controls */}
			<div className="min-h-0">
				<SimControlsBlock
					runStatus={runStatus}
					sessionReady={sessionReady}
					onStart={onStartRun}
					onStop={onStopRun}
					onRestart={onRestartRun}
				/>
			</div>

			{/* Right column spans all rows: Mode + Alliance */}
			<div className="row-span-3 flex min-h-0 flex-col gap-1.5 overflow-hidden rounded-lg border border-border bg-card p-1.5">
				<ModeColumn
					mode={driverStation.mode}
					onSelect={(mode) =>
						onSetDriverStation(
							driverStation.enabled ? { enabled: false, mode } : { mode },
						)
					}
				/>
				<AllianceToggle
					alliance={driverStation.alliance}
					enabled={driverStation.enabled}
					onSelect={(alliance) => onSetDriverStation({ alliance })}
				/>
			</div>

			{/* Row 2, col 1: Status tiles */}
			<div className="min-h-0">
				<StatusTileRow
					halConnection={halConnection}
					runConnection={runConnection}
					runStatus={runStatus}
					joystickStatus={simulationStatus?.joysticks.status ?? "unknown"}
					inputMode={inputMode}
					keyboardCaptureActive={keyboardCaptureActive}
				/>
			</div>

			{/* Row 3, col 1: Enable / Disable */}
			<div className="min-h-0">
				<EnableDisableRow
					enabled={driverStation.enabled}
					canEnable={canEnable}
					onSetEnabled={(enabled) => onSetDriverStation({ enabled })}
				/>
			</div>
		</div>
	);
}
