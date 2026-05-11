import { Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/hooks/useRunChannel";

interface SimControlsBlockProps {
  runStatus: RunStatus;
  sessionReady: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}

interface SimButtonProps {
  label: string;
  Icon: typeof Play;
  onClick: () => void;
  disabled: boolean;
  tone: "start" | "stop" | "restart";
}

const TONE_CLASSES: Record<SimButtonProps["tone"], string> = {
  start: "text-emerald-300 [&_svg]:text-emerald-400",
  stop: "text-red-300 [&_svg]:text-red-400",
  restart: "text-muted-foreground [&_svg]:text-muted-foreground",
};

function SimButton({ label, Icon, onClick, disabled, tone }: SimButtonProps) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      variant="outline"
      className={cn(
        "flex h-full min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-md border-border bg-card/40 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors hover:bg-white/[0.05] disabled:opacity-40",
        TONE_CLASSES[tone],
      )}
    >
      <Icon className="size-4" />
      {label}
    </Button>
  );
}

export function SimControlsBlock({
  runStatus,
  sessionReady,
  onStart,
  onStop,
  onRestart,
}: SimControlsBlockProps) {
  const runBusy = ["building", "running", "stopping"].includes(runStatus);
  const canRestart = runStatus === "running";

  return (
    <div className="flex min-h-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-2">
      <span className="px-1 pt-0.5 text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Sim Controls
      </span>
      <div className="flex min-h-0 flex-1 items-stretch gap-1.5">
        <SimButton
          label="Start"
          Icon={Play}
          onClick={onStart}
          disabled={runBusy || !sessionReady}
          tone="start"
        />
        <SimButton
          label="Stop"
          Icon={Square}
          onClick={onStop}
          disabled={!runBusy}
          tone="stop"
        />
        <SimButton
          label="Restart"
          Icon={RotateCcw}
          onClick={onRestart}
          disabled={!canRestart || !sessionReady}
          tone="restart"
        />
      </div>
    </div>
  );
}
