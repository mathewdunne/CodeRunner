import { useMemo, type MouseEvent } from "react";
import { Gamepad2, AlertTriangle, CircleDot, Keyboard, ListChecks } from "lucide-react";
import type { GamepadFrame, GamepadInfo } from "@/hooks/useGamepad";
import type { GamepadChannelConnection } from "@/hooks/useGamepadChannel";
import type { SimRunStatus, SimStatusResponse } from "@/lib/contracts";
import {
  KEYBOARD_BINDINGS,
  type KeyboardBindingGroup,
} from "@/lib/keyboard-mapping";
import type { InputMode } from "@/state/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface ControlsPanelProps {
  inputMode: InputMode;
  available: GamepadInfo[];
  selectedIndex: number | null;
  frame: GamepadFrame | null;
  keyboardFrame: GamepadFrame | null;
  keyboardCaptureActive: boolean;
  runStatus: SimRunStatus;
  simulationStatus: SimStatusResponse | null;
  channelConnection: GamepadChannelConnection;
  channelHalsimDisconnected: boolean;
  onSelectControllerMode: () => void;
  onSelectKeyboardMode: () => void;
  onSelect: (info: GamepadInfo) => void;
  onRelease: () => void;
}

type StatusTone = "ok" | "warn" | "bad" | "muted";

const TONE_PILL: Record<StatusTone, string> = {
  ok: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  warn: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  bad: "border-red-400/40 bg-red-500/10 text-red-200",
  muted: "border-border bg-white/[0.02] text-muted-foreground",
};

const BINDING_GROUPS: KeyboardBindingGroup[] = ["Sticks", "Shoulders", "Buttons", "POV"];

function TileHeader({ label, Icon = Gamepad2 }: { label: string; Icon?: typeof Gamepad2 }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <Icon className="size-3.5" />
      {label}
    </div>
  );
}

