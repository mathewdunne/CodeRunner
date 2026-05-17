import type { RunConnection } from "@/hooks/useRunChannel";
import type {
	DriverStationPatch,
	SimRunStatus,
	SimStatusResponse,
} from "@/lib/contracts";
import type { InputMode } from "@/state/store";
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
		alliance: "red1" as const,
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

			{/* Right column spans rows 1+2: Mode */}
			<div className="row-span-2 min-h-0">
				<ModeColumn
					mode={driverStation.mode}
					onSelect={(mode) =>
						onSetDriverStation(
							driverStation.enabled ? { enabled: false, mode } : { mode },
						)
					}
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

			{/* Row 3 spans both columns: Enable / Disable */}
			<div className="col-span-2 min-h-0">
				<EnableDisableRow
					enabled={driverStation.enabled}
					canEnable={canEnable}
					onSetEnabled={(enabled) => onSetDriverStation({ enabled })}
				/>
			</div>
		</div>
	);
}
