import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { DriverStation } from "@/components/DriverStation";
import { EditorPane } from "@/components/EditorPane";
import { IDELayout } from "@/components/IDELayout";
import { ScopePane } from "@/components/ScopePane";
import { Topbar } from "@/components/Topbar";
import { useAutoChoosers } from "@/hooks/useAutoChoosers";
import { useEditorReachability } from "@/hooks/useEditorReachability";
import { type GamepadInfo, useGamepad } from "@/hooks/useGamepad";
import { useGamepadChannel } from "@/hooks/useGamepadChannel";
import { useRunChannel } from "@/hooks/useRunChannel";
import { useScopeHandshake } from "@/hooks/useScopeHandshake";
import { useSession } from "@/hooks/useSession";
import { useSimulationState } from "@/hooks/useSimulationState";
import { isWorkspaceSlug } from "@/lib/contracts";
import { gamepadFrameToWpilib } from "@/lib/gamepad-mapping";
import {
	gamepadStateToVisualizerFrame,
	KEYBOARD_GAMEPAD_ID,
	KEYBOARD_GAMEPAD_LABEL,
	keyboardCodesToWpilib,
	NEUTRAL_GAMEPAD_STATE,
} from "@/lib/keyboard-mapping";
import { useUIStore } from "@/state/store";

export function WorkspacePage() {
	const { slug } = useParams<{ slug: string }>();
	const workspaceSlug = useMemo(
		() => (slug && isWorkspaceSlug(slug) ? slug : null),
		[slug],
	);

	const sessionState = useSession(workspaceSlug);
	const { connection: runConnection, consoleLines } =
		useRunChannel(workspaceSlug);
	const simulation = useSimulationState(workspaceSlug);
	const autoChoosers = useAutoChoosers(workspaceSlug);
	const editorUrl = workspaceSlug
		? `/u/${workspaceSlug}/vscode/?folder=/workspace/project`
		: null;
	const editorStatus = useEditorReachability(editorUrl);
	const scopeFrameRef = useRef<HTMLIFrameElement>(null);
	useScopeHandshake(workspaceSlug, scopeFrameRef);

	const gamepad = useGamepad();
	const channel = useGamepadChannel(workspaceSlug);
	const inputMode = useUIStore((state) => state.inputMode);
	const setInputMode = useUIStore((state) => state.setInputMode);
	const [keyboardCodes, setKeyboardCodes] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const keyboardState = useMemo(
		() => keyboardCodesToWpilib(keyboardCodes),
		[keyboardCodes],
	);
	const keyboardFrame = useMemo(
		() => gamepadStateToVisualizerFrame(keyboardState),
		[keyboardState],
	);

	// Bridge: when a gamepad frame arrives, ship the WPILib-mapped state to
	// the channel. pushState handles its own throttle / heartbeat / diffing,
	// so we can call it on every frame without burning bandwidth.
	useEffect(() => {
		if (
			inputMode !== "controller" ||
			!gamepad.frame ||
			gamepad.selectedIndex === null
		)
			return;
		channel.pushState(gamepadFrameToWpilib(gamepad.frame));
	}, [inputMode, gamepad.frame, gamepad.selectedIndex, channel]);

	useEffect(() => {
		if (inputMode !== "keyboard") return;
		channel.pushState(keyboardState);
	}, [inputMode, keyboardState, channel]);

	const onSelectGamepad = useCallback(
		(info: GamepadInfo) => {
			setInputMode("controller");
			setKeyboardCodes(new Set());
			gamepad.selectGamepad(info.index);
			channel.select(info.id, info.label);
		},
		[gamepad, channel, setInputMode],
	);

	const onReleaseGamepad = useCallback(() => {
		gamepad.selectGamepad(null);
		channel.release();
	}, [gamepad, channel]);

	const onSelectControllerMode = useCallback(() => {
		setInputMode("controller");
		setKeyboardCodes(new Set());
		const selected = gamepad.available.find(
			(info) => info.index === gamepad.selectedIndex,
		);
		if (selected) {
			channel.select(selected.id, selected.label);
		} else {
			channel.release();
		}
	}, [channel, gamepad.available, gamepad.selectedIndex, setInputMode]);

	const onSelectKeyboardMode = useCallback(() => {
		setInputMode("keyboard");
		gamepad.selectGamepad(null);
		setKeyboardCodes(new Set());
		channel.select(KEYBOARD_GAMEPAD_ID, KEYBOARD_GAMEPAD_LABEL);
		channel.pushState(NEUTRAL_GAMEPAD_STATE);
	}, [channel, gamepad, setInputMode]);

	const onKeyboardCodesChange = useCallback((codes: ReadonlySet<string>) => {
		setKeyboardCodes(codes);
	}, []);

	const onKeyboardRelease = useCallback(() => {
		setKeyboardCodes(new Set());
		if (inputMode === "keyboard") {
			channel.pushState(NEUTRAL_GAMEPAD_STATE);
		}
	}, [channel, inputMode]);

	// Safety: if the selected gamepad disappears (useGamepad clears
	// selectedIndex), tell the server to release.
	const lastSelectedRef = useRef<number | null>(null);
	useEffect(() => {
		if (
			inputMode === "controller" &&
			lastSelectedRef.current !== null &&
			gamepad.selectedIndex === null
		) {
			channel.release();
		}
		lastSelectedRef.current = gamepad.selectedIndex;
	}, [inputMode, gamepad.selectedIndex, channel]);

	const displayName =
		sessionState.status === "ready"
			? sessionState.session.user.displayName
			: "Loading";
	const email =
		sessionState.status === "ready" ? sessionState.session.user.email : "";
	const avatarUrl =
		sessionState.status === "ready"
			? sessionState.session.user.avatarUrl
			: null;
	const isAdmin =
		sessionState.status === "ready" &&
		sessionState.session.user.role === "admin";

	const sessionReady = sessionState.status === "ready";
	const errorMessage =
		sessionState.status === "error" ? sessionState.message : undefined;

	return (
		<div className="flex h-screen flex-col bg-background">
			<Topbar
				displayName={displayName}
				email={email}
				avatarUrl={avatarUrl}
				isAdmin={isAdmin}
				workspaceSlug={workspaceSlug}
			/>
			<IDELayout
				editor={
					<EditorPane
						editorUrl={editorUrl}
						editorStatus={editorStatus}
						errorMessage={errorMessage}
					/>
				}
				scope={<ScopePane ref={scopeFrameRef} />}
				driverStation={
					<DriverStation
						simulationStatus={simulation.status}
						runStatus={simulation.runStatus}
						runConnection={runConnection}
						sessionReady={sessionReady}
						consoleLines={consoleLines}
						autoStatus={autoChoosers.status}
						gamepad={{
							inputMode,
							available: gamepad.available,
							selectedIndex: gamepad.selectedIndex,
							frame: gamepad.frame,
							keyboardFrame,
							keyboardPressedCodes: keyboardCodes,
							channelConnection: channel.connection,
							channelHalsimDisconnected: channel.halsimDisconnected,
							onSelectControllerMode,
							onSelectKeyboardMode,
							onKeyboardCodesChange,
							onKeyboardRelease,
							onSelect: onSelectGamepad,
							onRelease: onReleaseGamepad,
						}}
						onStartRun={simulation.startRun}
						onStopRun={simulation.stopRun}
						onRestartRun={simulation.restartRun}
						onSetDriverStation={simulation.setDriverStation}
						onSelectAuto={autoChoosers.selectAuto}
					/>
				}
			/>
		</div>
	);
}
