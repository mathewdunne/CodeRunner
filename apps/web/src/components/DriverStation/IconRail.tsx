import type { ComponentType } from "react";
import { Gamepad2, Terminal } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type RailTab = "console" | "controls";

interface IconRailProps {
  active: RailTab;
  onSelect: (tab: RailTab) => void;
}

interface IconRailButtonProps {
  Icon: ComponentType<{ className?: string }>;
  active?: boolean;
  disabled?: boolean;
  title: string;
  toneActive?: "red" | "neutral";
  onClick?: () => void;
}

function IconRailButton({
  Icon,
  active,
  disabled,
  title,
  toneActive = "neutral",
  onClick,
}: IconRailButtonProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
        active
          ? toneActive === "red"
            ? "border-l-2 border-l-red-400 bg-red-500/15 text-red-300"
            : "border-l-2 border-l-foreground bg-white/[0.05] text-foreground"
          : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right">
        {disabled ? `${title} (coming soon)` : title}
      </TooltipContent>
    </Tooltip>
  );
}

export function IconRail({ active, onSelect }: IconRailProps) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card/30 py-2">
      <IconRailButton
        Icon={Terminal}
        active={active === "console"}
        toneActive="red"
        title="Console"
        onClick={() => onSelect("console")}
      />
      {/* TODO: implement Controls / joysticks tab — disabled until the
          joystick UI lands. */}
      <IconRailButton
        Icon={Gamepad2}
        disabled
        title="Controls"
      />
    </div>
  );
}
