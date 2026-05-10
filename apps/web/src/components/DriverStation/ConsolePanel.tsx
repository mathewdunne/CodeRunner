import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ClipboardList, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type ConsoleTab = "robot" | "ds";

interface ConsolePanelProps {
  robotLines: string[];
  dsLines: string[];
}

const PINNED_THRESHOLD_PX = 32;

function isNearBottom(viewport: HTMLDivElement) {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    PINNED_THRESHOLD_PX
  );
}

function parseConsoleLine(line: string) {
  const match = line.match(/^\[([^\]]+)\]\s?(.*)$/);
  if (!match) {
    return { tag: null, text: line };
  }
  return { tag: match[1], text: match[2] || "" };
}

const TAG_CLASSES: Record<string, string> = {
  stdout: "border-emerald-500/25 text-emerald-300",
  stderr: "border-red-500/30 text-red-300",
  sim: "border-blue-500/25 text-blue-300",
};

function ConsoleLine({ line }: { line: string }) {
  const { tag, text } = parseConsoleLine(line);

  return (
    <div className="flex min-w-0 gap-2 border-b border-border/30 px-3 py-1.5 last:border-b-0">
      {tag ? (
        <span
          className={cn(
            "mt-0.5 h-5 min-w-12 rounded border px-1.5 text-center text-[10px] font-semibold uppercase leading-5",
            TAG_CLASSES[tag] ?? "border-border text-muted-foreground",
          )}
        >
          {tag}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground">
        {text}
      </span>
    </div>
  );
}

function ConsoleViewport({
  active,
  emptyText,
  lines,
}: {
  active: boolean;
  emptyText: string;
  lines: string[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const visibleLines = useMemo(
    () => (lines.length > 0 ? lines : [emptyText]),
    [emptyText, lines],
  );

  const setPinned = useCallback((value: boolean) => {
    autoScrollRef.current = value;
    setAutoScroll(value);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setPinned(isNearBottom(viewport));
  }, [setPinned]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!active || !autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(frame);
  }, [active, scrollToBottom, visibleLines]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <ScrollArea
        className="min-h-0 flex-1"
        viewportClassName="overscroll-contain"
        viewportRef={viewportRef}
      >
        <div className="min-h-full bg-background/45 py-1">
          {visibleLines.map((line, index) => (
            <ConsoleLine key={`${index}-${line}`} line={line} />
          ))}
        </div>
      </ScrollArea>

      {!autoScroll ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            setPinned(true);
            window.requestAnimationFrame(() => scrollToBottom("smooth"));
          }}
          className="absolute right-4 bottom-3 h-7 gap-1.5 rounded-md shadow-md"
        >
          <ArrowDownToLine className="size-3.5" />
          Bottom
        </Button>
      ) : null}
    </div>
  );
}

export function ConsolePanel({ robotLines, dsLines }: ConsolePanelProps) {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("robot");

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as ConsoleTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-background/20 px-3">
        <TabsList className="h-7 rounded-md bg-muted/60">
          <TabsTrigger value="robot" className="min-w-[128px] gap-1.5 text-xs">
            <Terminal className="size-3.5" />
            Robot Console
          </TabsTrigger>
          <TabsTrigger value="ds" className="min-w-[92px] gap-1.5 text-xs">
            <ClipboardList className="size-3.5" />
            DS Log
          </TabsTrigger>
        </TabsList>

        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {activeTab === "robot" ? robotLines.length : dsLines.length} lines
        </span>
      </div>

      <TabsContent
        value="robot"
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <ConsoleViewport
          active={activeTab === "robot"}
          emptyText="No robot output yet."
          lines={robotLines}
        />
      </TabsContent>
      <TabsContent
        value="ds"
        className="relative flex min-h-0 flex-1 overflow-hidden"
      >
        <ConsoleViewport
          active={activeTab === "ds"}
          emptyText="No driver station events yet."
          lines={dsLines}
        />
      </TabsContent>
    </Tabs>
  );
}
