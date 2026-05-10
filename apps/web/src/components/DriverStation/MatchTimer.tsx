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
    <div className="flex items-center gap-3">
      {/* Timer placeholder */}
      <div className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-muted-foreground">
        <span className="text-xs text-muted-foreground/60">⏱</span>
        <span>000</span>
      </div>

      {/* Alliance selector */}
      <select
        value={alliance}
        onChange={(e) => onSetAlliance(e.target.value as AllianceStation)}
        className="h-7 rounded-md border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      >
        {STATIONS.map((s) => (
          <option key={s} value={s}>
            {STATION_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}
