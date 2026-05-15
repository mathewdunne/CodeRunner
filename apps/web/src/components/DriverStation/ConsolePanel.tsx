import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CodeStatusPill, type CodeStatus } from "./CodeStatusPill";
import type { SimRunStatus } from "@/lib/contracts";

interface ConsolePanelProps {
  robotLines: string[];
  runStatus: SimRunStatus;
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
  emptyText,
  lines,
}: {
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
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToBottom, visibleLines]);

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

function codeStatusFromRun(runStatus: SimRunStatus): CodeStatus {
  if (runStatus === "building") return "building";
  if (runStatus === "running") return "running";
  return "idle";
}

export function ConsolePanel({ robotLines, runStatus }: ConsolePanelProps) {
  const codeStatus = codeStatusFromRun(runStatus);

  return (
    <section data-testid="run-console" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-card/40 px-3">
        <div className="flex items-center gap-2 text-[12px]">
          <Terminal className="size-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">Console Output</span>
        </div>
        <div className="flex items-center gap-3">
          <CodeStatusPill status={codeStatus} />
          <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">
            {robotLines.length} lines
          </span>
        </div>
      </div>
      <ConsoleViewport emptyText="No robot output yet." lines={robotLines} />
    </section>
  );
}
