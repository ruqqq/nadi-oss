import { useEffect, useState } from "react";
import type { ActiveWatcher } from "@/lib/watcher-runs";
import { Eye } from "@/icons";
import { WatcherChip } from "./WatcherChip";

/**
 * A slim strip pinned above the composer that surfaces the thread's active
 * exec_watch watchers — a persistent signal that Nadi is waiting on background
 * processes. Renders nothing when there are none, so it costs no space at rest.
 */
export function WatcherDock({ enabled, watchers }: { enabled: boolean; watchers: ActiveWatcher[] }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || watchers.length === 0) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled, watchers.length]);

  if (!enabled || watchers.length === 0) return null;

  return (
    <div className="border-t bg-background/95 px-3 pt-2.5 pb-2 backdrop-blur">
      <div className="mb-2 flex items-center gap-1.5">
        <Eye className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground text-xs">Watching</span>
        <span className="text-muted-foreground text-xs">
          · {watchers.length} {watchers.length === 1 ? "process" : "processes"}
        </span>
      </div>
      <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5">
        {watchers.map((watcher) => (
          <WatcherChip key={watcher.processId} watcher={watcher} nowMs={nowMs} />
        ))}
      </div>
    </div>
  );
}
