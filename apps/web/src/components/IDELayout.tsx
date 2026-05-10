import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { ReactNode } from "react";

interface IDELayoutProps {
  editor: ReactNode;
  scope: ReactNode;
  console: ReactNode;
}

export function IDELayout({ editor, scope, console: consolePart }: IDELayoutProps) {
  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="flex-1"
    >
      <ResizablePanel defaultSize={75} minSize={20}>
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel defaultSize={66} minSize={25}>
            <div className="h-full min-h-0 min-w-0 bg-card">
              {editor}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            defaultSize={34}
            minSize={15}
            className="hidden md:block"
          >
            {scope}
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={25} minSize={5}>
        {consolePart}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
