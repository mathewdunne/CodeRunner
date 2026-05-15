import { forwardRef, useCallback, useState } from "react";
import { Loader2 } from "lucide-react";

export const ScopePane = forwardRef<HTMLIFrameElement>(
  function ScopePane(_props, ref) {
    const [iframeLoaded, setIframeLoaded] = useState(false);
    const handleLoad = useCallback(() => setIframeLoaded(true), []);

    return (
      <aside className="relative flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card">
        <iframe
          ref={ref}
          title="AdvantageScope Lite"
          data-pane="scope"
          src="/scope/?frcEndpoint=postMessage"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          onLoad={handleLoad}
        />
        {!iframeLoaded && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <span className="font-mono text-sm text-muted-foreground">
              Loading AdvantageScope…
            </span>
          </div>
        )}
      </aside>
    );
  },
);