export function ControlsPanel({
  inputMode,
  available,
  selectedIndex,
  frame,
  keyboardFrame,
  keyboardCaptureActive,
  runStatus,
  simulationStatus,
  channelConnection,
  channelHalsimDisconnected,
  onSelectControllerMode,
  onSelectKeyboardMode,
  onSelect,
  onRelease,
}: ControlsPanelProps) {
  const selected = useMemo(
    () => available.find((info) => info.index === selectedIndex) ?? null,
    [available, selectedIndex],
  );

  const { statusTone, statusText } = useMemo(() => {
    if (channelConnection !== "connected") {
      return { statusTone: "warn" as StatusTone, statusText: "Connecting to control plane..." };
    }
    if (inputMode === "keyboard") {
      if (runStatus !== "running") {
        return { statusTone: "warn" as StatusTone, statusText: "Run robot code to drive." };
      }
      if (channelHalsimDisconnected) {
        return { statusTone: "bad" as StatusTone, statusText: "HALSim is not reachable." };
      }
      if (simulationStatus && !simulationStatus.halsim.connected) {
        return { statusTone: "warn" as StatusTone, statusText: "Waiting for HALSim..." };
      }
      return { statusTone: "ok" as StatusTone, statusText: "Connected: Keyboard (Standard Xbox)" };
    }
    if (!selected) {
      return available.length === 0
        ? { statusTone: "muted" as StatusTone, statusText: "Plug in a controller and press any button." }
        : { statusTone: "muted" as StatusTone, statusText: "Select a controller to start driving." };
    }
    if (runStatus !== "running") {
      return { statusTone: "warn" as StatusTone, statusText: "Run robot code to drive." };
    }
    if (channelHalsimDisconnected) {
      return { statusTone: "bad" as StatusTone, statusText: "HALSim is not reachable." };
    }
    if (simulationStatus && !simulationStatus.halsim.connected) {
      return { statusTone: "warn" as StatusTone, statusText: "Waiting for HALSim..." };
    }
    return { statusTone: "ok" as StatusTone, statusText: `Connected: ${selected.label}` };
  }, [channelConnection, inputMode, selected, runStatus, channelHalsimDisconnected, simulationStatus, available.length]);

  const visualizerFrame = inputMode === "keyboard" ? keyboardFrame : frame;
  const visualizerActive = inputMode === "keyboard" || selected !== null;
  const keyboardActive = inputMode === "keyboard";
  const keyboardFocusTone = keyboardActive
    ? keyboardCaptureActive
      ? "ok"
      : "bad"
    : "muted";

  const onKeyboardTileClick = (event: MouseEvent<HTMLDivElement>) => {
    onSelectKeyboardMode();
    if (!isInteractiveTarget(event.target)) {
      event.currentTarget.focus();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-row gap-2.5 overflow-hidden border-r border-border p-3">
      <div className="flex min-h-0 w-1/2 flex-col gap-2 overflow-hidden">
        <div
          onClick={onSelectControllerMode}
          className={cn(
            "relative flex min-h-0 flex-1 cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border bg-card py-2 pr-2 pl-8",
            inputMode === "controller" ? "border-orange-400/50" : "border-border",
          )}
        >
          <input
            type="radio"
            name="input-mode"
            checked={inputMode === "controller"}
            onChange={onSelectControllerMode}
            aria-label="Controller input"
            className="absolute top-1/2 left-3 size-3 -translate-y-1/2 accent-orange-400"
          />
          <div className="flex items-center gap-2">
            <TileHeader label="Controller" />
          </div>
          <div className="flex items-center gap-2 px-1">
            <select
              value={selectedIndex ?? ""}
              onFocus={onSelectControllerMode}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "") {
                  onRelease();
                  return;
                }
                const info = available.find((g) => String(g.index) === value);
                if (info) onSelect(info);
              }}
              className="min-w-0 flex-1 truncate rounded-md border border-border bg-zinc-800 px-2.5 py-2 text-sm text-white focus:border-orange-400/60 focus:outline-none [&>option]:bg-zinc-800 [&>option]:text-white"
            >
              <option value="">Connect a controller and press any button</option>
              {available.map((info) => (
                <option key={`${info.index}-${info.id}`} value={info.index}>
                  {info.label}
                </option>
              ))}
            </select>
          </div>
          <p className="px-1 pb-1 text-[11px] text-muted-foreground">
            {inputMode === "controller" ? statusText : "Select to use a physical controller."}
          </p>
        </div>

        <div
          tabIndex={0}
          onClick={onKeyboardTileClick}
          className={cn(
            "relative flex min-h-0 flex-1 cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border bg-card py-2 pr-2 pl-8 focus:border-orange-400/70 focus:outline-none focus:ring-2 focus:ring-orange-400/20",
            keyboardActive && keyboardCaptureActive ? "border-emerald-400/50" : "",
            keyboardActive && !keyboardCaptureActive ? "border-red-400/50" : "",
            !keyboardActive ? "border-border" : "",
          )}
        >
          <input
            type="radio"
            name="input-mode"
            checked={keyboardActive}
            onChange={onSelectKeyboardMode}
            aria-label="Keyboard input"
            className="absolute top-1/2 left-3 size-3 -translate-y-1/2 accent-orange-400"
          />
          <div className="flex items-center gap-2">
            <TileHeader label="Keyboard" Icon={Keyboard} />
            {keyboardActive ? (
              <span
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]",
                  TONE_PILL[keyboardFocusTone],
                )}
              >
                {keyboardCaptureActive ? "Keys active" : "Focus lost"}
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">Keyboard (Standard Xbox)</p>
              <p className="text-[11px] text-muted-foreground">
                Focus the Driver Station to drive. Leaving it clears input.
              </p>
            </div>
            <KeyboardMappingDialog />
          </div>
          <p className="px-1 pb-1 text-[11px] text-muted-foreground">
            {keyboardActive ? statusText : "Select to use keyboard keys as joystick port 0."}
          </p>
        </div>
      </div>
      <div className="flex min-h-0 w-1/2 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
        <div className="flex items-center justify-between gap-2">
          <TileHeader label="Live State" />
          <span
            className={cn(
              "shrink-0 rounded-md border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.12em]",
              TONE_PILL[statusTone],
            )}
          >
            {statusTone === "ok" ? (
              <span className="inline-flex items-center gap-1">
                <CircleDot className="size-3" />
                Live
              </span>
            ) : statusTone === "bad" ? (
              <span className="inline-flex items-center gap-1">
                <AlertTriangle className="size-3" />
                Error
              </span>
            ) : statusTone === "warn" ? (
              "Waiting"
            ) : (
              "Idle"
            )}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <GamepadVisualizer frame={visualizerFrame} active={visualizerActive} />
        </div>
      </div>
    </div>
  );
}

function isInteractiveTarget(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, input, textarea, select, [contenteditable='true']"));
}

