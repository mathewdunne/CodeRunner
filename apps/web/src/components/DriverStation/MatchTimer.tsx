import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Clock3 } from "lucide-react";
import type { AllianceStation } from "@/hooks/useHalSim";

interface MatchTimerProps {
  alliance: AllianceStation;
  onSetAlliance: (station: AllianceStation) => void;
}

const STATIONS: AllianceStation[] = ["red1", "red2", "red3", "blue1", "blue2", "blue3"];

const STATION_LABELS: Record<AllianceStation, string> = {
  red1: "Red 1",
  red2: "Red 2",
  red3: "Red 3",
  blue1: "Blue 1",
  blue2: "Blue 2",
  blue3: "Blue 3",
};

export function MatchTimer({ alliance, onSetAlliance }: MatchTimerProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 font-mono text-sm tabular-nums text-muted-foreground">
        <Clock3 className="size-3.5 text-muted-foreground/70" />
        <span>00:00</span>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-[86px] justify-between rounded-md px-2 text-xs"
            >
              {STATION_LABELS[alliance]}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-32">
          <DropdownMenuRadioGroup
            value={alliance}
            onValueChange={(value) => onSetAlliance(value as AllianceStation)}
          >
            {STATIONS.map((station) => (
              <DropdownMenuRadioItem
                key={station}
                value={station}
                closeOnClick
              >
                {STATION_LABELS[station]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
