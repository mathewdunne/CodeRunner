import { useMemo } from "react";
import { Gamepad2, AlertTriangle, CircleDot } from "lucide-react";
import type { GamepadFrame, GamepadInfo } from "@/hooks/useGamepad";
import type { GamepadChannelConnection } from "@/hooks/useGamepadChannel";
import type { SimRunStatus, SimStatusResponse } from "@/lib/contracts";
import { cn } from "@/lib/utils";

interface ControlsPanelProps {
  available: GamepadInfo[];
  selectedIndex: number | null;
  frame: GamepadFrame | null;
  runStatus: SimRunStatus;
  simulationStatus: SimStatusResponse | null;
  channelConnection: GamepadChannelConnection;
  channelHalsimDisconnected: boolean;
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

function TileHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      <Gamepad2 className="size-3.5" />
      {label}
    </div>
  );
}

export function ControlsPanel({
  available,
  selectedIndex,
  frame,
  runStatus,
  simulationStatus,
  channelConnection,
  channelHalsimDisconnected,
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
  }, [channelConnection, selected, runStatus, channelHalsimDisconnected, simulationStatus, available.length]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden gap-2.5 border-r border-border p-3">
      <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
        <TileHeader label="Controller" />
        <div className="flex items-center gap-2 px-1">
          <select
            value={selectedIndex ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "") {
                onRelease();
                return;
              }
              const info = available.find((g) => String(g.index) === value);
              if (info) onSelect(info);
            }}
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-white/[0.02] px-2.5 py-2 text-sm text-foreground focus:border-orange-400/60 focus:outline-none"
          >
            <option value="">None — gamepad disabled</option>
            {available.map((info) => (
              <option key={`${info.index}-${info.id}`} value={info.index}>
                {info.label}
              </option>
            ))}
          </select>
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
        <p className="px-1 pb-1 text-[11px] text-muted-foreground">{statusText}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2">
        <TileHeader label="Live State" />
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <GamepadVisualizer frame={frame} active={selected !== null} />
        </div>
      </div>
    </div>
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
      viewBox="0 0 360 220"
      className={cn(
        "h-full w-full max-h-[260px] max-w-[440px] select-none transition-opacity",
        active ? "opacity-100" : "opacity-50",
      )}
      role="img"
      aria-label="Controller state visualizer"
    >
      {/* Body silhouette */}
      <path
        d="M 60 80
           Q 30 80 30 130
           Q 30 200 80 200
           Q 110 200 130 180
           L 230 180
           Q 250 200 280 200
           Q 330 200 330 130
           Q 330 80 300 80
           Z"
        className="fill-white/[0.03] stroke-border"
        strokeWidth="1.5"
      />

      {/* Triggers */}
      <Trigger x={70} value={bv(6)} label="LT" />
      <Trigger x={258} value={bv(7)} label="RT" />

      {/* Bumpers */}
      <Bumper x={60} pressed={bp(4)} label="LB" />
      <Bumper x={250} pressed={bp(5)} label="RB" />

      {/* Back / Start */}
      <SmallButton cx={160} cy={108} pressed={bp(8)} label="Back" />
      <SmallButton cx={200} cy={108} pressed={bp(9)} label="Start" />

      {/* Left stick well + thumb */}
      <g>
        <circle cx={100} cy={120} r={24} className="fill-white/[0.04] stroke-border" strokeWidth="1.5" />
        <circle
          cx={100 + ax(0) * STICK_TRAVEL}
          cy={120 + ax(1) * STICK_TRAVEL}
          r={16}
          className={cn(
            "stroke-white/30",
            bp(10) ? "fill-orange-400/40" : "fill-white/15",
          )}
          strokeWidth="1.5"
        />
        <text x={100} y={163} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.16em]">L</text>
      </g>

      {/* D-pad */}
      <g transform="translate(160 170)">
        <DpadArm dx={0} dy={-12} pressed={bp(12)} />
        <DpadArm dx={0} dy={12} pressed={bp(13)} />
        <DpadArm dx={-12} dy={0} pressed={bp(14)} />
        <DpadArm dx={12} dy={0} pressed={bp(15)} />
        <rect x={-6} y={-6} width={12} height={12} rx={2} className="fill-white/10 stroke-white/15" strokeWidth="1" />
      </g>

      {/* Face buttons (ABXY) */}
      <g transform="translate(255 120)">
        <FaceButton cx={0} cy={-20} pressed={bp(3)} className="fill-amber-400/70 stroke-amber-200/60" label="Y" />
        <FaceButton cx={-22} cy={0} pressed={bp(2)} className="fill-sky-400/70 stroke-sky-200/60" label="X" />
        <FaceButton cx={22} cy={0} pressed={bp(1)} className="fill-red-400/70 stroke-red-200/60" label="B" />
        <FaceButton cx={0} cy={20} pressed={bp(0)} className="fill-emerald-400/70 stroke-emerald-200/60" label="A" />
        {/* Inactive shadow for unpressed buttons */}
        <UnpressedShadow cx={0} cy={-20} pressed={bp(3)} />
        <UnpressedShadow cx={-22} cy={0} pressed={bp(2)} />
        <UnpressedShadow cx={22} cy={0} pressed={bp(1)} />
        <UnpressedShadow cx={0} cy={20} pressed={bp(0)} />
        <text x={0} y={-17} textAnchor="middle" className="pointer-events-none fill-black/60 text-[8px] font-bold">Y</text>
        <text x={-22} y={3} textAnchor="middle" className="pointer-events-none fill-black/60 text-[8px] font-bold">X</text>
        <text x={22} y={3} textAnchor="middle" className="pointer-events-none fill-black/60 text-[8px] font-bold">B</text>
        <text x={0} y={23} textAnchor="middle" className="pointer-events-none fill-black/60 text-[8px] font-bold">A</text>
      </g>

      {/* Right stick */}
      <g>
        <circle cx={205} cy={148} r={24} className="fill-white/[0.04] stroke-border" strokeWidth="1.5" />
        <circle
          cx={205 + ax(2) * STICK_TRAVEL}
          cy={148 + ax(3) * STICK_TRAVEL}
          r={16}
          className={cn(
            "stroke-white/30",
            bp(11) ? "fill-orange-400/40" : "fill-white/15",
          )}
          strokeWidth="1.5"
        />
        <text x={205} y={191} textAnchor="middle" className="fill-muted-foreground text-[8px] uppercase tracking-[0.16em]">R</text>
      </g>

      {/* Optional: tiny hint text when no controller selected */}
      {!active ? (
        <text x={180} y={42} textAnchor="middle" className="fill-muted-foreground text-[10px] uppercase tracking-[0.2em]">
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
  const w = dx === 0 ? 12 : 12;
  const h = dy === 0 ? 12 : 12;
  return (
    <rect
      x={dx - w / 2}
      y={dy - h / 2}
      width={w}
      height={h}
      rx={2}
      className={cn(pressed ? "fill-emerald-400/70 stroke-emerald-200/60" : "fill-white/10 stroke-white/20")}
      strokeWidth="1"
    />
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