function KeyboardMappingDialog() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
        <ListChecks className="size-3.5" />
        View mapping
      </DialogTrigger>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard Mapping</DialogTitle>
          <DialogDescription>
            Standard Xbox keyboard source for joystick port 0.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {BINDING_GROUPS.map((group) => (
            <div key={group} className="rounded-lg border border-border bg-white/[0.02] p-3">
              <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {group}
              </h4>
              <div className="grid gap-1.5">
                {KEYBOARD_BINDINGS.filter((binding) => binding.group === group).map((binding) => (
                  <div key={binding.code} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-muted-foreground">{binding.action}</span>
                    <kbd className="rounded-md border border-border bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {binding.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- SVG visualization ----------------

interface VisualizerProps {
  frame: GamepadFrame | null;
  active: boolean;
}

const STICK_TRAVEL = 14;

function GamepadVisualizer({ frame, active }: VisualizerProps) {
  const ax = (i: number) => clamp(frame?.axes[i] ?? 0, -1, 1);
  const bp = (i: number) => Boolean(frame?.buttons[i]?.pressed);
  const bv = (i: number) => clamp(frame?.buttons[i]?.value ?? 0, 0, 1);

  return (
    <svg
      viewBox="0 0 400 300"
      className={cn(
        "h-full w-full max-h-[300px] max-w-[440px] select-none transition-opacity",
        active ? "opacity-100" : "opacity-50",
      )}
      role="img"
      aria-label="Controller state visualizer"
    >
      {/* Body silhouette */}
      <path
        d="M 101 78
           C 78 78 61 92 51 118
           C 41 143 36 178 42 212
           C 49 254 70 271 101 270
           C 126 269 144 252 159 226
           C 171 230 186 233 200 233
           C 214 233 229 230 241 226
           C 256 252 274 269 299 270
           C 330 271 351 254 358 212
           C 364 178 359 143 349 118
           C 339 92 322 78 299 78
           C 274 76 247 84 226 97
           C 216 90 207 86 200 86
           C 193 86 184 90 174 97
           C 153 84 126 76 101 78
           Z"
        className="fill-white/[0.03] stroke-border"
        strokeWidth="1.5"
      />

      {/* Triggers */}
      <Trigger x={92} value={bv(6)} label="LT" />
      <Trigger x={274} value={bv(7)} label="RT" />

      {/* Bumpers */}
      <Bumper x={76} pressed={bp(4)} label="LB" />
      <Bumper x={264} pressed={bp(5)} label="RB" />

      {/* Back / Start */}
      <SmallButton cx={176} cy={118} pressed={bp(8)} label="Back" />
      <SmallButton cx={224} cy={118} pressed={bp(9)} label="Start" />

      {/* Left stick well + thumb */}
      <g>
        <circle cx={118} cy={139} r={28} className="fill-white/[0.04] stroke-border" strokeWidth="1.5" />
        <circle
          cx={118 + ax(0) * STICK_TRAVEL}
          cy={139 + ax(1) * STICK_TRAVEL}
          r={18}
          className={cn(
            "stroke-white/30",
            bp(10) ? "fill-orange-400/40" : "fill-white/15",
          )}
          strokeWidth="1.5"
        />
        <text x={118} y={187} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.16em]">L</text>
      </g>

      {/* D-pad */}
      <g transform="translate(154 180)">
        <DpadArm dx={0} dy={-14} pressed={bp(12)} />
        <DpadArm dx={0} dy={14} pressed={bp(13)} />
        <DpadArm dx={-14} dy={0} pressed={bp(14)} />
        <DpadArm dx={14} dy={0} pressed={bp(15)} />
        <rect x={-8} y={-8} width={16} height={16} rx={3} className="fill-white/10 stroke-white/15" strokeWidth="1" />
      </g>

      {/* Face buttons (ABXY) */}
      <g transform="translate(292 132)">
        <FaceButton cx={0} cy={-24} pressed={bp(3)} className="fill-amber-400/70 stroke-amber-200/60" label="Y" />
        <FaceButton cx={-26} cy={0} pressed={bp(2)} className="fill-sky-400/70 stroke-sky-200/60" label="X" />
        <FaceButton cx={26} cy={0} pressed={bp(1)} className="fill-red-400/70 stroke-red-200/60" label="B" />
        <FaceButton cx={0} cy={24} pressed={bp(0)} className="fill-emerald-400/70 stroke-emerald-200/60" label="A" />
        {/* Inactive shadow for unpressed buttons */}
        <UnpressedShadow cx={0} cy={-24} pressed={bp(3)} />
        <UnpressedShadow cx={-26} cy={0} pressed={bp(2)} />
        <UnpressedShadow cx={26} cy={0} pressed={bp(1)} />
        <UnpressedShadow cx={0} cy={24} pressed={bp(0)} />
        <text x={0} y={-21} textAnchor="middle" className="pointer-events-none fill-white/70 text-[8px] font-bold">Y</text>
        <text x={-26} y={3} textAnchor="middle" className="pointer-events-none fill-white/70 text-[8px] font-bold">X</text>
        <text x={26} y={3} textAnchor="middle" className="pointer-events-none fill-white/70 text-[8px] font-bold">B</text>
        <text x={0} y={27} textAnchor="middle" className="pointer-events-none fill-white/70 text-[8px] font-bold">A</text>
      </g>

      {/* Right stick */}
      <g>
        <circle cx={238} cy={179} r={28} className="fill-white/[0.04] stroke-border" strokeWidth="1.5" />
        <circle
          cx={238 + ax(2) * STICK_TRAVEL}
          cy={179 + ax(3) * STICK_TRAVEL}
          r={18}
          className={cn(
            "stroke-white/30",
            bp(11) ? "fill-orange-400/40" : "fill-white/15",
          )}
          strokeWidth="1.5"
        />
        <text x={238} y={227} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.16em]">R</text>
      </g>

      {/* Optional: tiny hint text when no controller selected */}
      {!active ? (
        <text x={200} y={37} textAnchor="middle" className="fill-muted-foreground text-[10px] uppercase tracking-[0.2em]">
          Awaiting controller
        </text>
      ) : null}
    </svg>
  );
}

function Trigger({ x, value, label }: { x: number; value: number; label: string }) {
  const fillHeight = 18 * value;
  return (
    <g>
      <rect x={x} y={42} width={32} height={18} rx={4} className="fill-white/[0.04] stroke-border" strokeWidth="1.5" />
      <rect x={x} y={42 + (18 - fillHeight)} width={32} height={fillHeight} rx={4} className="fill-emerald-400/60" />
      <text x={x + 16} y={36} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.18em]">
        {label}
      </text>
    </g>
  );
}

function Bumper({ x, pressed, label }: { x: number; pressed: boolean; label: string }) {
  return (
    <g>
      <rect
        x={x}
        y={66}
        width={50}
        height={10}
        rx={5}
        className={cn(pressed ? "fill-emerald-400/70 stroke-emerald-200/60" : "fill-white/[0.06] stroke-border")}
        strokeWidth="1.5"
      />
      <text x={x + 25} y={88} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.18em]">
        {label}
      </text>
    </g>
  );
}

function SmallButton({ cx, cy, pressed, label }: { cx: number; cy: number; pressed: boolean; label: string }) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r={6}
        className={cn(pressed ? "fill-emerald-400/70 stroke-emerald-200/60" : "fill-white/[0.06] stroke-border")}
        strokeWidth="1.2"
      />
      <text x={cx} y={cy + 18} textAnchor="middle" className="fill-muted-foreground text-[7.5px] uppercase tracking-[0.18em]">
        {label}
      </text>
    </g>
  );
}

function FaceButton({ cx, cy, pressed, className, label }: { cx: number; cy: number; pressed: boolean; className: string; label: string }) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={10}
      strokeWidth="1.5"
      aria-label={label}
      className={cn(
        pressed ? className : "fill-white/[0.05] stroke-border",
        pressed ? "drop-shadow-[0_0_6px_rgba(34,197,94,0.4)]" : "",
      )}
    />
  );
}

function UnpressedShadow({ cx, cy, pressed }: { cx: number; cy: number; pressed: boolean }) {
  if (pressed) return null;
  return <circle cx={cx} cy={cy} r={10} className="pointer-events-none fill-transparent stroke-white/10" strokeWidth="1" />;
}

function DpadArm({ dx, dy, pressed }: { dx: number; dy: number; pressed: boolean }) {
  const vertical = dx === 0;
  const w = vertical ? 16 : 22;
  const h = vertical ? 22 : 16;
  return (
    <rect
      x={dx - w / 2}
      y={dy - h / 2}
      width={w}
      height={h}
      rx={3}
      className={cn(pressed ? "fill-emerald-400/70 stroke-emerald-200/60" : "fill-white/10 stroke-white/20")}
      strokeWidth="1"
    />
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
