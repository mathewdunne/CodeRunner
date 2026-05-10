import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { ReactNode } from "react";

interface IDELayoutProps {
  editor: ReactNode;
  scope: ReactNode;
  driverStation: ReactNode;
}

export function IDELayout({ editor, scope, driverStation }: IDELayoutProps) {
  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1 overflow-hidden"
    >
      <ResizablePanel defaultSize={75} minSize={20} className="min-h-0">
        <ResizablePanelGroup orientation="horizontal" className="min-h-0">
          <ResizablePanel defaultSize={50} minSize={25} data-pane="editor" className="min-h-0">
            <div className="h-full min-h-0 min-w-0 bg-card">
              {editor}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle data-pane="scope-handle" />
          <ResizablePanel
            defaultSize={50}
            minSize={25}
            className="hidden min-h-0 min-[901px]:block"
            data-pane="scope"
          >
            {scope}
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={25} minSize={5} data-pane="console" className="min-h-0 overflow-hidden">
        {driverStation}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
