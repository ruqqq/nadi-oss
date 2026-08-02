import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { recoverFromStaleBundle } from "@/lib/stale-bundle";

/**
 * Shown when a chunk of the running build has gone missing — i.e. the app was
 * deployed under this tab. Recovery (a worker update, then a reload) is already
 * running when this renders; the copy names it, and the button is there for the
 * case where recovery is capped by the once-a-minute loop guard, which is why it
 * forces.
 *
 * Used both full-screen (RootErrorBoundary) and inside the thread pane
 * (ThreadHistoryErrorBoundary, where the header carries the escape control).
 */
export function StaleBundleNotice({ header }: { header?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-display text-lg">Nadi was updated</p>
        <p className="max-w-sm text-muted-foreground text-sm">
          This tab is running an older version. Reloading to pick up the latest one.
        </p>
        <Button variant="outline" onClick={() => void recoverFromStaleBundle({ force: true })}>
          Reload now
        </Button>
      </div>
    </div>
  );
}
