import { Gamepad2 } from "lucide-react";

export function JoystickPanel() {
  return (
    <div className="hidden h-8 items-center gap-2 rounded-md border border-border bg-muted/30 px-2 text-xs text-muted-foreground lg:flex">
      <Gamepad2 className="size-3.5" />
      <span className="whitespace-nowrap">No controller</span>
    </div>
  );
}
