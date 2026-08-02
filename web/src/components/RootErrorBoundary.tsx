import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StaleBundleNotice } from "@/components/StaleBundleNotice";
import { isChunkLoadError, recoverFromStaleBundle } from "@/lib/stale-bundle";

/**
 * The app's last error boundary. Without one, a lazily-loaded chunk that has
 * gone missing (the app was deployed under this tab) rejects past every
 * Suspense boundary and white-screens the whole app.
 *
 * A chunk failure is recoverable — update the worker, reload onto the new build
 * — so it does that and says so. Anything else is a real bug: it gets a plain
 * fallback with a manual reload, deliberately NOT an automatic one, which would
 * turn a render crash into a reload loop.
 */
export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { failure: "none" | "stale" | "crashed" }
> {
  state: { failure: "none" | "stale" | "crashed" } = { failure: "none" };

  static getDerivedStateFromError(error: unknown) {
    return { failure: isChunkLoadError(error) ? ("stale" as const) : ("crashed" as const) };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) void recoverFromStaleBundle();
  }

  render() {
    if (this.state.failure === "stale") return <StaleBundleNotice />;
    if (this.state.failure === "crashed") {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="font-display text-lg">Something went wrong</p>
          <p className="max-w-sm text-muted-foreground text-sm">
            Nadi hit an unexpected error and couldn't keep going. Reloading usually clears it.
          </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
