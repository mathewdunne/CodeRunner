import { ScrollArea } from "@/components/ui/scroll-area";

interface ConsolePaneProps {
  lines: string[];
}

export function ConsolePane({ lines }: ConsolePaneProps) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-t border-border bg-card">
      <header className="flex h-[38px] shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-bold text-muted-foreground">
        Console
      </header>
      <ScrollArea className="flex-1">
        <pre className="m-0 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {lines.join("\n")}
        </pre>
      </ScrollArea>
    </section>
  );
}
