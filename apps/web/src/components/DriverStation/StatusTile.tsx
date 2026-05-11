import type { ComponentType } from "react";
import { Bot, Gamepad2, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "bad";

const TONE_CLASSES: Record<
  StatusTone,
  { tile: string; icon: string; label: string }
> = {
  ok: {
    tile: "bg-emerald-500/15 ring-emerald-500/20 shadow-[0_0_12px_rgba(34,197,94,0.35)]",
    icon: "text-emerald-300",
    label: "text-emerald-200",
  },
  warn: {
    tile: "bg-amber-500/15 ring-amber-500/20 shadow-[0_0_12px_rgba(245,158,11,0.35)]",
    icon: "text-amber-300",
    label: "text-amber-200",
  },
  bad: {
    tile: "bg-red-500/15 ring-red-500/20 shadow-[0_0_12px_rgba(239,68,68,0.35)]",
    icon: "text-red-300",
    label: "text-red-200",
  },
};

interface StatusTileProps {
  tone: StatusTone;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}

export function StatusTile({ tone, label, Icon }: StatusTileProps) {
  const t = TONE_CLASSES[tone];
  return (
    <div className="flex min-h-0 flex-col items-center justify-center gap-2 px-2 py-3">
      <div
        className={cn(
          "flex size-12 items-center justify-center rounded-md ring-1",
          t.tile,
        )}
      >
        <Icon className={cn("size-5", t.icon)} />
      </div>
      <span
        className={cn(
          "text-[10.5px] font-semibold uppercase tracking-[0.12em]",
          t.label,
        )}
      >
        {label}
      </span>
    </div>
  );
}

export function StatusTileRow() {
  // TODO: drive Comms tile from halSim.connection + runConnection.
  // TODO: drive Robot Code tile from runStatus (running → ok, building → warn,
  //       error/idle → bad).
  // TODO: drive Joysticks tile when a joystick presence API exists.
  const commsTone: StatusTone = "ok";
  const robotTone: StatusTone = "ok";
  const joystickTone: StatusTone = "warn";

  return (
    <div className="grid min-h-0 grid-cols-3 gap-2 rounded-lg border border-border bg-card p-2">
      <StatusTile tone={commsTone} label="Comms" Icon={Wifi} />
      <StatusTile tone={robotTone} label="Robot Code" Icon={Bot} />
      <StatusTile tone={joystickTone} label="Joysticks" Icon={Gamepad2} />
    </div>
  );
}
