import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect, useRef } from "react";

interface ConsolePanelProps {
  lines: string[];
}

export function ConsolePanel({ lines }: ConsolePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center border-b border-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Console
        </span>
      </div>
      <ScrollArea className="flex-1">
        <pre className="m-0 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {lines.join("\n")}
          <div ref={bottomRef} />
        </pre>
      </ScrollArea>
    </div>
  );
}
