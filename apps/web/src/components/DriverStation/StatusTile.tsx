import type { ComponentType } from "react";
import { Bot, Gamepad2, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunConnection } from "@/hooks/useRunChannel";
import type { BridgeConnection, SimRunStatus, SimStatusResponse } from "@/lib/contracts";
import type { InputMode } from "@/state/store";

type JoystickStatus = SimStatusResponse["joysticks"]["status"];

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
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 px-2 py-1.5">
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

interface StatusTileRowProps {
  halConnection: BridgeConnection;
  runConnection: RunConnection;
  runStatus: SimRunStatus;
  joystickStatus: JoystickStatus;
  inputMode: InputMode;
  keyboardCaptureActive: boolean;
}

function joystickToneFromStatus(
  status: JoystickStatus,
  inputMode: InputMode,
  keyboardCaptureActive: boolean,
): StatusTone {
  if (inputMode === "keyboard") {
    return keyboardCaptureActive ? "ok" : "warn";
  }
  if (status === "connected") return "ok";
  return "warn";
}

function commsToneFromConnections(
  halConnection: BridgeConnection,
  runConnection: RunConnection,
): StatusTone {
  if (halConnection === "connected" && runConnection === "connected") return "ok";
  if (halConnection === "reconnecting" || runConnection === "reconnecting") return "warn";
  return "bad";
}

function robotToneFromRunStatus(runStatus: SimRunStatus): StatusTone {
  if (runStatus === "running") return "ok";
  if (runStatus === "building" || runStatus === "stopping") return "warn";
  return "bad";
}

export function StatusTileRow({
  halConnection,
  runConnection,
  runStatus,
  joystickStatus,
  inputMode,
  keyboardCaptureActive,
}: StatusTileRowProps) {
  const commsTone = commsToneFromConnections(halConnection, runConnection);
  const robotTone = robotToneFromRunStatus(runStatus);
  const joystickTone = joystickToneFromStatus(joystickStatus, inputMode, keyboardCaptureActive);

  return (
    <div className="grid h-full min-h-0 grid-cols-3 gap-1.5 overflow-hidden rounded-lg border border-border bg-card p-1.5">
      <StatusTile tone={commsTone} label="Comms" Icon={Wifi} />
      <StatusTile tone={robotTone} label="Robot Code" Icon={Bot} />
      <StatusTile tone={joystickTone} label="Joysticks" Icon={Gamepad2} />
    </div>
  );
}
