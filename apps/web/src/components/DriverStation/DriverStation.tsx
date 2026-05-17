import {
	type FocusEvent,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { GamepadFrame, GamepadInfo } from "@/hooks/useGamepad";
import type { GamepadChannelConnection } from "@/hooks/useGamepadChannel";
import type { RunConnection } from "@/hooks/useRunChannel";
import type {
	AutoChooserPatch,
	AutoChoosersResponse,
	DriverStationPatch,
	SimRunStatus,
	SimStatusResponse,
} from "@/lib/contracts";
import { isMappedKeyboardCode } from "@/lib/keyboard-mapping";
import type { InputMode } from "@/state/store";
import { AutoPanel } from "./AutoPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ControlsPanel } from "./ControlsPanel";
import { IconRail, type RailTab } from "./IconRail";
import { WorkbenchPanel } from "./WorkbenchPanel";

interface DriverStationProps {
	simulationStatus: SimStatusResponse | null;
	runStatus: SimRunStatus;
	runConnection: RunConnection;
	sessionReady: boolean;
	consoleLines: string[];
	autoStatus: AutoChoosersResponse | null;
	gamepad: {
		inputMode: InputMode;
		available: GamepadInfo[];
		selectedIndex: number | null;
		frame: GamepadFrame | null;
		keyboardFrame: GamepadFrame | null;
		keyboardPressedCodes: ReadonlySet<string>;
		channelConnection: GamepadChannelConnection;
		channelHalsimDisconnected: boolean;
		onSelectControllerMode: () => void;
		onSelectKeyboardMode: () => void;
		onKeyboardCodesChange: (codes: ReadonlySet<string>) => void;
		onKeyboardRelease: () => void;
		onSelect: (info: GamepadInfo) => void;
		onRelease: () => void;
	};
	onStartRun: () => void;
	onStopRun: () => void;
	onRestartRun: () => void;
	onSetDriverStation: (patch: DriverStationPatch) => void;
	onSelectAuto: (patch: AutoChooserPatch) => void;
}

export function DriverStation({
	simulationStatus,
	runStatus,
	runConnection,
	sessionReady,
	consoleLines,
	autoStatus,
	gamepad,
	onStartRun,
	onStopRun,
	onRestartRun,
	onSetDriverStation,
	onSelectAuto,
}: DriverStationProps) {
	const [railTab, setRailTab] = useState<RailTab>("console");
	const [driverStationFocused, setDriverStationFocused] = useState(false);
	const sectionRef = useRef<HTMLElement>(null);

	const keyboardCaptureActive =
		gamepad.inputMode === "keyboard" && driverStationFocused;

	const releaseKeyboard = useCallback(() => {
		if (gamepad.inputMode === "keyboard") {
			gamepad.onKeyboardRelease();
		}
	}, [gamepad]);

	const handleFocusCapture = useCallback(() => {
		setDriverStationFocused(true);
	}, []);

	const handleBlurCapture = useCallback(
		(event: FocusEvent<HTMLElement>) => {
			const nextTarget = event.relatedTarget;
			if (
				nextTarget instanceof Node &&
				event.currentTarget.contains(nextTarget)
			)
				return;
			setDriverStationFocused(false);
			releaseKeyboard();
		},
		[releaseKeyboard],
	);

	const handleMouseDownCapture = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			if (!(event.target instanceof HTMLElement)) return;
			if (keyboardCaptureActive) {
				// Keep focus on the section so keyboard events keep firing,
				// even when clicking buttons (which would otherwise steal focus).
				if (!event.target.closest("input, textarea, select")) {
					event.preventDefault();
					sectionRef.current?.focus();
				}
			} else {
				if (event.target.closest("button, input, textarea, select, [tabindex]"))
					return;
				sectionRef.current?.focus();
			}
		},
		[keyboardCaptureActive],
	);

	const handleKeyDownCapture = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (
				!keyboardCaptureActive ||
				event.repeat ||
				shouldIgnoreKeyboardTarget(event.target)
			)
				return;
			if (!isMappedKeyboardCode(event.code)) return;
			event.preventDefault();
			if (gamepad.keyboardPressedCodes.has(event.code)) return;
			gamepad.onKeyboardCodesChange(
				new Set([...gamepad.keyboardPressedCodes, event.code]),
			);
		},
		[gamepad, keyboardCaptureActive],
	);

	const handleKeyUpCapture = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (!keyboardCaptureActive || shouldIgnoreKeyboardTarget(event.target))
				return;
			if (!isMappedKeyboardCode(event.code)) return;
			event.preventDefault();
			if (!gamepad.keyboardPressedCodes.has(event.code)) return;
			const next = new Set(gamepad.keyboardPressedCodes);
			next.delete(event.code);
			gamepad.onKeyboardCodesChange(next);
		},
		[gamepad, keyboardCaptureActive],
	);

	useEffect(() => {
		const handleWindowBlur = () => {
			setDriverStationFocused(false);
			releaseKeyboard();
		};
		window.addEventListener("blur", handleWindowBlur);
		return () => {
			window.removeEventListener("blur", handleWindowBlur);
		};
	}, [releaseKeyboard]);

	return (
		<section
			ref={sectionRef}
			tabIndex={-1}
			onFocusCapture={handleFocusCapture}
			onBlurCapture={handleBlurCapture}
			onMouseDownCapture={handleMouseDownCapture}
			onKeyDownCapture={handleKeyDownCapture}
			onKeyUpCapture={handleKeyUpCapture}
			className="flex h-full min-h-0 overflow-hidden border-t border-border bg-background focus:outline-none"
		>
			<IconRail active={railTab} onSelect={setRailTab} />
			<WorkbenchPanel
				runStatus={runStatus}
				sessionReady={sessionReady}
				simulationStatus={simulationStatus}
				runConnection={runConnection}
				inputMode={gamepad.inputMode}
				keyboardCaptureActive={keyboardCaptureActive}
				onStartRun={onStartRun}
				onStopRun={onStopRun}
				onRestartRun={onRestartRun}
				onSetDriverStation={onSetDriverStation}
			/>
			{railTab === "auto" ? (
				<AutoPanel
					autoStatus={autoStatus}
					runStatus={runStatus}
					sessionReady={sessionReady}
					onSelectAuto={onSelectAuto}
				/>
			) : railTab === "controls" ? (
				<ControlsPanel
					inputMode={gamepad.inputMode}
					available={gamepad.available}
					selectedIndex={gamepad.selectedIndex}
					frame={gamepad.frame}
					keyboardFrame={gamepad.keyboardFrame}
					keyboardCaptureActive={keyboardCaptureActive}
					runStatus={runStatus}
					simulationStatus={simulationStatus}
					channelConnection={gamepad.channelConnection}
					channelHalsimDisconnected={gamepad.channelHalsimDisconnected}
					onSelectControllerMode={gamepad.onSelectControllerMode}
					onSelectKeyboardMode={gamepad.onSelectKeyboardMode}
					onSelect={gamepad.onSelect}
					onRelease={gamepad.onRelease}
				/>
			) : (
				<ConsolePanel robotLines={consoleLines} runStatus={runStatus} />
			)}
		</section>
	);
}

function shouldIgnoreKeyboardTarget(target: EventTarget): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return Boolean(
		target.closest("input, textarea, select, [contenteditable='true']"),
	);
}
